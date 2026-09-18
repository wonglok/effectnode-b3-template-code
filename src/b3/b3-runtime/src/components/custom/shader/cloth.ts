/**
 * Cloth — a GPU-simulated verlet cloth, ported from three's
 * `webgpu_compute_cloth` example, drawn with `TransmissionTSLMaterial`.
 *
 * The simulation is the example's, structure for structure: a grid of verlet
 * vertices joined by springs lives in storage buffers, two compute shaders run
 * per step (spring forces, then vertex forces), and the visible mesh is a second
 * grid — one render vertex per *cell* — whose position node reads the four
 * corner vertices around it and averages them. That indirection is what lets the
 * cloth deform without touching the geometry, and it is why the mesh's
 * `frustumCulled` must be off: the bounding box three sees is the flat
 * placeholder grid, not where the cloth actually ends up.
 *
 * ## What is different from the example, and why
 *
 * | Example | Here |
 * | --- | --- |
 * | `THREE.Timer` + `setAnimationLoop` | `update(delta)` — the caller owns the frame loop (R3F's `useFrame`), so the cloth has no opinion about time |
 * | Fixed 360 steps/second, hard-coded | `stepsPerSecond` option, same default |
 * | `springForceBuffer` sized `springCount * 3` | `springCount` — one vec3 per spring, which is all the shader indexes. The example's extra 2/3 is never read |
 * | Wireframe helpers always built | Built only when `wireframe: true` — they are the part of the example that is a debug view rather than the cloth, and they are the part this port cannot verify headlessly |
 * | The sphere is unconditional | Optional, on by default — the collision in the vertex pass reads `sphereUniform`, which is 0 when the sphere is off, so the two always agree |
 * | The sphere drifts on the example's two sines | It **follows the player**, so walking through the cloth drags it over the sphere. The drift is gone; a caller that supplies no `getPlayerPosition` gets a sphere parked where the cloth hangs |
 *
 * The transmission material needs a **storage buffer readable from the vertex
 * stage**, which is not a WebGPU default: the renderer must be created with
 * `requiredLimits: { maxStorageBuffersInVertexStage: 1 }` or the cloth's pipeline
 * cannot be built. That is the one change outside this file; see `CanvasGPU`.
 *
 * ## Usage
 *
 * ```ts
 * const cloth = createCloth({ position: [2, 1.5, 0] })
 * scene.add(cloth.object3D)
 * // each frame
 * cloth.update(delta)
 * ```
 *
 * Nothing here touches the scene or the renderer: `createCloth` builds the
 * object and returns a handle, so the caller decides where it lives and owns its
 * lifetime (`dispose`).
 */

import {
    BufferAttribute,
    BufferGeometry,
    Group,
    IcosahedronGeometry,
    InstancedBufferGeometry,
    Line,
    Mesh,
    PlaneGeometry,
    Vector3,
} from 'three'
import { DoubleSide, LineBasicNodeMaterial, MeshStandardNodeMaterial, SpriteNodeMaterial } from 'three/webgpu'
import {
    Fn,
    If,
    Loop,
    Return,
    attribute,
    cross,
    float,
    instanceIndex,
    instancedArray,
    select,
    time,
    transformNormalToView,
    triNoise3D,
    uniform,
    vec3,
} from 'three/tsl'
import type { Node, WebGPURenderer } from 'three/webgpu'
import { TransmissionTSLMaterial, type TransmissionTSLParams } from './TransmissionTSLMaterial'

// ---------------------------------------------------------------------------
// Geometry attribute readers
// ---------------------------------------------------------------------------
// `attribute(name, nodeType)` loses its node type in the @types/three
// declaration — it collapses to `AttributeNode<unknown>`, which has no
// swizzles — and the cloth reads two packed id attributes straight out of its
// neighbours. The runtime node is exactly what `nodeType` says, so this
// restores the type without changing the value. Same gap, and the same fix, as
// `grassTSLMaterial.ts`.
const uvec4Attribute = (name: string) => attribute(name, 'uvec4') as unknown as Node<'uvec4'>
const uintAttribute = (name: string) => attribute(name, 'uint') as unknown as Node<'uint'>

/** How many simulation steps run per second of wall clock. Fixed so the cloth
 *  behaves the same at 60 and 144 Hz — the example's value. */
