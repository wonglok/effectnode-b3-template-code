import type { Object3D } from 'three'
import { scanScene } from './sceneResources'

/** One texture a material binds, and the slot it binds it to. */
export type DrawCallTexture = {
    /** the material slot, e.g. `map` / `normalMap` / `uniforms.uRamp` */
    slot: string
    uuid: string
    name: string
    type: string
}

/** One material on a drawable object, with everything it binds. */
export type DrawCallMaterial = {
    uuid: string
    name: string
    type: string
    textures: DrawCallTexture[]
}

/** One drawable object and the draw calls it costs per frame. */
export type DrawCallObject = {
    uuid: string
    name: string
    type: string
    geometryUuid: string
    /** draw calls issued per frame — one per geometry group for a multi-material mesh */
    drawCalls: number
    /** times the geometry repeats per frame (instancing) */
    instances: number
    /** triangles rasterized per frame, instancing-aware */
    triangles: number
    materials: DrawCallMaterial[]
}

export type DrawCallReport = {
    totals: {
        /** static estimate: sum of every object's draw calls */
        drawCalls: number
        /**
         * Measured whole-frame total from `renderer.info`, or null when no
         * monitor is sampling. This is the ground truth the estimate should be
         * checked against — a large gap means the scene spends draw calls on
         * something outside the scene graph (shadow maps, post-processing, the
         * environment/background pass).
         */
        measuredFrameDrawCalls: number | null
        objects: number
        materials: number
        textures: number
    }
    /** Heaviest first — the objects to look at when cutting draw calls. */
    objects: DrawCallObject[]
    /** rows dropped from `objects` to bound the payload */
    truncated: number
    notes: string[]
}

const MAX_OBJECTS = 50

/**
 * Draw-call dependency map for /api/query/drawcalls — which objects cost the
 * most draw calls, which materials they use, and which textures those materials
 * bind. Covers idea.md §3.3.
 *
 * This is the view that makes a single expensive object obvious: a mesh with 15
 * geometry groups costs 15 draw calls on its own, which no aggregate total can
 * show.
 */
export function collectDrawCalls(root: Object3D, measuredFrameDrawCalls: number | null): DrawCallReport {
    const walk = scanScene(root)

    // Texture identity → display name, so each binding can be named.
    const textureNames = new Map<string, { name: string; type: string }>()
    for (const texture of walk.textures.values()) {
        textureNames.set(texture.uuid, { name: texture.name || texture.type, type: texture.type })
    }

    const objects: DrawCallObject[] = walk.drawables.map((drawable) => ({
        uuid: drawable.uuid,
        name: drawable.name,
        type: drawable.type,
        geometryUuid: drawable.geometryUuid,
        drawCalls: drawable.drawCalls,
        instances: drawable.instances,
        triangles: drawable.triangleCount,
        materials: drawable.materials.map((material) => ({
            uuid: material.uuid,
            name: material.name,
            type: material.type,
            textures: material.textureSlots.map(({ slot, uuid }) => ({
                slot,
                uuid,
                name: textureNames.get(uuid)?.name ?? '',
                type: textureNames.get(uuid)?.type ?? '',
            })),
        })),
    }))

    objects.sort((a, b) => b.drawCalls - a.drawCalls || b.triangles - a.triangles)

    let drawCalls = 0
    for (const object of objects) {
        drawCalls += object.drawCalls
    }

    const truncated = Math.max(0, objects.length - MAX_OBJECTS)

    return {
        totals: {
            drawCalls,
            measuredFrameDrawCalls,
            objects: objects.length,
            materials: walk.materials.size,
            textures: walk.textures.size,
        },
        objects: objects.slice(0, MAX_OBJECTS),
        truncated,
        notes: [
            'totals.drawCalls is a static estimate from the scene graph; totals.measuredFrameDrawCalls is the real whole-frame count sampled from renderer.info. When the measured number is much larger, the extra calls come from outside the scene graph — shadow-map passes, the bloom pipeline, and the environment/background.',
            'A mesh whose material is an array costs one draw call per geometry group, not per material. drawCalls reflects groups.',
            'Shaders that share a material but differ per object (three folds object identity into the pipeline cache key for InstancedMesh) can produce more GPU pipelines than there are materials here.',
        ],
    }
}
