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
 * | The sphere drifts on the example's two sines | It **follows the player**, so walking through the cloth drags it over the sphere: placed outright on the scene's player group, `SPHERE_PLAYER_OFFSET` above it, and off the optional `getPlayerPosition` callback when there is no player group to read — a caller that supplies neither gets a sphere parked where the cloth hangs |
 * | Pinned vertices are never touched after upload | `getPinCircle` **places** them, every step, on the circle they hang from — which is what lets the cloth be worn (`ClothComponent` hangs it in a ring around the avatar) instead of hanging in one spot. With no circle the pins are seeded onto their own authored row, so a static cloth behaves exactly as the example did |
 * | The wind always blows along the world's `-Z` | `getWindDirection` — read in the direction the caller gives it, defaulting to the example's `-Z`. A garment has to be blown along its **wearer's** back: with a fixed world direction a character who turns away from `-Z` gets a sidewind, and one who turns to face it gets a cape blown through their front |
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
    Color,
    Group,
    IcosahedronGeometry,
    InstancedBufferGeometry,
    Line,
    Mesh,
    type Object3D,
    PlaneGeometry,
    Quaternion,
    Vector3,
} from 'three'
import { DoubleSide, LineBasicNodeMaterial, MeshStandardNodeMaterial, SpriteNodeMaterial } from 'three/webgpu'
import {
    Fn,
    If,
    Loop,
    Return,
    attribute,
    color,
    cos,
    cross,
    float,
    instanceIndex,
    instancedArray,
    select,
    sin,
    time,
    transformNormalToView,
    triNoise3D,
    uniform,
} from 'three/tsl'
import type { Node, WebGPURenderer } from 'three/webgpu'
import { useGameGlobal } from '../../../../../../components/useGameGlobal'
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

/** Pin one vertex of the top edge in this many — the example's cadence, which
 *  leaves the sheet free to move under its own weight. 1 pins the whole edge,
 *  which is what a worn garment needs. */
const DEFAULT_PIN_EVERY = 5

/** How fast the sphere chases the player, in metres per second. Well clear of
 *  the player's own 8 m/s sprint, so normal movement is tracked with no
 *  meaningful lag, while a respawn's teleport still crosses the gap over a
 *  fraction of a second rather than in one step. */
const DEFAULT_SPHERE_FOLLOW_SPEED = 30

/**
 * Where the collider sphere sits relative to the player group's own position, in
 * world units — the offset the sphere is placed at when the scene has a player.
 *
 * The group's position is the player's feet on the navmesh, so this is chest
 * height on a 1.7 m body: the height the cloth's pinned edge hangs at, and the
 * part of the player a cloth would actually be draped over. Move it and the
 * collider follows — down towards the feet and the sphere drops below a hem it
 * was reaching, up towards the head and the cloth rides over a torso it misses.
 */
const SPHERE_PLAYER_OFFSET = new Vector3(0, 1.5, 0)

/** The example's numbers: a 1 m cloth in a 30 × 30 grid, draped over a 15 cm
 *  sphere, with the top edge pinned every fifth vertex. */
