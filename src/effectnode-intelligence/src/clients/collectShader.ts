import type { Camera, Material, Object3D, Scene } from 'three'
import type { IntelligenceGL } from './glTypes'
import { serializeValue } from './serialize'

/**
 * Shader & material introspection for /api/query/shader — idea.md §4.
 *
 * ## Where the source comes from
 *
 * Two sources, in preference order:
 *
 * 1. **Captured.** `renderer.debug.onNodeBuilderCreated` fires once per node
 *    builder — i.e. once per material variant actually used, including the
 *    shadow and MRT pipeline variants. Reading that render object later yields
 *    the real compiled source with no extra work. This is also the only route
 *    to live uniform *values* (§4.2), which live on the builder.
 * 2. **Compiled on demand.** `renderer.debug.getShaderAsync` for an object that
 *    has not been rendered yet. It compiles, so it is slower — and it must be
 *    serialised, because two concurrent calls race on the renderer's shared
 *    `_isPreCompiling` flag and can build duplicate GPU pipelines.
 *
 * ## Renderer-specific caveats (see the skill doc)
 *
 * - The renderer is a `WebGPURenderer`, so the compiled source is **WGSL**, not
 *   GLSL. WGSL has no preprocessor, so `#define` extraction is meaningful only
 *   on the WebGL fallback backend.
 * - `NodeMaterial` (all `*NodeMaterial` types) has **no `.uniforms` table** —
 *   TSL uniforms are node graph members. Their values come from the captured
 *   builder instead, which is why the capture hook matters.
 */

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

type NodeBuilderLike = {
    uniforms?: { vertex?: UniformLike[]; fragment?: UniformLike[]; compute?: UniformLike[] }
}

type UniformLike = {
    name?: string
    type?: string
    /** proxies the underlying node's value on read */
    value?: unknown
}

type RenderObjectLike = {
    object?: Object3D
    material?: Material
    getNodeBuilderState?: () => {
        vertexShader?: string | null
        fragmentShader?: string | null
        computeShader?: string | null
    }
}

type Capture = {
    objectUuid: string
    materialUuid: string
    nodeBuilder: NodeBuilderLike
    renderObject: RenderObjectLike
    at: number
}

/** Bounded so a scene with churning materials cannot grow this without limit. */
const MAX_CAPTURES = 500

const capturesByObject = new Map<string, Capture>()
const capturesByMaterial = new Map<string, Capture>()

let uninstall: (() => void) | null = null

function remember(capture: Capture) {
    capturesByObject.set(capture.objectUuid, capture)
    capturesByMaterial.set(capture.materialUuid, capture)
    if (capturesByObject.size > MAX_CAPTURES) {
        // Map preserves insertion order, so the first key is the oldest.
        for (const [key] of capturesByObject) {
            capturesByObject.delete(key)
            if (capturesByObject.size <= MAX_CAPTURES) {
                break
            }
        }
    }
}

/**
 * Start capturing node builders. Returns a disposer that restores whatever hook
 * was installed before — call it on unmount, or an HMR reload leaves a stale
 * closure capturing into a dead module instance.
 */
export function installShaderCapture(gl: IntelligenceGL): () => void {
    const debug = gl.debug
    if (!debug) {
        return () => {}
    }

    const previous = debug.onNodeBuilderCreated ?? null
    const handler = (nodeBuilder: unknown, renderObject: unknown) => {
        // Preserve anyone else's hook rather than silently replacing it.
        if (typeof previous === 'function') {
            try {
                previous(nodeBuilder, renderObject)
            } catch {
                // a broken third-party hook must not break capture
            }
        }
        const render = renderObject as RenderObjectLike
        const object = render?.object
        const material = render?.material
        if (!object || !material) {
            return
        }
        remember({
            objectUuid: object.uuid,
            materialUuid: material.uuid,
            nodeBuilder: (nodeBuilder ?? {}) as NodeBuilderLike,
            renderObject: render,
            at: performance.now(),
        })
    }

    debug.onNodeBuilderCreated = handler
    const restore = () => {
        if (debug.onNodeBuilderCreated === handler) {
            debug.onNodeBuilderCreated = previous
        }
    }
    uninstall = restore
    return () => {
        restore()
        if (uninstall === restore) {
            uninstall = null
        }
    }
}

// ---------------------------------------------------------------------------
// On-demand compile, serialised
// ---------------------------------------------------------------------------

