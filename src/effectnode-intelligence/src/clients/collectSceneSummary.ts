import type { BufferGeometry, Material, Object3D, Scene } from 'three'

export type SceneSummary = {
    /** Total nodes in the scene graph (every traverse hit, incl. unnamed ones). */
    objectCount: number
    /** Grouped by constructor type, e.g. { Group: 3, Mesh: 40, Bone: 90 }. */
    objectTypeCounts: Record<string, number>
    /** Named objects only — capped so the payload stays light. */
    namedObjects: { name: string; type: string }[]
    /** Unique geometries in the scene (shared ones counted once). */
    geometryCount: number
    /** Unique materials in the scene (shared ones counted once). */
    materialCount: number
    /** Lights grouped by type, e.g. { DirectionalLight: 1 }. */
    lights: Record<string, number>
    /** Cameras found in the graph (r3f's default camera is usually NOT a child). */
    cameras: string[]
    /** Objects carrying animation clips (avatar rigs etc.). */
    animated: { name: string; clipCount: number; clips: string[] }[]
}

/** Keeps the reply bounded even on dense rigs — counts still cover the whole scene. */
const NAMED_OBJECT_CAP = 200

type TraversableObject = Object3D & {
    isMesh?: boolean
    isLight?: boolean
    isCamera?: boolean
    geometry?: BufferGeometry
    material?: Material | Material[]
    animations?: { name: string }[]
}

/**
 * Light, agent-friendly digest of a three.js scene — the "scene information"
 * the editor reports back for a /api/scene/query. Cheap to compute and cheap to
 * send over the socket, unlike a full scene.toJSON() (~147MB).
 */
export function collectSceneSummary(scene: Scene): SceneSummary {
    const objectTypeCounts: Record<string, number> = {}
    const namedObjects: SceneSummary['namedObjects'] = []
    const lights: Record<string, number> = {}
    const cameras: string[] = []
    const animated: SceneSummary['animated'] = []

    // Count shared resources once. Geometries have an id; materials dedupe by reference.
    const geometryIds = new Set<number>()
    const materialSet = new Set<Material>()

    let objectCount = 0

    scene.traverse((object) => {
        objectCount += 1

        objectTypeCounts[object.type] = (objectTypeCounts[object.type] ?? 0) + 1

        if (object.name && namedObjects.length < NAMED_OBJECT_CAP) {
            namedObjects.push({ name: object.name, type: object.type })
        }

        const node = object as TraversableObject

        if (node.isMesh) {
            if (node.geometry) {
                geometryIds.add(node.geometry.id)
            }
            for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
                if (material) {
                    materialSet.add(material)
                }
            }
        }

        if (node.isLight) {
            lights[node.type] = (lights[node.type] ?? 0) + 1
        }

        if (node.isCamera) {
            cameras.push(node.name || node.type)
        }

        const clips = node.animations
        if (clips && clips.length > 0) {
            animated.push({
                name: node.name || node.type,
                clipCount: clips.length,
                clips: clips.map((clip) => clip.name),
            })
        }
    })

    return {
        objectCount,
        objectTypeCounts,
        namedObjects,
        geometryCount: geometryIds.size,
        materialCount: materialSet.size,
        lights,
        cameras,
        animated,
    }
}
