import type { Object3D } from 'three'
import { scanScene, type GeometryRecord } from './sceneResources'
import { useRuntimePerf, type RuntimePerfSnapshot } from './store/useRuntimePerf'

/**
 * Performance digest of the live runtime scene for /api/query/performance —
 * vertex / index / triangle counts per geometry, aggregate draw-load totals, the
 * most GPU-expensive objects, and (when a monitor is mounted) live frame-rate /
 * frame budget / effect timing.
 *
 * Static geometry is deliberately a separate, flat report rather than being
 * folded into each scene-graph node, so shared geometry and per-frame cost are
 * visible at a glance. The heavy lifting is shared with the memory and
 * draw-call collectors via `scanScene`, so "how many triangles" and "how many
 * draw calls" have exactly one definition across the tool.
 */

/** One distinct geometry, as reported here. */
export type GeometryStat = GeometryRecord

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
        /**
         * Draw calls the scene graph issues per frame — one per geometry group
         * for a multi-material mesh. This is a static estimate; `runtime.load.drawCalls`
         * is the measured whole-frame count, which also covers shadow and
         * post-processing passes.
         */
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

const MAX_OBJECTS = 8

export function collectScenePerformance(root: Object3D): ScenePerformance {
    const walk = scanScene(root)

    const geometries = [...walk.geometries.values()].sort(
        (a, b) => b.triangleCount - a.triangleCount || b.vertexCount - a.vertexCount,
    )

    const slowObjects: ObjectCost[] = walk.drawables
        .map((drawable) => ({
            name: drawable.name,
            type: drawable.type,
            uuid: drawable.uuid,
            instances: drawable.instances,
            vertexCount: drawable.vertexCount,
            triangleCount: drawable.triangleCount,
        }))
        .sort((a, b) => b.triangleCount - a.triangleCount || b.vertexCount - a.vertexCount)
        .slice(0, MAX_OBJECTS)

    let vertices = 0
    let triangles = 0
    for (const geometry of geometries) {
        vertices += geometry.vertexCount
        triangles += geometry.triangleCount
    }

    let drawCalls = 0
    let drawnVertices = 0
    let drawnTriangles = 0
    for (const drawable of walk.drawables) {
        drawCalls += drawable.drawCalls
        drawnVertices += drawable.vertexCount
        drawnTriangles += drawable.triangleCount
    }

    return {
        totals: {
            objects: walk.objects,
            drawCalls,
            uniqueGeometries: geometries.length,
            uniqueMaterials: walk.materials.size,
            uniqueTextures: walk.textures.size,
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