/**
 * `getShaderAsync` mutates renderer-wide state (`_isPreCompiling`, the shared
 * render list) across awaits. Two overlapping calls would fight over it — and
 * can build a duplicate pipeline, which this tool would then report as a leak
 * it caused itself. So run them one at a time.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task)
    queue = run.then(
        () => undefined,
        () => undefined,
    )
    return run
}

// ---------------------------------------------------------------------------
// Value / source helpers
// ---------------------------------------------------------------------------

function firstMaterialOf(object: Object3D): Material | null {
    const material = (object as { material?: Material | Material[] | null }).material
    if (!material) {
        return null
    }
    return Array.isArray(material) ? (material.find(Boolean) ?? null) : material
}

function isWgsl(text: string): boolean {
    return text.includes('@vertex') || text.includes('@fragment') || text.includes('var<')
}

function isGlsl(text: string): boolean {
    return text.includes('#version') || text.includes('gl_Position') || text.includes('gl_FragColor')
}

function detectLanguage(sources: (string | null | undefined)[]): 'wgsl' | 'glsl' | 'unknown' {
    const joined = sources.filter(Boolean).join('\n')
    if (!joined) {
        return 'unknown'
    }
    if (isWgsl(joined)) {
        return 'wgsl'
    }
    if (isGlsl(joined)) {
        return 'glsl'
    }
    return 'unknown'
}

/** `#define` lines from compiled source. WGSL has no preprocessor, so expect none there. */
function extractDefines(source: string | null | undefined): string[] {
    if (!source) {
        return []
    }
    const out: string[] = []
    for (const line of source.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.startsWith('#define')) {
            out.push(trimmed)
            if (out.length >= 200) {
                break
            }
        }
    }
    return out
}

/**
 * The material's populated feature slots — the TSL equivalent of a GLSL
 * `#define`. Under WebGPU/TSL there is no preprocessor, so "which features are
 * switched on" is expressed by which slots are wired, not by defines.
 */