const DEFAULT_STEPS_PER_SECOND = 360

/** The largest frame the simulator will integrate in one call, in seconds. A
 *  tab that was backgrounded hands `useFrame` an enormous delta; without this
 *  cap the cloth would try to catch up thousands of steps in one frame and lock
 *  the tab. The example caps at the same 1/60. */
const MAX_FRAME_DELTA = 1 / 60

/** A spring's length is used as a divisor, so it is floored short of zero rather
 *  than guarded — two verlet vertices can land on the same point, and the force
 *  that should push them apart is undefined there. */
const MIN_SPRING_LENGTH = 0.000001

/** How fast the sphere chases the player, in metres per second. Well clear of
 *  the player's own 8 m/s sprint, so normal movement is tracked with no
 *  meaningful lag, while a respawn's teleport still crosses the gap over a
 *  fraction of a second rather than in one step. */
const DEFAULT_SPHERE_FOLLOW_SPEED = 30

/** The example's numbers: a 1 m cloth in a 30 × 30 grid, draped over a 15 cm
 *  sphere, with the top edge pinned every fifth vertex. */
const DEFAULTS = {
    width: 1,
    height: 1,
    segmentsX: 30,
    segmentsY: 30,
    sphereRadius: 0.1,
} as const

export interface ClothOptions {
    /**
     * The renderer the compute passes are dispatched on.
     *
     * Required rather than looked up: the sim runs on the GPU, and only the
     * renderer can dispatch it. It must be the same renderer that draws the
     * cloth, or the two would be ordering their work on different queues.
     */
    renderer: WebGPURenderer
    /** Cloth size in world units. */
    width?: number
    height?: number
    /** Cells per side. The sim grid is this + 1 per side and the render grid is
     *  exactly this, so the vertex counts are `(segments + 1)²` and
     *  `segments²` respectively. Raising it is quadratic in everything. */
    segmentsX?: number
    segmentsY?: number
    /**
     * Where the cloth hangs, in world units.
     *
     * The verlet system is authored around the origin — x centred on 0, y from
     * `height / 2` down, z from 0 to `height` — so this is the world position of
     * that origin: the middle of the pinned top edge, at floor height. The
     * physics never leaves that local space; only the group is moved.
     */
    position?: [number, number, number]
    /** The collider sphere the cloth drapes over. */
    sphereRadius?: number
    /**
     * Where the player is, in **world** units — or null before there is a player
     * to ask (the crowd and the crates are wired the same way, from
     * `NavMeshRig`).
     *
     * It is a function rather than a vector because the player moves and this
     * module does not hold a reference to them: it is called once per `update`,
     * and the result is converted into the cloth's own space, which is where the
     * simulation lives. Omit it and the sphere simply stays where it is.
     *
     * A teleport — a respawn, or `placePlayer` resolving late — is absorbed by
     * the follow's smoothing rather than being applied as one enormous shove.
     */
    getPlayerPosition?: () => Vector3 | null
    /**
     * Added to the player's position before it is converted, in world units —
     * which point on the player the sphere tracks. Default `[0, 2, 0]`: their
     * chest, two metres above the feet the position is reported at.
     *
     * The height matters because the cloth can only react to a sphere it
     * reaches. The simulation is authored around the group's origin with the
     * pinned edge half a metre above it, so a sphere at the player's feet sits
     * a metre and a half below that edge — likely below the hem, and out of
     * contact entirely. Aim this at wherever the cloth hangs.
     */
    playerOffset?: [number, number, number]
    /** Draw the verlet system's wireframe instead of the cloth. Off by default:
     *  it is a debug view, and it is built only when requested, so the default
     *  path never pays for it. */
    wireframe?: boolean
    /** Simulation steps per second of wall clock. */
    stepsPerSecond?: number
    /** How fast the sphere may chase the player, in metres per second. Live;
     *  see `ClothParams`. */
    sphereFollowSpeed?: number
    /** Knobs for the cloth's `TransmissionTSLMaterial`. */
    material?: TransmissionTSLParams
}