const DEFAULTS = {
    width: 1,
    height: 1,
    segmentsX: 24,
    segmentsY: 24,
    sphereRadius: 0.5,
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
     *
     * Only the **fallback**: while the scene has a player group to read (see
     * `SPHERE_PLAYER_OFFSET`) that group is what the sphere is placed on, and
     * this is never called. It is for a cloth with no player in the scene — a
     * bare demo, or a caller driving its own collider.
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
    /**
     * The circle the cloth hangs from, in **world** units — read every step, so
     * the cloth can be worn: this is what turns it into a cape on a moving
     * character, and the pins a static sheet never needed.
     *
     * The pinned edge is an **arc** of that circle, so the top of the sheet
     * curves instead of running straight: a ring of radius 0.75 m centred on a
     * character hangs the cloth around them rather than across them, and a ring
     * much larger than the sheet's width is the straight line the example had
     * (the curvature over the sheet is the bulge of a very flat arc — see
     * `FALLBACK_CIRCLE_RADIUS`).
     *
     * `middle` aims the arc and `tangent` opens it, both read relative to the
     * circle's centre: the edge runs from `-span / 2` to `+span / 2` about
     * `middle`, and the grid hangs down from it, so the sheet's surface ends up
     * in the plane those two directions span. `span` is what makes the arc
     * match the sheet — `width / radius` puts the pins on an arc exactly as long
     * as the grid is wide, and a shorter one pleats the top edge instead, which
     * is the same trade the line made.
     *
     * Read once per `update` and converted into the cloth's own space, so a
     * caller supplies **world** positions and does no maths. Null means "not yet"
     * — an avatar that has not spawned — and the pins then hold wherever they
     * last were, rather than snapping to the origin.
     *
     * The returned vectors are read and copied synchronously — a caller can
     * return the same scratch vectors every frame, and should, since this runs
     * sixty times a second.
     *
     * The initial buffer positions are placed on the first circle read, so a
     * cloth created with one already available starts life as a hanging sheet
     * instead of a horizontal one dragging itself into place. The centre is
     * world-space, so a pinned cloth's group should be left at the origin (or
     * given nothing but a translation) — and note that `middle` and `tangent`
     * are *directions*, so a group that is **rotated** would need them turned
     * into its frame first. No caller does that: the ring carries the position,
     * not the group.
     */
    getPinCircle?: () => PinCircle | null
    /**
     * Which way the wind pushes, in **world** units — read once per `update`
     * exactly like `getPinCircle`, and null means "no opinion, keep the last one".
     *
     * Omit it and the wind is the example's: a constant push along the world's
     * `-Z`. That is right for a sheet hanging in a scene and wrong for a garment,
     * because it is the one force in the simulation the cloth cannot work out
     * from the geometry. Gravity is world-down whatever the caller is doing, and
     * the springs only pull along themselves — but "which way the wind blows" is
     * only answerable in a frame, and for a cape that frame is the wearer's. Left
     * in the world's frame, a character who turns 180° gets a cape the wind holds
     * against their front: the drape reads as rotated a half-turn from the body.
     *
     * The direction should be a unit vector, and it should point *along* the
     * drape's normal rather than across it — a wind that pushed the cloth
     * sideways would slide the sheet rather than billow it. A cape's normal is
     * its wearer's facing, so the value to supply is their backward axis.
     * Magnitude is the `wind` knob's business, not this one's.
     */
    getWindDirection?: () => Vector3 | null
    /**
     * How often a vertex of the pinned edge is actually pinned, in vertices.
     * 5 is the example's: a flat sheet that can still move. 1 pins the whole
     * edge, which is what an attached garment needs — a row pinned every fifth
     * vertex sags between its pins and shows what it is hanging from.
     */
    pinEvery?: number
    /** Draw the verlet system's wireframe instead of the cloth. Off by default:
     *  it is a debug view, and it is built only when requested, so the default
     *  path never pays for it. */
    wireframe?: boolean
    /** Simulation steps per second of wall clock. */
    stepsPerSecond?: number
    /** How fast the sphere may chase the player, in metres per second. Live;
     *  see `ClothParams`. */
    sphereFollowSpeed?: number
    /** Wind strength. Live; see `ClothParams`. It scales the gusts, not the
     *  direction — that is `getWindDirection`'s. */
    wind?: number
    /** Knobs for the cloth's `TransmissionTSLMaterial`. */
    material?: TransmissionTSLParams
}