function activeSlots(material: Material): { slot: string; kind: 'texture' | 'node' | 'flag' }[] {
    const out: { slot: string; kind: 'texture' | 'node' | 'flag' }[] = []
    for (const key of Object.keys(material)) {
        if (key.startsWith('_')) {
            continue
        }
        const value = (material as unknown as Record<string, unknown>)[key]
        if (value === null || value === undefined) {
            continue
        }
        if (typeof value === 'boolean') {
            // Only interesting when on — `flatShading: false` is not a feature.
            if (value) {
                out.push({ slot: key, kind: 'flag' })
            }
            continue
        }
        if (typeof value === 'object') {
            const node = value as { isTexture?: boolean; isNode?: boolean }
            if (node.isTexture) {
                out.push({ slot: key, kind: 'texture' })
            } else if (node.isNode) {
                out.push({ slot: key, kind: 'node' })
            }
        }
    }
    return out
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export type ShaderUniform = {
    name: string
    type: string
    value: unknown
}

export type ShaderReport = {
    object: { uuid: string; name: string; type: string }
    material: { uuid: string; name: string; type: string } | null
    language: 'wgsl' | 'glsl' | 'unknown'
    /** which route produced the source */
    source: 'captured' | 'compiled-on-demand' | 'unavailable'
    vertexShader: string | null
    fragmentShader: string | null
    /** true when either source string was clipped to `maxChars` */
    truncated: boolean
    /** §4.2 */
    uniforms: {
        /** where the values came from */
        from: 'node-builder' | 'material.uniforms' | 'none'
        entries: ShaderUniform[]
    }
    /** §4.3 */
    features: {
        /** `#define` lines found in the source — GLSL backend only */
        defines: string[]
        /** `material.defines`, for a ShaderMaterial */
        materialDefines: Record<string, unknown> | null
        /** populated feature slots — the TSL analogue of a define */
        activeSlots: { slot: string; kind: 'texture' | 'node' | 'flag' }[]
    }
    /** what to do when something is missing */
    notes: string[]
    /** non-fatal problems encountered while collecting */
    warnings: string[]
}

function collectUniforms(
    capture: Capture | undefined,
    material: Material | null,
): ShaderReport['uniforms'] {
    // Prefer the captured builder: it holds live values for TSL materials,
    // which have no `.uniforms` at all.
    const uniforms = capture?.nodeBuilder.uniforms
    if (uniforms) {
        const entries: ShaderUniform[] = []
        // Fragment first — that is where the visually interesting uniforms are.
        for (const stage of [uniforms.fragment, uniforms.vertex, uniforms.compute]) {
            if (!Array.isArray(stage)) {
                continue
            }
            for (const uniform of stage) {
                if (!uniform?.name) {
                    continue
                }
                entries.push({
                    name: uniform.name,
                    type: uniform.type ?? '',
                    value: serializeValue(uniform.value),
                })
                if (entries.length >= 200) {
                    break
                }
            }
            if (entries.length >= 200) {
                break
            }
        }
        if (entries.length > 0) {
            return { from: 'node-builder', entries }
        }
    }

    // Fall back to ShaderMaterial.uniforms, which is a real uniform table.
    const table = (material as unknown as { uniforms?: Record<string, { value?: unknown }> } | null)?.uniforms
    if (table && typeof table === 'object') {
        const entries: ShaderUniform[] = []
        for (const name of Object.keys(table)) {
            entries.push({ name, type: '', value: serializeValue(table[name]?.value) })
            if (entries.length >= 200) {
                break
            }
        }
        if (entries.length > 0) {
            return { from: 'material.uniforms', entries }
        }
    }

    return { from: 'none', entries: [] }
}

/**
 * Compiled shader source, uniform values and active feature slots for one
 * object's material. See the module doc for the two source routes and why the
 * captured one is preferred.
 */
export async function collectShader(options: {
    gl: IntelligenceGL
    scene: Scene
    camera: Camera
    object: Object3D
    /** cap on each returned source string, in characters */
    maxChars?: number
}): Promise<ShaderReport> {
    const { gl, scene, camera, object, maxChars = 400_000 } = options

    const material = firstMaterialOf(object)
    const capture = capturesByObject.get(object.uuid) ?? (material ? capturesByMaterial.get(material.uuid) : undefined)

    const warnings: string[] = []
    const notes: string[] = []

    let vertexShader: string | null = null
    let fragmentShader: string | null = null
    let source: ShaderReport['source'] = 'unavailable'

    if (capture) {
        try {
            const state = capture.renderObject.getNodeBuilderState?.()
            vertexShader = state?.vertexShader ?? null
            fragmentShader = state?.fragmentShader ?? null
            if (vertexShader || fragmentShader) {
                source = 'captured'
            }
        } catch (error) {
            warnings.push(`reading the captured node builder failed: ${(error as Error).message}`)
        }
    }

    if (source === 'unavailable') {
        const getShaderAsync = gl.debug?.getShaderAsync
        if (!getShaderAsync) {
            notes.push(
                'This renderer exposes no debug.getShaderAsync, and no node builder has been captured for this object — call again once the object has been rendered at least once.',
            )
        } else {
            try {
                // Serialised: concurrent compiles race on renderer-wide state.
                const built = await serialized(() => getShaderAsync(scene, camera, object))
                vertexShader = built?.vertexShader ?? null
                fragmentShader = built?.fragmentShader ?? null
                source = vertexShader || fragmentShader ? 'compiled-on-demand' : 'unavailable'
                if (source === 'compiled-on-demand') {
                    notes.push(
                        'Source was compiled on demand for this query, so it reflects the default render context rather than a specific pipeline variant.',
                    )
                }
            } catch (error) {
                warnings.push(`compiling the shader on demand failed: ${(error as Error).message}`)
            }
        }
    }

    const clip = (text: string | null): { text: string | null; truncated: boolean } => {
        if (!text || text.length <= maxChars) {
            return { text, truncated: false }
        }
        return { text: text.slice(0, maxChars), truncated: true }
    }

    const vertex = clip(vertexShader)
    const fragment = clip(fragmentShader)
    const language = detectLanguage([vertex.text, fragment.text])

    if (language === 'wgsl') {
        notes.push(
            'This renderer compiles TSL to WGSL, which has no preprocessor — features.defines is expected to be empty. Read features.activeSlots for the equivalent signal.',
        )
    }

    return {
        object: { uuid: object.uuid, name: object.name || object.type, type: object.type },
        material: material
            ? { uuid: material.uuid, name: material.name || material.type, type: material.type }
            : null,
        language,
        source,
        vertexShader: vertex.text,
        fragmentShader: fragment.text,
        truncated: vertex.truncated || fragment.truncated,
        uniforms: collectUniforms(capture, material),
        features: {
            defines: extractDefines(fragment.text ?? vertex.text),
            materialDefines:
                ((material as unknown as { defines?: Record<string, unknown> } | null)?.defines as
                    | Record<string, unknown>
                    | undefined) ?? null,
            activeSlots: material ? activeSlots(material) : [],
        },
        notes: [
            ...notes,
            'Only the first material is reported for a multi-material mesh.',
            'uniforms.from tells you which route produced the values: "node-builder" means live TSL values read from the compiled builder, "material.uniforms" means a ShaderMaterial uniform table, "none" means neither was available.',
        ],
        warnings,
    }
}
