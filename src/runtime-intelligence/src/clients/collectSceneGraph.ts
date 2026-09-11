import type { Box3, BufferGeometry, Color, Material, Object3D } from 'three'

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

/** A world-space axis-aligned bounding box, as plain number triples. */
export type SceneBounds = {
    min: [number, number, number]
    max: [number, number, number]
}

/** One node of the returned scene graph. Leaf objects have `children: []`. */
export type SceneGraphNode = {
    /** uuid of the underlying Object3D — the handle to address it in a patch. */
    uuid: string
    name: string
    type: string
    /**
     * Cull / visibility state. These are what answer "why is my shadow
     * missing?" and "why does this vanish when I pan the camera?".
     */
    visible: boolean
    castShadow: boolean
    receiveShadow: boolean
    frustumCulled: boolean
    /** Draw-order override; higher renders later. */
    renderOrder: number
    /**
     * LOCAL transform — exactly the properties `/api/mutation/patch` writes, so
     * a patch can be verified by re-querying. Note the contrast with `bbox`,
     * which is world-space: under a scaled or rotated parent these two do not
     * agree, and doing world-space arithmetic on `position` will be wrong.
     */
    position: [number, number, number]
    /** LOCAL rotation as XYZ Euler angles, in radians. */
    rotation: [number, number, number]
    /** LOCAL scale. */
    scale: [number, number, number]
    /**
     * World-space AABB, already including every descendant's geometry — so an
     * agent can reason about placement without multiplying local matrices.
     * `null` for a node with no geometry anywhere beneath it.
     */
    bbox: SceneBounds | null
    /** Meshes carry one material, possibly several; the rest have null. */
    material: MaterialScalars | MaterialScalars[] | null
    children: SceneGraphNode[]
}

type GraphNode = Object3D & {
    material?: Material | Material[] | null
    geometry?: BufferGeometry | null
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

type BoundedNode = GraphNode & {
    /**
     * `InstancedMesh` and `SkinnedMesh` carry their own box, spanning every
     * instance / the posed skeleton. Falls back to the geometry's box otherwise.
     */
    boundingBox?: Box3 | null
    computeBoundingBox?: () => void
    isInstancedMesh?: boolean
    isSkinnedMesh?: boolean
}

/**
 * World-space AABB of just this object's own geometry — i.e. excluding its
 * children. `null` when the object draws nothing.
 *
 * Both `geometry.boundingBox` and the mesh-level `boundingBox` are computed
 * lazily by three, so they may be absent; compute on demand.
 */
function ownWorldBounds(object: Object3D): Box3 | null {
    const node = object as BoundedNode

    // Batched and skinned meshes must use their OWN box: geometry.boundingBox
    // describes the base geometry at the origin, so for an InstancedMesh it
    // would report a box covering a single instance at the wrong place — the
    // exact population these bounds are meant to make placeable.
    if (node.isInstancedMesh || node.isSkinnedMesh) {
        if (node.boundingBox == null && typeof node.computeBoundingBox === 'function') {
            node.computeBoundingBox()
        }
        const box = node.boundingBox
        return box && !box.isEmpty() ? box.clone().applyMatrix4(object.matrixWorld) : null
    }

    const geometry = node.geometry
    if (!geometry) {
        return null
    }
    if (!geometry.boundingBox) {
        geometry.computeBoundingBox()
    }
    const box = geometry.boundingBox
    if (!box || box.isEmpty()) {
        return null
    }
    // Transforming a Box3 maps its 8 corners, so the result is still a valid AABB.
    return box.clone().applyMatrix4(object.matrixWorld)
}

function toBounds(box: Box3 | null): SceneBounds | null {
    if (!box || box.isEmpty()) {
        return null
    }
    return {
        min: [box.min.x, box.min.y, box.min.z],
        max: [box.max.x, box.max.y, box.max.z],
    }
}

/**
 * Full scene graph for /api/query/scene — every node with name, type, cull
 * flags, world-space bounds and its material(s). Deliberately excludes geometry
 * and any texture/map data so the reply stays a structural digest of the scene.
 *
 * Bounds are accumulated bottom-up in a single O(n) pass: a node's box is its
 * own geometry's world box unioned with each child's. Calling
 * `Box3.setFromObject` per node instead would re-traverse every subtree and
 * make the whole walk O(n²).
 *
 * `maxDepth` truncates the *emitted* tree (root = depth 0) without truncating
 * the bounds calculation, so a shallow query still reports true spatial extents.
 */
export function collectSceneGraph(root: Object3D, options: { maxDepth?: number } = {}): SceneGraphNode {
    // Clamped to >= 0 so the root (depth 0) is always emitted, which is what
    // lets the cast at the bottom of this function be safe.
    const maxDepth = Math.max(0, options.maxDepth ?? Number.POSITIVE_INFINITY)

    // The handler runs outside the render loop, so ensure the transform chain
    // we are about to read is current.
    root.updateWorldMatrix(false, true)

    const walk = (object: Object3D, depth: number): { node: SceneGraphNode | null; box: Box3 | null } => {
        let box = ownWorldBounds(object)

        const children: SceneGraphNode[] = []
        for (const child of object.children) {
            const sub = walk(child, depth + 1)
            if (sub.box) {
                box = box ? box.union(sub.box) : sub.box
            }
            if (sub.node) {
                children.push(sub.node)
            }
        }

        if (depth > maxDepth) {
            return { node: null, box }
        }

        return {
            node: {
                uuid: object.uuid,
                name: object.name || '',
                type: object.type,
                visible: object.visible,
                castShadow: object.castShadow,
                receiveShadow: object.receiveShadow,
                frustumCulled: object.frustumCulled,
                renderOrder: object.renderOrder,
                position: [object.position.x, object.position.y, object.position.z],
                rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
                scale: [object.scale.x, object.scale.y, object.scale.z],
                bbox: toBounds(box),
                material: materialOf(object),
                children,
            },
            box,
        }
    }

    // Safe: maxDepth is clamped to >= 0, so depth 0 always passes the
    // `depth > maxDepth` check and walk yields a node for the root.
    return walk(root, 0).node as SceneGraphNode
}
