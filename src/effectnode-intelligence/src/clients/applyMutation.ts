import * as THREE from 'three'
import type { BufferGeometry, Camera, Material, Object3D, Scene, Texture } from 'three'
import type { JsonPatchOp } from '../protocol'
import type { IntelligenceGL } from './glTypes'
import { applyPatch, type PatchOutcome } from './jsonPatch'
import { indexScene, labelOf, resolveSelector } from './resolveObject'
import { materialTextures } from './sceneResources'
import { serializeValue } from './serialize'
import { useAssetRegistry } from './store/useAssetRegistry'

/**
 * The mutation half of idea.md §5 — the three ways an agent can change the live
 * scene: a JSON Patch (§5.1), a REPL snippet (§5.2), and a subtree dispose (the
 * remedy §2.2 asks for).
 *
 * Everything here runs in the browser, because that is where the scene lives.
 * The server only relays the request.
 */

/** A compact identity for an object, used in responses and for `$0`. */
export type ObjectRef = {
    uuid: string
    name: string
    type: string
}

function refOf(object: Object3D): ObjectRef {
    return { uuid: object.uuid, name: object.name || object.type, type: object.type }
}

/**
 * Point `$0` at an object. Called after any successful address, so a follow-up
 * request can just say `$0` — the spec's "currently selected object", which this
 * app has no UI for.
 */
function focusOn(object: Object3D, index: ReturnType<typeof indexScene>): ObjectRef {
    useAssetRegistry.getState().setFocus(object, labelOf(object, index))
    return refOf(object)
}

// ---------------------------------------------------------------------------
// §5.1 JSON Patch
// ---------------------------------------------------------------------------

export type PatchResult = PatchOutcome & {
    /** the last object any op addressed; becomes `$0` */
    target: ObjectRef | null
    /** the `$0` in effect after this patch */
    focus: string | null
}

/**
 * Apply RFC 6902 operations to the live scene.
 *
 * When `selector` is given it is resolved first, and every op path (and `from`)
 * is rebased onto that object — so `{"object":"player"}` with `"/position/y"`
 * means `player`'s local `y`, and one object can be patched repeatedly without
 * repeating its name in every path. Rebased paths are anchored on the resolved
 * object's uuid rather than its name, so a path like `/player/position/y` is
 * unambiguously a child of the target, not a second lookup from the root.
 *
 * The resolved object also becomes `$0`.
 */
export function runPatch(options: {
    scene: Object3D
    ops: JsonPatchOp[]
    selector?: string
}): PatchResult {
    const { scene, selector } = options
    const registry = useAssetRegistry.getState()
    const index = indexScene(scene)
    const originalOps = options.ops

    let ops = originalOps

    if (selector) {
        const resolution = resolveSelector(index, selector, registry.focus)
        if (!resolution.object) {
            // The caller explicitly named an object, so failing loudly beats
            // letting every op fail separately against an unrebased path.
            return {
                applied: 0,
                partial: true,
                rebuildRisk: [],
                results: [{ op: originalOps[0]?.op ?? 'replace', path: selector, ok: false, error: resolution.error }],
                target: null,
                focus: registry.focusLabel,
            }
        }
        focusOn(resolution.object, index)

        const prefix = `/${resolution.object.uuid}`
        ops = originalOps.map((op) => ({
            ...op,
            path: op.path.startsWith('/') ? `${prefix}${op.path}` : op.path,
            from: op.from && op.from.startsWith('/') ? `${prefix}${op.from}` : op.from,
        }))
    }

    // Collected rather than committed per-op: `applyPatch` calls this for every
    // operation, and writing to the store each time would re-render subscribers
    // once per op for no benefit.
    let lastTarget: Object3D | null = null

    const outcome = applyPatch({
        scene,
        focus: useAssetRegistry.getState().focus,
        ops,
        onFocus: (object) => {
            lastTarget = object
        },
    })

    const target = lastTarget ? focusOn(lastTarget, index) : null

    return {
        ...outcome,
        target,
        focus: useAssetRegistry.getState().focusLabel,
    }
}

// ---------------------------------------------------------------------------
// §5.2 REPL
// ---------------------------------------------------------------------------

export type EvalResult = {
    ok: boolean
    /** the snippet's return value, projected onto JSON-safe data */
    result?: unknown
    error?: string
    elapsedMs: number
    /** the object bound as `$0` for this snippet, if any */
    target: ObjectRef | null
}

/** A snippet longer than this is almost certainly a mistake, not a query. */
const MAX_CODE = 20_000

/**
 * Run `code` against the live runtime with `$0`, `scene`, `camera`, `gl` and
 * `THREE` in scope.
 *
 * The snippet must `return` what it wants back — `$0.position.y` on its own
 * yields `null`, because the body is a function body, not an expression:
 *
 *     return $0.position.y
 *     return scene.getObjectByName('Sun').intensity
 *     $0.material.color.setHex(0xff0000); return 'recoloured'
 *
 * This executes arbitrary JavaScript in the page. The server restricts these
 * routes to loopback callers and the client gates them on a dev build; see
 * skill/query-runtime.md.
 */