export interface ClothParams {
    /** Show the verlet wireframe instead of the cloth. Built on first use. */
    wireframe: boolean
    /** Whether the sphere is drawn *and* collides. */
    sphere: boolean
    /** Wind strength — the gusts' magnitude, along whatever direction
     *  `getWindDirection` supplies (world `-Z` without one). */
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
    /** Pinned: never integrated, and never has springs walked for it. Its
     *  position is *placed* on the pin circle every step instead. */
    isFixed: boolean
    /** Where along the pinned edge a vertex sits, 0..1 — an angle of the arc,
     *  from one end to the other. Meaningless (0) on the vertices that hang. */
    pinT: number
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
 * The circle a cloth hangs from, in world units.
 *
 * A circle rather than a line because the pinned edge of a *worn* cloth is
 * usually not straight: a cape that hangs across the shoulders is a chord, and a
 * cape that hangs *around* a body follows it. The straight line is still
 * expressible — it is the flat arc a very large `radius` gives — so nothing is
 * lost by having only this one shape.
 *
 * `middle` and `tangent` must be **unit** vectors and perpendicular to each
 * other: together with `centre` they are the circle's whole frame, and the
 * angle is measured from `middle` towards `tangent`. `radius` is the only
 * length, so the three vectors cannot disagree about the size the way a
 * pre-scaled pair could.
 */
export interface PinCircle {
    /** The circle's centre — the point every pinned vertex is `radius` from.
     *  For a worn cloth this is the body itself, which is what puts the ring
     *  around the character rather than beside them. */
    centre: Vector3
    /** Unit, in the circle's plane: from the centre to the **middle** of the
     *  pinned edge. Aims the arc — the edge's `pinT` 0.5 sits along it. */
    middle: Vector3
    /** Unit, in the circle's plane and perpendicular to `middle`: the direction
     *  the edge opens along, which is `pinT` running from 0 to 1. */
    tangent: Vector3
    /** The circle's radius, in world units. */
    radius: number
    /** How much of the circle the pinned edge covers, in radians. `width /
     *  radius` spreads the sheet over an arc exactly its own length; less
     *  gathers the top edge in, more stretches it. */
    span: number
}

/**
 * Radius the pins are seeded with when the caller supplies no circle: a ring so
 * large that the arc across the sheet is flat to a fraction of a millimetre, so
 * a bare cloth hangs exactly as the example's did.
 *
 * The curvature of an arc across a chord `w` is `w² / 8r`: a quarter of a
 * millimetre over a metre of sheet at this radius, which no caller can see.
 *
 * That is only true until float32 runs out, and it is the *sum* that decides
 * where it does. The placement is `centre + radius × (…)`, positions around a
 * kilometre from the origin, and float32 keeps about 0.06 mm of detail there —
 * so the quarter-millimetre arc is still resolved. Two orders larger and the
 * grid's own step exceeds 6 mm: the curvature would fall below the noise and
 * the pins would quantise onto a coarse lattice.
 */
const FALLBACK_CIRCLE_RADIUS = 1000

/** World down. The direction the placed grid's `z` is taken to mean. */
const DOWN = new Vector3(0, -1, 0)

/**
 * How far along the pinned edge an authored x sits, 0..1. The grid is authored
 * centred on zero, so this says which end of the edge a column belongs to.
 *
 * A width of zero would divide by it, so a degenerate caller gets the middle of
 * the edge rather than a NaN in the buffer — that NaN would spread to every
 * spring through the rest lengths and take the whole cloth with it.
 */
function edgeFraction(authored: Vector3, width: number): number {
    return width > 1e-6 ? (authored.x + width * 0.5) / width : 0.5
}

/**
 * Place one authored grid position on the pin circle: the x it was authored at
 * becomes an angle around the circle, and the z it was authored at becomes that
 * far *down* from it — which turns a grid authored lying flat into a sheet
 * hanging from the circle, without needing a rotation to say so.
 *
 * The authored `y` is dropped entirely: on the flat grid it is the constant
 * height the sheet lies at, and it has no meaning once the sheet hangs.
 *
 * This is the CPU twin of the placement the vertex pass makes every step and has
 * to stay one: the buffer seeded here is what the first step places from, so a
 * disagreement between them is a sheet that snaps on its first frame.
 */
function placeOnPinCircle(authored: Vector3, circle: PinCircle, width: number): Vector3 {
    const angle = (edgeFraction(authored, width) - 0.5) * circle.span

    return new Vector3()
        .copy(circle.middle)
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(circle.tangent, Math.sin(angle))
        .multiplyScalar(circle.radius)
        .add(circle.centre)
        .addScaledVector(DOWN, authored.z)
}

/**
 * The circle a cloth hangs from when its caller supplies none: a ring whose arc
 * over the sheet is the authored pin row, so an unpinned caller gets the flat
 * sheet the example built.
 *
 * It is centred one radius along `+Z` with `middle` pointing back at the row,
 * which puts the arc's midpoint — and so `pinT` 0.5 — exactly on the authored
 * row's midpoint, and the two ends within a fraction of a millimetre of the
 * row's own ends. `span` is the sheet's arc over that radius for the same
 * reason the caller's is: an arc longer or shorter than the sheet would gather
 * or stretch the top edge on the very first step.
 */
function fallbackCircle(width: number, height: number): PinCircle {
    return {
        centre: new Vector3(0, height * 0.5, FALLBACK_CIRCLE_RADIUS),
        middle: new Vector3(0, 0, -1),
        tangent: new Vector3(1, 0, 0),
        radius: FALLBACK_CIRCLE_RADIUS,
        span: width / FALLBACK_CIRCLE_RADIUS,
    }
}

/**
 * Build the verlet grid and its springs.
 *
 * Springs are added in a fixed pass over the grid — right, down, and both
 * diagonals — which is what gives the cloth shear resistance. The example notes
 * a second-order pass (skipping every other vertex) makes it more rigid; it is
 * left out here as it was there.
 *
 * The grid is authored in its own little space — x across the width, centred;
 * z from 0 at the pinned edge to `height` at the hem — and only the pinned row
 * has an obvious world position. Placing the rest is the caller's business via
 * `getPinCircle`, or nobody's at all for a free-hanging sheet.
 */
function buildVerletSystem(width: number, height: number, segmentsX: number, segmentsY: number, pinEvery: number) {
    const vertices: VerletVertex[] = []
    const springs: VerletSpring[] = []
    const columns: VerletVertex[][] = []

    const addVertex = (x: number, y: number, z: number, isFixed: boolean, pinT: number) => {
        const vertex: VerletVertex = {
            id: vertices.length,
            position: new Vector3(x, y, z),
            isFixed,
            pinT,
            springIds: [],
        }
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

            // Pin the top edge. Every fifth vertex by default — pinning all of
            // it makes a flat sheet that can barely move, and pinning one is a
            // pendulum; but a cape wants the whole edge held, so it passes 1.
            const isFixed = y === 0 && x % pinEvery === 0

            // Where along the edge this vertex sits. Taken from x rather than
            // from its index among the pins, so that a sparse pin row still
            // spreads evenly across the line instead of bunching at one end.
            const pinT = x / segmentsX

            column.push(addVertex(posX, height * 0.5, posZ, isFixed, pinT))
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
    const { renderer, getPlayerPosition, getPinCircle, getWindDirection } = options
    const width = options.width ?? DEFAULTS.width
    const height = options.height ?? DEFAULTS.height
    const segmentsX = options.segmentsX ?? DEFAULTS.segmentsX
    const segmentsY = options.segmentsY ?? DEFAULTS.segmentsY
    const sphereRadius = options.sphereRadius ?? DEFAULTS.sphereRadius

    const pinEvery = Math.max(1, Math.floor(options.pinEvery ?? DEFAULT_PIN_EVERY))

    const { vertices, springs, columns } = buildVerletSystem(width, height, segmentsX, segmentsY, pinEvery)

    const vertexCount = vertices.length
    const springCount = springs.length

    // With a pin circle, the whole sheet is placed hanging from it before
    // anything is uploaded: the pinned row onto the circle, and the rest of the
    // grid straight down from there. That is the difference between a cape that
    // is already around the character at the first frame and a horizontal sheet
    // near the origin that spends a second being dragged across the scene to it.
    //
    // It runs before the rest lengths below, and *is* what those are measured
    // on: the placement moves the very positions that loop reads, so the springs
    // come out at rest in the shape the grid was placed into. That is what makes
    // a cloth whose width does not match the arc it hangs from keep its pleats —
    // a top edge gathered in by a short arc *is* the shape it was built in,
    // rather than something the springs pull straight again.
    const pinCircle = getPinCircle?.() ?? null

    // The group's own origin, which a caller may have set. The placement above
    // works in world units because the circle is world; the buffer is local, so
    // the origin comes back off. Only valid for an untransformed group beyond a
    // translation — which is all this module's callers use, and all a pinned
    // cloth needs: it is the circle that carries the position, not the group.
    const groupOrigin = new Vector3().fromArray(options.position ?? [0, 0, 0])

    if (pinCircle) {
        for (const vertex of vertices) {
            const placed = placeOnPinCircle(vertex.position, pinCircle, width)
            vertex.position.copy(placed).sub(groupOrigin)
        }
    }

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

    // Where a pinned vertex sits along the pinned edge. One float per vertex,
    // read only by the pinned ones, which is why the rest can hold anything —
    // they hold 0, and nothing reads it.
    const vertexPinArray = new Float32Array(vertexCount)

    for (let i = 0; i < vertexCount; i++) {
        const vertex = vertices[i]

        vertexPositionArray[i * 3] = vertex.position.x
        vertexPositionArray[i * 3 + 1] = vertex.position.y
        vertexPositionArray[i * 3 + 2] = vertex.position.z
        vertexParamsArray[i * 3] = vertex.isFixed ? 1 : 0
        vertexPinArray[i] = vertex.pinT

        if (vertex.isFixed === false) {
            vertexParamsArray[i * 3 + 1] = vertex.springIds.length
            vertexParamsArray[i * 3 + 2] = springListArray.length
            springListArray.push(...vertex.springIds)
        }
    }

    const vertexPositionBuffer = instancedArray(vertexPositionArray, 'vec3').setPBO(true)
    const vertexForceBuffer = instancedArray(vertexCount, 'vec3')
    const vertexParamsBuffer = instancedArray(vertexParamsArray, 'uvec3')
    const vertexPinBuffer = instancedArray(vertexPinArray, 'float')
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
    // Which way the wind pushes, in the cloth's own space. The default is the
    // example's world `-Z` — out of the plane a free-hanging sheet drapes in —
    // and a caller with a frame of its own overrides it every frame through
    // `getWindDirection`.
    const windDirectionUniform = uniform(new Vector3(0, 0, -1))
    const objectQuaternion = new Quaternion()
    const stiffnessUniform = uniform(0.2)
    // The pin circle, in the cloth's own space, written from `getPinCircle`
    // every frame. Five uniforms rather than a packed pair, so the caller's
    // `PinCircle` maps onto them field for field and nothing has to be unpacked,
    // pre-scaled or re-derived on the way in.
    //
    // Without a caller's circle these are seeded with the *fallback* one — a
    // ring so large that its arc across the sheet is the authored pin row — for
    // the same reason the line version seeded from that row: the vertex pass
    // now places every pinned vertex rather than leaving it alone, so the seed
    // has to be a placement that puts each pin back where it already is. That is
    // the example's behaviour, kept.
    //
    // The centre is a *position*, so it comes off `groupOrigin` and will be
    // rotated into this group's space by `worldToLocal` when it is read; the two
    // directions are directions and are left alone.
    const seedCircle = pinCircle ?? fallbackCircle(width, height)

    const pinCentreUniform = uniform(seedCircle.centre.clone().sub(groupOrigin))
    const pinMiddleUniform = uniform(seedCircle.middle.clone())
    const pinTangentUniform = uniform(seedCircle.tangent.clone())
    const pinRadiusUniform = uniform(seedCircle.radius)
    const pinSpanUniform = uniform(seedCircle.span)

    const params: ClothParams = {
        wireframe: options.wireframe ?? false,
        sphere: true,
        wind: options.wind ?? 1.0,
        stiffness: 0.2,
        dampening: 0.975,
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
            // A pinned vertex is not integrated — it is *placed*, every step, on
            // the circle it hangs from. For the demo cloth that circle never
            // moves, which is why the example could leave the buffer alone and
            // return; a cape's ring is carried around the scene, and a pin that
            // only held its initial position would leave the cape behind.
            //
            // The arc, in the circle's own frame: `pinT` becomes an angle about
            // `middle`, and the point is that angle's cosine along `middle` plus
            // its sine along `tangent` — the two directions the caller gave, so
            // the edge opens exactly the way it asked for. Scaling that by the
            // radius is what makes it an arc of *this* circle rather than of the
            // unit one.
            //
            // `placeOnPinCircle` is the same expression on the CPU, and the two
            // have to stay one: this step places onto the buffer that seeding
            // filled, so a disagreement between them is a snap on the first
            // frame, before the cloth has done anything at all.
            const angle = vertexPinBuffer.element(instanceIndex).sub(0.5).mul(pinSpanUniform)

            vertexPositionBuffer
                .element(instanceIndex)
                .assign(
                    pinCentreUniform.add(
                        cos(angle).mul(pinMiddleUniform).add(sin(angle).mul(pinTangentUniform)).mul(pinRadiusUniform),
                    ),
                )

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
        // pushes more than it pulls — it is a *gust*, with a direction that
        // holds and a strength that wanders.
        //
        // `windDirectionUniform` is the direction it pushes in, and it is the
        // one force here that cannot be derived from the geometry: gravity is
        // world-down whoever the caller is, and the springs only pull along
        // themselves, but "which way the wind blows" needs a frame. The default
        // is the example's world -Z; a worn cloth reads its wearer's frame
        // instead (see `getWindDirection`), which is what keeps a cape on the
        // same side of its owner at every facing.
        const noise = triNoise3D(position, 1, time).sub(0.2).mul(0.0001)
        force.addAssign(windDirectionUniform.mul(noise.mul(windUniform)).mul(1.0))

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
        thickness: 0.95,
        roughness: 0.0,
        ior: 1.35,
        transmission: 1,
        attenuationColor: '#ffffff',
        attenuationDistance: Infinity,
        chromaticAberration: 0.06,
        anisotropicBlur: 0.1,
        ...options.material,
    })

    // clothMaterial.sheenNode = color(new Color('#ffffff'))
    // clothMaterial.colorNode = color(new Color('#ffffff'))
    clothMaterial.iridescence = 0.1
    clothMaterial.iridescenceIOR = 1.0

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
        material.normalNode = transformNormalToView(cross(tangent, bitangent)).toVarying().negate()

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
        // nothing. The mesh is hidden outright — it is a stand-in for the body,
        // not something to look at — while `params.sphere` still gates the
        // force, so that is the switch that matters.
        sphere.visible = false
        sphereUniform.value = params.sphere ? 1 : 0

        // The player, when the scene has one. Read once for the whole frame —
        // the group itself is stable, so this is a store lookup rather than a
        // subscription — and read *here* rather than further down because the
        // matrix guard below has to know whether the sphere will be converted
        // this frame.
        const playerGroup = useGameGlobal.getState().playerGroup as Object3D | null

        // Both readings below convert world positions into this group's space,
        // so its matrix has to be current first: `update` runs before the render
        // pass, which means the matrix would otherwise be last frame's. One
        // frame stale is invisible for a cloth, but it is not invisible on the
        // first frame, when the matrix is still the identity.
        if (playerGroup || getPlayerPosition || getPinCircle) {
            object3D.updateWorldMatrix(true, false)
        }

        // Where the sphere is headed, read once here rather than per step: the
        // player's position is a frame-rate quantity, and the local-space
        // conversion costs a matrix inverse. The *chase* stays in the step loop
        // below, because it is part of the simulation's state.
        hasTarget = false

        // The player group is where the sphere goes, then and there: its
        // position is the player's feet on the navmesh, so `SPHERE_PLAYER_OFFSET`
        // lifts it to the height the cloth hangs at.
        //
        // Set outright rather than chased, which is the one thing here that
        // differs from the callback path below: the sphere *is* the player's
        // torso, and a chase is a smoothing for something the cloth is being
        // draped over, not for the body itself — at a follow speed close to the
        // player's own it trails them by half a metre, and this is the collider
        // everything about contact is measured from. The cost is that
        // `sphereFollowSpeed` has nothing to do on this path, and that a
        // teleport lands in one frame rather than over several — which for a
        // body is what a teleport is.
        //
        // It also means the callback below is only for a cloth with no player
        // group to read — a bare demo, or a caller driving its own collider —
        // so the two are never both writing the sphere.
        if (playerGroup) {
            target.copy(playerGroup.position).add(SPHERE_PLAYER_OFFSET)
            object3D.worldToLocal(target)

            sphere.position.copy(target)
            hasTarget = true
        }

        if (getPlayerPosition && !playerGroup) {
            const reported = getPlayerPosition()

            if (reported) {
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

        // The circle the cloth hangs from — a ring around the body, for a cape.
        // Read once per frame for the same reason as the player, and left alone
        // when it reads null: the pins hold where they were rather than jumping
        // to the origin, so an avatar that has not spawned yet does not drag the
        // cloth across the scene and back.
        if (getPinCircle) {
            const circle = getPinCircle()

            if (circle) {
                // Position through `worldToLocal`, which is the whole point of
                // the guard above; directions copied straight across, because a
                // direction that is translated is not a direction any more. The
                // two lengths are plain floats and need neither.
                pinCentreUniform.value.copy(circle.centre)
                object3D.worldToLocal(pinCentreUniform.value)

                pinMiddleUniform.value.copy(circle.middle)
                pinTangentUniform.value.copy(circle.tangent)

                pinRadiusUniform.value = circle.radius
                pinSpanUniform.value = circle.span
            }
        }

        // Which way the wind blows, in the caller's frame — the wearer's back,
        // for a cape. A *direction*, so it is rotated into the cloth's space
        // rather than translated: the group's position must not leak into it.
        // Read after the line, which recomputes the facing both share.
        if (getWindDirection) {
            const direction = getWindDirection()

            if (direction) {
                object3D.getWorldQuaternion(objectQuaternion)
                windDirectionUniform.value.copy(direction).applyQuaternion(objectQuaternion.invert())
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
            spherePositionUniform.value.lerp(sphere.position, 1.0)

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
