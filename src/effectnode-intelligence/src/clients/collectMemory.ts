import type { Object3D } from 'three'
import {
    observedResources,
    scanScene,
    type GeometryRecord,
    type MaterialRecord,
    type ResourceKind,
    type TextureRecord,
} from './sceneResources'
import { useAssetRegistry, type SeenResource } from './store/useAssetRegistry'
import type { GpuMemory } from './store/useRuntimePerf'

/**
 * A resource that was in the scene on an earlier walk and is not in it now.
 * Either it was legitimately disposed, or it is still resident on the GPU
 * because nothing ever called `.dispose()` on it.
 */
export type LeakCandidate = SeenResource & {
    /** the call that would free it, once you have a reference to it */
    disposeHint: string
}

/**
 * A group of separate meshes that share one geometry + material combination and
 * could therefore collapse into a single `THREE.InstancedMesh`.
 */
export type InstancingCandidate = {
    geometryUuid: string
    geometryName: string
    materialUuids: string[]
    /** how many separate Mesh objects are in the group */
    objectCount: number
    /** names of the members, so they're findable in the scene graph */
    names: string[]
    /** triangles drawn across the whole group per frame */
    triangles: number
    /** draw calls issued today */
    drawCallsNow: number
    /** draw calls after batching into one InstancedMesh */
    drawCallsAfter: 1
}

export type MemoryReport = {
    totals: {
        objects: number
        geometries: number
        materials: number
        textures: number
        /** bytes held by scene-referenced geometry buffers */
        geometryBytes: number
        /** bytes attributable to scene-referenced textures */
        textureBytes: number
        /** true when at least one texture size was an RGBA8 assumption */
        textureBytesEstimated: boolean
    }
    /**
     * Live GPU-side levels straight from renderer.info.memory. `geometries` /
     * `textures` increment on upload and only decrement on a real `.dispose()`,
     * so comparing these against the scene-referenced counts below is what makes
     * a leak visible.
     */
    gpu: GpuMemory
    geometries: GeometryRecord[]
    materials: MaterialRecord[]
    textures: TextureRecord[]
    /** rows dropped from each list to bound the payload */
    truncated: { geometries: number; materials: number; textures: number }
    leakCandidates: LeakCandidate[]
    instancingCandidates: InstancingCandidate[]
    /** how to read this report honestly — surfaced to the agent, not just to a human */
    notes: string[]
}

const MAX_ROWS = 200

const DISPOSE_HINT: Record<ResourceKind, string> = {
    geometry: 'geometry.dispose()',
    material: 'material.dispose()',
    texture: 'texture.dispose()',
}

/** Cap a sorted list, reporting how many rows were dropped. */
function cap<T>(rows: T[]): { rows: T[]; dropped: number } {
    if (rows.length <= MAX_ROWS) {
        return { rows, dropped: 0 }
    }
    return { rows: rows.slice(0, MAX_ROWS), dropped: rows.length - MAX_ROWS }
}

/**
 * Memory digest of the live runtime scene for /api/query/memory.
 *
 * Covers idea.md §2.1 (what is loaded and how big), §2.2 (what is loaded but no
 * longer in the scene) and §2.3 (what is drawn separately but could be batched).
 */