export interface ClothParams {
    /** Show the verlet wireframe instead of the cloth. Built on first use. */
    wireframe: boolean
    /** Whether the sphere is drawn *and* collides. */
    sphere: boolean
    /** Wind strength on the z axis. */
    wind: number
    /** Spring stiffness. The example's 0.2 barely holds the drape; 0.5 is stiff. */
    stiffness: number
    /** Velocity retention per step, 0..1. */
    dampening: number
    /**
     * How fast the sphere may close on the player, in metres per second.
     *
     * Above the player's own top speed — 4 m/s walking, 8 running here — the
     * sphere simply keeps up, and the only lag is the one simulation step it
     * takes to see the move: 2 cm at a sprint. That is the point of using a
     * speed rather than a smoothing factor, which would trail a walking player
     * by `speed × timeConstant` no matter how small the constant was set.
     *
     * Below it, the sphere trails: set this under the player's speed and the
     * cloth is dragged behind them instead of over them.
     *
     * What it bounds is the *teleport* — a respawn, or the start resolving late
     * — which crosses at this speed rather than arriving as one shove. 0 pins
     * the sphere in place.
     */
    sphereFollowSpeed: number
}

export interface ClothHandle {
    /** Add this to the scene. Holds the cloth, the sphere, and the wireframe. */
    object3D: Group
    /** Live knobs. Every one is read by the next step or frame — no rebuild. */
    params: ClothParams
    /** The cloth mesh, for callers that want to reach its material. */
    mesh: Mesh
    /**
     * Advance the simulation by `delta` seconds and leave it renderable.
     *
     * Runs whole fixed steps only, carrying the remainder in a fraction of a
     * step, so the sim's behaviour does not depend on the frame rate. Safe to
     * call with any delta (it is clamped) and cheap when the delta is small.
     */
    update: (delta: number) => void
    /** Stop simulating and release the geometries and materials. */
    dispose: () => void
}

/** A verlet vertex of the simulation grid. */
interface VerletVertex {
    id: number
    position: Vector3
    /** Pinned: never integrated, and never has springs walked for it. */
    isFixed: boolean
    /** Ids of the springs touching this vertex, in global spring order. */
    springIds: number[]
}

/** A spring between two verlet vertices, with the length it pulls back to. */
interface VerletSpring {
    id: number
    vertex0: VerletVertex
    vertex1: VerletVertex
}

/**
 * Build the verlet grid and its springs.
 *
 * Springs are added in a fixed pass over the grid — right, down, and both
 * diagonals — which is what gives the cloth shear resistance. The example notes
 * a second-order pass (skipping every other vertex) makes it more rigid; it is
 * left out here as it was there.
 */
function buildVerletSystem(width: number, height: number, segmentsX: number, segmentsY: number) {
    const vertices: VerletVertex[] = []
    const springs: VerletSpring[] = []
    const columns: VerletVertex[][] = []

    const addVertex = (x: number, y: number, z: number, isFixed: boolean) => {
        const vertex: VerletVertex = { id: vertices.length, position: new Vector3(x, y, z), isFixed, springIds: [] }
        vertices.push(vertex)
        return vertex
    }

    const addSpring = (vertex0: VerletVertex, vertex1: VerletVertex) => {
        const id = springs.length
        vertex0.springIds.push(id)
        vertex1.springIds.push(id)
        springs.push({ id, vertex0, vertex1 })
    }

    for (let x = 0; x <= segmentsX; x++) {
        const column: VerletVertex[] = []

        for (let y = 0; y <= segmentsY; y++) {
            const posX = x * (width / segmentsX) - width * 0.5
            const posZ = y * (height / segmentsY)

            // Pin the top edge, but only every fifth vertex — pinning all of it
            // makes a flat sheet that cannot move, and pinning one is a pendulum.
            const isFixed = y === 0 && x % 5 === 0

            column.push(addVertex(posX, height * 0.5, posZ, isFixed))
        }

        columns.push(column)
    }

    for (let x = 0; x <= segmentsX; x++) {
        for (let y = 0; y <= segmentsY; y++) {
            const vertex0 = columns[x][y]

            if (x > 0) addSpring(vertex0, columns[x - 1][y])
            if (y > 0) addSpring(vertex0, columns[x][y - 1])
            if (x > 0 && y > 0) addSpring(vertex0, columns[x - 1][y - 1])
            if (x > 0 && y < segmentsY) addSpring(vertex0, columns[x - 1][y + 1])
        }
    }

    return { vertices, springs, columns }
}