export async function runEval(options: {
    code: string
    scene: Scene
    camera: Camera
    gl: IntelligenceGL
    selector?: string
}): Promise<EvalResult> {
    const { code, scene, camera, gl, selector } = options
    const started = performance.now()

    if (code.length > MAX_CODE) {
        return {
            ok: false,
            error: `code is too long (${code.length} chars, limit ${MAX_CODE})`,
            elapsedMs: 0,
            target: null,
        }
    }

    const registry = useAssetRegistry.getState()
    const index = indexScene(scene)

    let focus = registry.focus
    if (selector) {
        const resolution = resolveSelector(index, selector, focus)
        if (!resolution.object) {
            return { ok: false, error: resolution.error, elapsedMs: 0, target: null }
        }
        focusOn(resolution.object, index)
        focus = resolution.object
    }

    const target = focus ? refOf(focus) : null

    let snippet: (a: unknown, b: unknown, c: unknown, d: unknown, e: unknown, f: unknown) => Promise<unknown>
    try {
        // eslint-disable-next-line @typescript-eslint/no-implied-eval
        snippet = new Function(
            '$0',
            'scene',
            'camera',
            'gl',
            'THREE',
            'requestAnimationFrame',
            `'use strict';\nreturn (async () => {\n${code}\n})()`,
        ) as typeof snippet
    } catch (error) {
        // Syntax errors surface here, before anything runs.
        return {
            ok: false,
            error: `could not compile the snippet: ${(error as Error).message}`,
            elapsedMs: performance.now() - started,
            target,
        }
    }

    try {
        const value = await snippet(focus, scene, camera, gl, THREE, globalThis.requestAnimationFrame?.bind(globalThis))
        return {
            ok: true,
            result: serializeValue(value),
            elapsedMs: Math.round((performance.now() - started) * 100) / 100,
            target,
        }
    } catch (error) {
        const reported = error as Error
        return {
            ok: false,
            error: `${reported?.name ?? 'Error'}: ${reported?.message ?? String(error)}`,
            elapsedMs: Math.round((performance.now() - started) * 100) / 100,
            target,
        }
    }
}

// ---------------------------------------------------------------------------
// §2.2 remedy — dispose a subtree
// ---------------------------------------------------------------------------

export type DisposeResult = {
    ok: boolean
    /** the subtree that was removed and freed */
    target: ObjectRef | null
    /** what it was detached from */
    detachedFrom: string | null
    geometryCount: number
    materialCount: number
    textureCount: number
    /** uuids of what was freed, so a later /api/query/memory can confirm it */
    disposed: { geometries: string[]; materials: string[]; textures: string[] }
    error?: string
}

type DrawableNode = Object3D & {
    geometry?: BufferGeometry | null
    material?: Material | Material[] | null
}

/**
 * Detach a subtree from its parent and dispose every geometry, material and
 * texture it referenced.
 *
 * This is destructive and it is the one mutation that cannot be undone by a
 * follow-up patch — the resources are released and the object is out of the
 * graph. It refuses the scene root for that reason: dispose a subtree, not the
 * world.
 */
export function runDispose(options: { scene: Object3D; selector?: string }): DisposeResult {
    const { scene, selector } = options
    const registry = useAssetRegistry.getState()
    const index = indexScene(scene)

    const resolution = resolveSelector(index, selector ?? '$0', registry.focus)
    if (!resolution.object) {
        return {
            ok: false,
            target: null,
            detachedFrom: null,
            geometryCount: 0,
            materialCount: 0,
            textureCount: 0,
            disposed: { geometries: [], materials: [], textures: [] },
            error: resolution.error,
        }
    }

    const target = resolution.object
    if (target === scene) {
        return {
            ok: false,
            target: refOf(target),
            detachedFrom: null,
            geometryCount: 0,
            materialCount: 0,
            textureCount: 0,
            disposed: { geometries: [], materials: [], textures: [] },
            error: 'refusing to dispose the scene root — address a subtree instead',
        }
    }

    // Collect first, deduped by identity: geometries and materials are commonly
    // shared across a subtree, and disposing one twice is harmless but counting
    // it twice would misreport.
    const geometries = new Set<BufferGeometry>()
    const materials = new Set<Material>()
    const textures = new Set<Texture>()

    target.traverse((object) => {
        const node = object as DrawableNode
        if (node.geometry) {
            geometries.add(node.geometry)
        }
        const list = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
        for (const material of list) {
            if (material) {
                materials.add(material)
            }
        }
    })
    for (const material of materials) {
        for (const { texture } of materialTextures(material)) {
            textures.add(texture)
        }
    }

    const parent = target.parent
    const detachedFrom = parent ? labelOf(parent, index) : null
    parent?.remove(target)

    const disposed = { geometries: [] as string[], materials: [] as string[], textures: [] as string[] }
    for (const geometry of geometries) {
        geometry.dispose()
        disposed.geometries.push(geometry.uuid)
    }
    for (const material of materials) {
        material.dispose()
        disposed.materials.push(material.uuid)
    }
    for (const texture of textures) {
        texture.dispose()
        disposed.textures.push(texture.uuid)
    }

    // These are now deliberately freed, so stop reporting them as leak
    // candidates — otherwise a dispose would never clear its own finding.
    registry.forget([...disposed.geometries, ...disposed.materials, ...disposed.textures])

    scene.updateWorldMatrix(false, true)

    return {
        ok: true,
        target: refOf(target),
        detachedFrom,
        geometryCount: geometries.size,
        materialCount: materials.size,
        textureCount: textures.size,
        disposed,
    }
}