export function collectMemory(root: Object3D, gpu: GpuMemory): MemoryReport {
    const walk = scanScene(root)

    // Every walk teaches the registry what is currently live. Doing this here —
    // once per query, not once per frame — is what keeps the cost off the
    // render loop.
    const registry = useAssetRegistry.getState()
    registry.observe(observedResources(walk))
    const seen = registry.seen

    const present = new Set<string>([
        ...walk.geometries.keys(),
        ...walk.materials.keys(),
        ...walk.textures.keys(),
    ])

    const leakCandidates: LeakCandidate[] = []
    for (const resource of seen.values()) {
        if (present.has(resource.uuid)) {
            continue
        }
        leakCandidates.push({ ...resource, disposeHint: DISPOSE_HINT[resource.kind] })
    }
    // Most recently lost first — that is usually the action just performed.
    leakCandidates.sort((a, b) => b.lastSeenMs - a.lastSeenMs)

    // ---- §2.3 instancing candidates ---------------------------------------
    // Group by geometry + material identity. InstancedMesh objects are already
    // batched, so they are excluded rather than reported as their own candidates.
    const groups = new Map<string, { drawables: typeof walk.drawables }>()
    for (const drawable of walk.drawables) {
        const node = drawable.object as { isInstancedMesh?: boolean }
        if (node.isInstancedMesh) {
            continue
        }
        const materialKey = drawable.materials
            .map((m) => m.uuid)
            .sort()
            .join(',')
        const key = `${drawable.geometryUuid}|${materialKey}`
        const group = groups.get(key)
        if (group) {
            group.drawables.push(drawable)
        } else {
            groups.set(key, { drawables: [drawable] })
        }
    }

    const instancingCandidates: InstancingCandidate[] = []
    for (const { drawables } of groups.values()) {
        if (drawables.length < 2) {
            continue
        }
        const first = drawables[0]
        instancingCandidates.push({
            geometryUuid: first.geometryUuid,
            geometryName: first.object.name || first.type,
            materialUuids: first.materials.map((m) => m.uuid),
            objectCount: drawables.length,
            names: drawables.map((d) => d.name),
            triangles: drawables.reduce((sum, d) => sum + d.triangleCount, 0),
            drawCallsNow: drawables.reduce((sum, d) => sum + d.drawCalls, 0),
            drawCallsAfter: 1,
        })
    }
    instancingCandidates.sort((a, b) => b.drawCallsNow - a.drawCallsNow || b.objectCount - a.objectCount)

    // ---- §2.1 registry -----------------------------------------------------
    const geometries = [...walk.geometries.values()].sort((a, b) => b.bytes - a.bytes)
    const materials = [...walk.materials.values()].sort(
        (a, b) => b.references - a.references || b.textureSlots.length - a.textureSlots.length,
    )
    const textures = [...walk.textures.values()].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0))

    const cappedGeometries = cap(geometries)
    const cappedMaterials = cap(materials)
    const cappedTextures = cap(textures)

    let geometryBytes = 0
    for (const g of geometries) {
        geometryBytes += g.bytes
    }
    let textureBytes = 0
    let textureBytesEstimated = false
    for (const t of textures) {
        textureBytes += t.bytes ?? 0
        if (t.estimatedBytes) {
            textureBytesEstimated = true
        }
    }

    return {
        totals: {
            objects: walk.objects,
            geometries: geometries.length,
            materials: materials.length,
            textures: textures.length,
            geometryBytes,
            textureBytes,
            textureBytesEstimated,
        },
        gpu,
        geometries: cappedGeometries.rows,
        materials: cappedMaterials.rows,
        textures: cappedTextures.rows,
        truncated: {
            geometries: cappedGeometries.dropped,
            materials: cappedMaterials.dropped,
            textures: cappedTextures.dropped,
        },
        leakCandidates,
        instancingCandidates,
        notes: [
            'leakCandidates is a differential heuristic, not a definitive leak list: three exposes no way to enumerate every live BufferGeometry/Material/Texture, so a resource can only be recognised as "gone" by comparing this walk against earlier ones. Query /api/query/memory before and after the action you suspect.',
            'A candidate may have been disposed correctly — a resource that was disposed will stop being counted by renderer.info.memory. Compare gpu.geometries / gpu.textures against totals.geometries / totals.textures: a persistent gap means something is still resident.',
            'Resources held by module-level caches are never reachable from the scene graph, so they are only visible here as candidates. Known ones in this app: meshBuilder `_geoMaterialCache` / `_textureCache`, tslMaterialBuilder `_rampTextureCache`, motionLibrary `fbxCache`, and the scene.environment / scene.background textures from useEnvironmentMap.',
            'instancingCandidates only sees separate Mesh objects sharing a geometry+material. It cannot see two meshes whose geometries are distinct objects holding identical vertex data — this app keys its own batching on the Blender object name, so identically-shaped objects with different names get separate geometries and stay invisible to both.',
            'textureBytes assumes 4 bytes per pixel (RGBA8) unless the texture is backed by a typed array; check textureBytesEstimated.',
        ],
    }
}
