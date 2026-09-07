import type { BufferGeometry, Object3D } from 'three'
import { useRuntimePerf, type RuntimePerfSnapshot } from './store/useRuntimePerf'

/**
 * Scalar-only, per-geometry performance view: buffer-derived counts plus how
 * many scene objects reference it. Names the first few owners so an agent can
 * find the geometry in the scene graph. Textures are never part of a geometry.
 */
export type GeometryStat = {
    uuid: string
    name: string
    type: string
    /** vertices in the position attribute */
    vertexCount: number
    /** vertices covered by the index attribute; 0 when non-indexed */
    indexCount: number
    /** triangles: index.length/3 when indexed, else vertexCount/3 */
    triangleCount: number
    /** number of scene objects drawing this geometry (1 = used once) */
    references: number
    /** names of the first few referencing objects, so it's findable by name */
    owners: string[]
}

/** One drawable object and the per-frame primitive cost it imposes on the GPU. */
export type ObjectCost = {
    name: string
    type: string
    uuid: string
    /** times this object repeats its geometry per frame (instancing) */
    instances: number
    /** vertices sent per frame = base vertices × instances */
    vertexCount: number
    /** triangles rasterized per frame = base triangles × instances */
    triangleCount: number
}

/** Aggregate render-load numbers for the whole scene. */
export type ScenePerformance = {
    totals: {
        /** every Object3D in the tree */
        objects: number
        /** objects carrying a geometry — ~one draw call each */
        drawCalls: number
        /** distinct geometry objects (shared geometry counted once) */
        uniqueGeometries: number
        /** distinct materials across all drawable objects */
        uniqueMaterials: number
        /** distinct textures referenced by any material map */
        uniqueTextures: number
        /** geometry vertices, deduped across shared geometry */
        vertices: number
        /** geometry triangles, deduped across shared geometry */
        triangles: number
        /** vertices actually drawn per frame — instancing-aware, repeats shared geometry */
        drawnVertices: number
        /** triangles actually drawn per frame — instancing-aware, repeats shared geometry */
        drawnTriangles: number
    }
    /** one row per distinct geometry, biggest first */
    geometries: GeometryStat[]
    /**
     * The objects that cost the most GPU primitives per frame (instancing-aware,
     * shared geometry repeated per referencing object). A static-cost proxy for
     * "which object is slow" — frame ms is measured in `runtime`, this ranks the
     * most likely geometric culprits. Biggest first, capped at MAX_OBJECTS.
     */
    slowObjects: ObjectCost[]
    /** Live-frame measurements (fps, frame budget, effect cost) — empty/zero when
     *  no RuntimePerf monitor is mounted on this page. */
    runtime: RuntimePerfSnapshot
}

type DrawableNode = Object3D & {
    geometry?: BufferGeometry | null
    isInstancedMesh?: boolean
    /** InstancedMesh.instanceCount is null unless overridden — the real instance
     *  count is `count` (the number of instances this mesh draws). */
    count?: number
    material?: unknown
}

type MaterialLike = { uuid?: string } & Record<string, unknown>

/** Buffer-derived counts that are instancing-agnostic. */
function geomCounts(geometry: BufferGeometry) {
    const position = geometry.getAttribute('position')
    const vertexCount = position ? position.count : 0
    const index = geometry.index
    const indexCount = index ? index.count : 0
    // Triangles only make sense for indexed triangle meshes; for non-indexed
    // geometry (or lines/points) this is a best-effort vertex/3 estimate.
    const triangleCount = indexCount > 0 ? Math.floor(indexCount / 3) : Math.floor(vertexCount / 3)
    return { vertexCount, indexCount, triangleCount }
}

/** Record one material's identity + the uuids of any textures in its maps. */
function scanMaterial(material: unknown, materials: Set<string>, textures: Set<string>) {
    if (!material || typeof material !== 'object') {
        return
    }
    const m = material as MaterialLike
    if (typeof m.uuid === 'string') {
        materials.add(m.uuid)
    }
    for (const key of Object.keys(m)) {
        const value = m[key]
        if (!value || typeof value !== 'object') {
            continue
        }
        // three's Texture instances — material.map, normalMap, aoMap, …
        const tex = value as { isTexture?: boolean; uuid?: string }
        if (tex.isTexture === true && typeof tex.uuid === 'string') {
            textures.add(tex.uuid)
        }
    }
}

const MAX_OWNERS = 5
const MAX_OBJECTS = 8

/**
 * Performance digest of the live runtime scene for /api/query/performance — vertex /
 * index / triangle counts per geometry, aggregate draw-load totals, the most
 * GPU-expensive objects, and (when a monitor is mounted) live frame-rate / frame
 * budget / effect timing. Static geometry is deliberately a separate, flat
 * report (not folded into each scene-graph node) so shared geometry and
 * per-frame cost are visible at a glance.
 */
export function collectScenePerformance(root: Object3D): ScenePerformance {
    const geometryById = new Map<string, GeometryStat>()
    const materialIds = new Set<string>()
    const textureIds = new Set<string>()
    const objectCosts: ObjectCost[] = []

    let objects = 0
    let drawCalls = 0
    let drawnVertices = 0
    let drawnTriangles = 0

    const visit = (object: Object3D) => {
        objects++
        const node = object as DrawableNode
        const geometry = node.geometry

        if (geometry) {
            drawCalls++
            const { vertexCount, indexCount, triangleCount } = geomCounts(geometry)

            // Instancing multiplies the per-instance geometry at draw time.
            let instances = 1
            if (node.isInstancedMesh && typeof node.count === 'number') {
                instances = Math.max(1, Math.floor(node.count))
            }
            drawnVertices += vertexCount * instances
            drawnTriangles += triangleCount * instances

            // Per-object cost leaders (see slowObjects on the result).
            objectCosts.push({
                name: object.name || object.type,
                type: object.type,
                uuid: object.uuid,
                instances,
                vertexCount: vertexCount * instances,
                triangleCount: triangleCount * instances,
            })

            let stat = geometryById.get(geometry.uuid)
            if (!stat) {
                stat = {
                    uuid: geometry.uuid,
                    name: geometry.name || '',
                    type: geometry.type,
                    vertexCount,
                    indexCount,
                    triangleCount,
                    references: 0,
                    owners: [],
                }
                geometryById.set(geometry.uuid, stat)
            }
            stat.references++
            if (stat.owners.length < MAX_OWNERS) {
                stat.owners.push(object.name || object.type)
            }

            // Materials live on the mesh-like owner, not the geometry.
            const materials = Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
            for (const material of materials) {
                scanMaterial(material, materialIds, textureIds)
            }
        }

        for (const child of object.children) {
            visit(child)
        }
    }

    visit(root)

    const geometries = [...geometryById.values()].sort(
        (a, b) => b.triangleCount - a.triangleCount || b.vertexCount - a.vertexCount,
    )
    const slowObjects = objectCosts
        .sort((a, b) => b.triangleCount - a.triangleCount || b.vertexCount - a.vertexCount)
        .slice(0, MAX_OBJECTS)

    let vertices = 0
    let triangles = 0
    for (const g of geometries) {
        vertices += g.vertexCount
        triangles += g.triangleCount
    }

    return {
        totals: {
            objects,
            drawCalls,
            uniqueGeometries: geometries.length,
            uniqueMaterials: materialIds.size,
            uniqueTextures: textureIds.size,
            vertices,
            triangles,
            drawnVertices,
            drawnTriangles,
        },
        geometries,
        slowObjects,
        runtime: useRuntimePerf.getState().snapshot(),
    }
}

//