/**
 * Create a GPU verlet cloth.
 *
 * The verlet buffers and the render mesh are built here, synchronously. Nothing
 * is added to the scene — the returned handle's `object3D` is the caller's to
 * place.
 */
export function createCloth(options: ClothOptions): ClothHandle {
    const { renderer, getPlayerPosition } = options
    const width = options.width ?? DEFAULTS.width
    const height = options.height ?? DEFAULTS.height
    const segmentsX = options.segmentsX ?? DEFAULTS.segmentsX
    const segmentsY = options.segmentsY ?? DEFAULTS.segmentsY
    const sphereRadius = options.sphereRadius ?? DEFAULTS.sphereRadius

    const { vertices, springs, columns } = buildVerletSystem(width, height, segmentsX, segmentsY)

    const vertexCount = vertices.length
    const springCount = springs.length

    // --- verlet vertex buffers ------------------------------------------------
    // `instancedArray` is three's storage-buffer node: the sim reads and writes
    // these on the GPU, and the render pass reads the positions back in its
    // vertex shader. `setPBO` is a hint for the WebGL fallback (it keeps a
    // parallel CPU copy); on WebGPU it is inert but harmless, and the example
    // sets it on the same buffers.
    const vertexPositionArray = new Float32Array(vertexCount * 3)

    // Three uints per vertex: isFixed, springCount, springPointer — the index of
    // this vertex's first spring in the flat spring list below. A fixed vertex
    // keeps zeros for the last two, which is correct *because* the vertex pass
    // returns early for it: those fields are never read.
    const vertexParamsArray = new Uint32Array(vertexCount * 3)

    // Every vertex's springs, concatenated. Vertices are grouped by id, which is
    // what makes `springPointer + springCount` a contiguous run for one vertex.
    const springListArray: number[] = []

    for (let i = 0; i < vertexCount; i++) {
        const vertex = vertices[i]

        vertexPositionArray[i * 3] = vertex.position.x
        vertexPositionArray[i * 3 + 1] = vertex.position.y
        vertexPositionArray[i * 3 + 2] = vertex.position.z
        vertexParamsArray[i * 3] = vertex.isFixed ? 1 : 0

        if (vertex.isFixed === false) {
            vertexParamsArray[i * 3 + 1] = vertex.springIds.length
            vertexParamsArray[i * 3 + 2] = springListArray.length
            springListArray.push(...vertex.springIds)
        }
    }

    const vertexPositionBuffer = instancedArray(vertexPositionArray, 'vec3').setPBO(true)
    const vertexForceBuffer = instancedArray(vertexCount, 'vec3')
    const vertexParamsBuffer = instancedArray(vertexParamsArray, 'uvec3')
    const springListBuffer = instancedArray(new Uint32Array(springListArray), 'uint').setPBO(true)

    // --- spring buffers -------------------------------------------------------
    const springVertexIdArray = new Uint32Array(springCount * 2)
    const springRestLengthArray = new Float32Array(springCount)

    for (let i = 0; i < springCount; i++) {
        const spring = springs[i]

        springVertexIdArray[i * 2] = spring.vertex0.id
        springVertexIdArray[i * 2 + 1] = spring.vertex1.id
        springRestLengthArray[i] = spring.vertex0.position.distanceTo(spring.vertex1.position)
    }

    const springVertexIdBuffer = instancedArray(springVertexIdArray, 'uvec2').setPBO(true)
    const springRestLengthBuffer = instancedArray(springRestLengthArray, 'float')
    // One vec3 per spring. The example allocates `springCount * 3` here — three
    // vec3s per spring — but only ever indexes by spring id, so the extra two
    // thirds are never read; this allocates what is used.
    const springForceBuffer = instancedArray(springCount, 'vec3').setPBO(true)

    // --- uniforms -------------------------------------------------------------
    const dampeningUniform = uniform(0.99)
    const spherePositionUniform = uniform(new Vector3(0, 0, 0))
    const sphereUniform = uniform(1.0)
    const windUniform = uniform(1.0)
    const stiffnessUniform = uniform(0.2)

    const params: ClothParams = {
        wireframe: options.wireframe ?? false,
        sphere: true,
        wind: 1.0,
        stiffness: 0.2,
        dampening: 0.99,
        sphereFollowSpeed: options.sphereFollowSpeed ?? DEFAULT_SPHERE_FOLLOW_SPEED,
    }

    // --- the two compute passes ----------------------------------------------
    // Step 1 of a verlet step: every spring's force, from how far it is stretched
    // past its rest length. Runs per spring, in parallel, and writes the force
    // for step 2 to consume — the two cannot be merged, because a vertex's force
    // is the sum over springs that other threads are computing.
    const computeSpringForces = Fn(() => {
        const vertexIds = springVertexIdBuffer.element(instanceIndex)
        const restLength = springRestLengthBuffer.element(instanceIndex)

        const vertex0Position = vertexPositionBuffer.element(vertexIds.x)
        const vertex1Position = vertexPositionBuffer.element(vertexIds.y)

        const delta = vertex1Position.sub(vertex0Position).toVar()
        const dist = delta.length().max(MIN_SPRING_LENGTH).toVar()

        // Hooke's law along the spring's axis. The 0.5 is split between the two
        // ends — each vertex is credited half the force, and step 2 adds the
        // other half back with the opposite sign.
        const force = dist.sub(restLength).mul(stiffnessUniform).mul(delta).mul(0.5).div(dist)

        springForceBuffer.element(instanceIndex).assign(force)
    })()
        .compute(springCount)
        .setName('Cloth Spring Forces')

    // Step 2: each vertex, from all its springs plus gravity, wind and the
    // sphere. Writes the new position, which is what makes this a verlet
    // integrator — the "velocity" is the per-step delta held in the force buffer,
    // scaled down by the dampening each step.
    const computeVertexForces = Fn(() => {
        const vertexParams = vertexParamsBuffer.element(instanceIndex).toVar()
        const isFixed = vertexParams.x
        const springCountForVertex = vertexParams.y
        const springPointer = vertexParams.z

        If(isFixed, () => {
            Return()
        })

        const position = vertexPositionBuffer.element(instanceIndex).toVar('vertexPosition')
        const force = vertexForceBuffer.element(instanceIndex).toVar('vertexForce')

        force.mulAssign(dampeningUniform)

        // Walk this vertex's contiguous run of springs. `select` picks the sign:
        // a spring credits this vertex positively if it is the spring's first
        // endpoint, negatively if it is the second — which is what keeps the
        // forces equal and opposite.
        const pointerStart = springPointer.toVar('pointerStart')
        const pointerEnd = pointerStart.add(springCountForVertex).toVar('pointerEnd')

        Loop({ start: pointerStart, end: pointerEnd, type: 'uint', condition: '<' }, ({ i }) => {
            const springId = springListBuffer.element(i).toVar('springId')
            const springForce = springForceBuffer.element(springId)
            const springVertexIds = springVertexIdBuffer.element(springId)

            const sign = select(springVertexIds.x.equal(instanceIndex), 1.0, -1.0)

            force.addAssign(springForce.mul(sign))
        })

        // Gravity, in the same units as the forces above — small numbers, because
        // the integration step is a fraction of a second.
        force.y.subAssign(0.00005)

        // Wind: 3D simplex noise sampled at the vertex's own position, walked by
        // time. The 0.2 offset keeps the field from being centred on zero, so it
        // pushes more than it pulls. Only the z axis is used — a wind that moved
        // the cloth sideways would fight the drape.
        const noise = triNoise3D(position, 1, time).sub(0.2).mul(0.0001)
        force.z.subAssign(noise.mul(windUniform))

        // Sphere collision: below the surface, push straight out along the
        // radius, scaled by how far inside the vertex is. `max(0)` is what makes
        // it one-way — a vertex outside the sphere is untouched, so this is a
        // contact, not a field.
        const sphereDelta = position.add(force).sub(spherePositionUniform)
        const sphereDistance = sphereDelta.length()
        const sphereForce = float(sphereRadius)
            .sub(sphereDistance)
            .max(0)
            .mul(sphereDelta)
            .div(sphereDistance)
            .mul(sphereUniform)

        force.addAssign(sphereForce)

        vertexForceBuffer.element(instanceIndex).assign(force)
        vertexPositionBuffer.element(instanceIndex).addAssign(force)
    })()
        .compute(vertexCount)
        .setName('Cloth Vertex Forces')

    // --- the visible cloth ----------------------------------------------------
    // One render vertex per *cell*: its position is the average of the four
    // verlet vertices at that cell's corners, and its normal is the cross of the
    // two cell diagonals. `vertexIds` carries those four ids to the GPU, so the
    // render mesh never has to be updated on the CPU.
    const cellCount = segmentsX * segmentsY
    const clothGeometry = new BufferGeometry()

    const verletVertexIdArray = new Uint32Array(cellCount * 4)
    const clothIndices: number[] = []

    const cellIndex = (x: number, y: number) => y * segmentsX + x

    for (let x = 0; x < segmentsX; x++) {
        for (let y = 0; y < segmentsY; y++) {
            const index = cellIndex(x, y)

            verletVertexIdArray[index * 4] = columns[x][y].id
            verletVertexIdArray[index * 4 + 1] = columns[x + 1][y].id
            verletVertexIdArray[index * 4 + 2] = columns[x][y + 1].id
            verletVertexIdArray[index * 4 + 3] = columns[x + 1][y + 1].id

            // Two triangles per interior cell. The x === 0 / y === 0 row is
            // skipped because a quad there would index the previous cell's
            // vertices — the border cells have no quad behind them.
            if (x > 0 && y > 0) {
                clothIndices.push(cellIndex(x, y), cellIndex(x - 1, y), cellIndex(x - 1, y - 1))
                clothIndices.push(cellIndex(x, y), cellIndex(x - 1, y - 1), cellIndex(x, y - 1))
            }
        }
    }

    // A `position` attribute is required for the geometry to draw at all, even
    // though the position node replaces every value — three reads it for the
    // bounding sphere and the draw range.
    clothGeometry.setAttribute('position', new BufferAttribute(new Float32Array(cellCount * 3), 3, false))
    clothGeometry.setAttribute('vertexIds', new BufferAttribute(verletVertexIdArray, 4, false))
    clothGeometry.setIndex(clothIndices)

    const clothMaterial: TransmissionTSLMaterial = new TransmissionTSLMaterial({
        // Glass over a draped sheet: thin, smooth, and mostly transparent, with
        // the chromatic fringe turned up enough to read on the folds.
        thickness: 0.08,
        roughness: 0.05,
        ior: 1.5,
        transmission: 1,
        attenuationColor: '#ffffff',
        attenuationDistance: Infinity,
        chromaticAberration: 0.06,
        anisotropicBlur: 0.1,
        ...options.material,
    })

    // DoubleSide because a cloth has no inside: the folds turn both faces to the
    // camera. The transmission reads the opaque viewport for a front face, which
    // is what a DoubleSide material resolves to.
    clothMaterial.side = DoubleSide

    clothMaterial.positionNode = Fn(({ material }: { material: any }) => {
        // The four verlet vertices at this cell's corners — a uvec4 of ids, which
        // is what `element()` below needs as an index.
        const vertexIds = uvec4Attribute('vertexIds')

        const v0 = vertexPositionBuffer.element(vertexIds.x).toVar()
        const v1 = vertexPositionBuffer.element(vertexIds.y).toVar()
        const v2 = vertexPositionBuffer.element(vertexIds.z).toVar()
        const v3 = vertexPositionBuffer.element(vertexIds.w).toVar()

        // The cell's two diagonals, which give both the centre and the normal.
        const top = v0.add(v1)
        const right = v1.add(v3)
        const bottom = v2.add(v3)
        const left = v0.add(v2)

        const tangent = right.sub(left).normalize()
        const bitangent = bottom.sub(top).normalize()

        // The normal is computed per *vertex*, so it has to be handed to the
        // fragment stage explicitly — three's automatic normal attribute is the
        // flat placeholder grid's, which has nothing to do with where the cloth
        // is. `material.normalNode` is the hook for that.
        //
        // A `Fn` whose callback takes one argument is handed the **node
        // builder** (`TSLCore.js`: `jsFunc( secureNodeBuilder )`), so destructuring
        // `material` off it reads `builder.material` — the material being built —
        // and the assignment lands on this material. There is no other channel
        // from a position node back to its own material.
        material.normalNode = transformNormalToView(cross(tangent, bitangent)).toVarying()

        return v0.add(v1).add(v2).add(v3).mul(0.25)
    })()

    const clothMesh = new Mesh(clothGeometry, clothMaterial)
    // The placeholder positions are a flat sheet at the origin; the cloth is not.
    clothMesh.frustumCulled = false

    // --- the sphere it drapes over -------------------------------------------
    const sphere = new Mesh(new IcosahedronGeometry(sphereRadius * 0.95, 4), new MeshStandardNodeMaterial())
    sphere.frustumCulled = false

    // --- wireframe debug view (opt-in) ---------------------------------------
    // Two visualisers of the sim: a point per verlet vertex, and a line per
    // spring. Both read the same storage buffers the compute passes write, which
    // is why they only make sense with the cloth hidden.
    const wireframeGroup = new Group()
    wireframeGroup.visible = false

    let wireframeBuilt = false

    const buildWireframe = () => {
        if (wireframeBuilt) return

        const vertexMaterial = new SpriteNodeMaterial()
        vertexMaterial.positionNode = vertexPositionBuffer.element(instanceIndex)

        const vertexPoints = new Mesh(new PlaneGeometry(0.01, 0.01), vertexMaterial)
        vertexPoints.frustumCulled = false
        vertexPoints.count = vertexCount

        const linePosition = new BufferAttribute(new Float32Array(6), 3, false)
        const lineVertexIndex = new BufferAttribute(new Uint32Array([0, 1]), 1, false)

        const lineMaterial = new LineBasicNodeMaterial()
        lineMaterial.positionNode = Fn(() => {
            const vertexIds = springVertexIdBuffer.element(instanceIndex)
            // Each of the line's two vertices has to pick a *different* end of
            // its spring; `vertexIndex` is which end this invocation is.
            const vertexIndex = uintAttribute('vertexIndex')
            const vertexId = select(vertexIndex.equal(0), vertexIds.x, vertexIds.y)
            return vertexPositionBuffer.element(vertexId)
        })()

        const lineGeometry = new InstancedBufferGeometry()
        lineGeometry.setAttribute('position', linePosition)
        lineGeometry.setAttribute('vertexIndex', lineVertexIndex)
        // three's WebGPU path reads `instanceCount` directly, so it has to be
        // set — a plain BufferGeometry would infer the count from the attribute
        // lengths, which here describe one line.
        lineGeometry.instanceCount = springCount

        const springLines = new Line(lineGeometry, lineMaterial)
        springLines.frustumCulled = false
        springLines.count = springCount

        wireframeGroup.add(vertexPoints, springLines)
        wireframeBuilt = true
    }

    if (params.wireframe) {
        buildWireframe()
        wireframeGroup.visible = true
    }

    // --- the object ----------------------------------------------------------
    const object3D = new Group()
    object3D.name = 'cloth'
    object3D.add(clothMesh, sphere, wireframeGroup)

    if (options.position) {
        object3D.position.fromArray(options.position)
    }

    // --- stepping -------------------------------------------------------------
    const stepsPerSecond = options.stepsPerSecond ?? DEFAULT_STEPS_PER_SECOND
    const timePerStep = 1 / stepsPerSecond

    /** Where the sphere is chasing this frame, in this group's local space —
     *  the space the simulation lives in. Recomputed once per `update`, valid
     *  only while `hasTarget`. */
    const target = new Vector3()
    /** Whether `target` was refreshed from a player this frame. */
    let hasTarget = false
    /** Whether the sphere has ever taken up a player position. The first one is
     *  adopted outright rather than chased — see the snap in `update`. */
    let snapped = false
    /** Scratch for the read, so the per-frame conversion allocates nothing. */
    const playerWorld = new Vector3()
    const playerOffset = new Vector3().fromArray(options.playerOffset ?? [0, 0, 0])
    /** Scratch for the chase — the vector from the sphere to its target. */
    const toTarget = new Vector3()

    /** Wall-clock seconds not yet consumed by a whole step. */
    let carry = 0
    let disposed = false

    const update = (delta: number) => {
        if (disposed) return

        // Applied on every call, ahead of the step guard below: these are render
        // state, not physics, and a GUI toggle should land on the frame it is
        // flipped rather than on the next whole simulation step. The wireframe is
        // built on the first call that asks for it and then reused, so the
        // default path never pays for the storage-buffer reads it does.
        if (params.wireframe === true && wireframeBuilt === false) {
            buildWireframe()
        }

        wireframeGroup.visible = params.wireframe
        clothMesh.visible = params.wireframe === false

        // The sphere is the collision's other half: switching it off has to stop
        // the force as well as hide the mesh, or the cloth would drape over
        // nothing.
        sphere.visible = false // params.sphere
        sphereUniform.value = params.sphere ? 1 : 0

        // Where the sphere is headed, read once here rather than per step: the
        // player's position is a frame-rate quantity, and the local-space
        // conversion costs a matrix inverse. The *chase* stays in the step loop
        // below, because it is part of the simulation's state.
        hasTarget = false

        if (getPlayerPosition) {
            const reported = getPlayerPosition()

            if (reported) {
                // The group's own matrix has to be current before converting
                // into its space: `update` runs before the render pass, so the
                // matrix would otherwise be last frame's. One frame stale is
                // invisible for the cloth, but it is not invisible on the first
                // frame, when the matrix is still the identity.
                object3D.updateWorldMatrix(true, false)

                playerWorld.copy(reported).add(playerOffset)
                target.copy(playerWorld)
                object3D.worldToLocal(target)

                hasTarget = true

                if (snapped === false) {
                    // The first position is adopted outright. Chasing it from
                    // the sphere's starting spot inside the cloth would drag the
                    // sheet across the whole distance to the player on the first
                    // frame — a visible whip, and a pointless one.
                    sphere.position.copy(target)
                    snapped = true
                }
            }
        }

        // Clamp first: a backgrounded tab's first frame back can carry seconds of
        // delta, and the loop below would try to run every one of them.
        carry += Math.min(delta, MAX_FRAME_DELTA)

        if (carry < timePerStep) return

        // How far the sphere may travel this step. Derived from the step rather
        // than the frame, so the chase is the same speed at 60 and 144 Hz.
        const maxStep = params.sphereFollowSpeed * timePerStep

        while (carry >= timePerStep) {
            carry -= timePerStep

            if (hasTarget) {
                // Chased at a bounded speed rather than lerped towards: a lerp
                // leaves a standing offset behind anything that moves — at 4 m/s
                // a 0.12 s constant trails the player by half a metre — where a
                // speed above the player's own closes that to one step's worth
                // while still spending a teleport over several frames.
                toTarget.copy(target).sub(sphere.position)

                const gap = toTarget.length()

                if (gap > 0) {
                    // `min` by hand rather than `Math.min` with the vector: this
                    // is the whole of the clamp.
                    const travel = Math.min(gap, maxStep)
                    sphere.position.addScaledVector(toTarget, travel / gap)
                }
            }

            // The uniform is what the collision reads, so it is written every
            // step whether or not the sphere moved — a sphere switched off and
            // back on must not leave a stale position in the shader.
            spherePositionUniform.value.lerp(sphere.position, 0.05)

            // Read by the next step, so the GUI's value lands on the sim rather
            // than after it.
            stiffnessUniform.value = params.stiffness
            dampeningUniform.value = params.dampening
            windUniform.value = params.wind

            // `compute` returns a promise only before the renderer has
            // initialised; the dispatch itself is ordered on the renderer's own
            // queue, so the steps below cannot overtake the ones above.
            renderer.compute(computeSpringForces)
            renderer.compute(computeVertexForces)
        }
    }

    const dispose = () => {
        if (disposed) return
        disposed = true

        object3D.removeFromParent()

        clothGeometry.dispose()
        clothMaterial.dispose()

        sphere.geometry.dispose()
        sphere.material.dispose()

        wireframeGroup.traverse((child) => {
            const withGeometry = child as Mesh | Line
            withGeometry.geometry?.dispose()
            const material = (child as Mesh).material
            if (Array.isArray(material)) material.forEach((entry) => entry.dispose())
            else material?.dispose()
        })

        // The storage buffers are owned by their nodes, which go with the
        // geometry and materials above; three releases the GPU-side allocation
        // when the node is no longer referenced.
    }

    return { object3D, params, mesh: clothMesh, update, dispose }
}
