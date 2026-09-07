import type { Color, Material, Object3D } from 'three'

/**
 * Scalar-only view of a material: identity (name/type/uuid) plus primitive
 * params (numbers/booleans/strings and Colors → hex). Textures/maps, arrays,
 * vectors and functions are dropped, and geometry is never part of a material.
 */
export type MaterialScalars = Record<string, unknown> & {
    name: string
    type: string
    uuid: string
}

/** One node of the returned scene graph. Leaf objects have `children: []`. */
export type SceneGraphNode = {
    name: string
    type: string
    /** Meshes carry one material, possibly several; the rest have null. */
    material: MaterialScalars | MaterialScalars[] | null
    children: SceneGraphNode[]
}

type GraphNode = Object3D & {
    material?: Material | Material[] | null
}

/**
 * Render-state / internal plumbing that carries no "what does this material
 * look like" signal — stripped so the descriptor stays readable for an agent.
 */
const RENDER_PLUMBING = new Set([
    'version',
    'visible',
    'needsUpdate',
    'toneMapped',
    'fog',
    'colorWrite',
    'premultipliedAlpha',
    'alphaToCoverage',
    'dithering',
    'forceSinglePass',
    'allowOverride',
    'blending',
    'blendSrc',
    'blendDst',
    'blendEquation',
    'blendSrcAlpha',
    'blendDstAlpha',
    'blendEquationAlpha',
    'blendColor',
    'blendAlpha',
    'depthFunc',
    'depthTest',
    'depthWrite',
    'stencilWriteMask',
    'stencilFunc',
    'stencilRef',
    'stencilFuncMask',
    'stencilFail',
    'stencilZFail',
    'stencilZPass',
    'stencilWrite',
    'clipIntersection',
    'clipShadows',
    'polygonOffset',
    'polygonOffsetFactor',
    'polygonOffsetUnits',
    'alphaTest',
])

/** Collect own-enumerable material params that survive JSON + a light payload. */
function materialScalars(material: Material): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(material)) {
        // name/type/uuid are surfaced explicitly on the descriptor.
        if (key === 'name' || key === 'type' || key === 'uuid' || key === 'id') {
            continue
        }
        // Skip three's internal bookkeeping (_alphaTest, isMaterial, isMeshStandardMaterial, …).
        if (key.startsWith('_') || key.startsWith('is') || RENDER_PLUMBING.has(key)) {
            continue
        }
        const value = (material as unknown as Record<string, unknown>)[key]
        if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
            out[key] = value
            continue
        }
        // THREE.Color instances are objects but cheap + useful -> emit as hex.
        const color = value as Color | null | undefined
        if (color && typeof color.getHex === 'function') {
            out[key] = color.getHex()
        }
        // everything else (Texture maps, arrays, vectors, functions, …) is skipped
    }
    return out
}

function materialOf(object: Object3D): MaterialScalars | MaterialScalars[] | null {
    const node = object as GraphNode
    if (!node.material) {
        return null
    }
    const list = (Array.isArray(node.material) ? node.material : [node.material])
        .filter((m): m is Material => Boolean(m))
        .map((m) => ({ name: m.name || m.type, type: m.type, uuid: m.uuid, ...materialScalars(m) }))
    if (list.length === 0) {
        return null
    }
    return list.length === 1 ? list[0] : list
}

/**
 * Full scene graph for /api/scene/query — every node with name, type, and its
 * material(s), recursing into children. Deliberately excludes geometry and any
 * texture/map data so the reply stays a structural digest of the scene.
 */
export function collectSceneGraph(root: Object3D): SceneGraphNode {
    return {
        name: root.name || '',
        type: root.type,
        material: materialOf(root),
        children: root.children.map((child) => collectSceneGraph(child)),
    }
}
