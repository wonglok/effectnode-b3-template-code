import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Object3D, Vector3 } from 'three'
import { createCloth, type ClothOptions, type PinCircle } from './shader/cloth'

// ---------------------------------------------------------------------------
// The cape
// ---------------------------------------------------------------------------
// The GPU verlet cloth from `shader/cloth.ts`, hung: its top edge is pinned in a
// **ring around a centre point** and the sheet drapes down from there.
//
// The simulation runs in **world space**, not parented to anything. The pins are
// *placed* on the ring every step, which is what makes the cloth a world-space
// sheet carried around by its top edge: dragged along, it lags behind, swings on
// turns and settles when it stops — with no pseudo-force to fake any of it. That
// behaviour is available to whatever moves the centre; today nothing does, and
// the cape simply hangs where it is placed.
//
// ## Where the cape hangs
//
// The ring is centred on `CAPE_CENTRE`, an `Object3D` sitting at **`(0, 2, 0)`**
// in plain world coordinates. Nothing about the cape is read from the player:
// there is no skeleton to resolve, no rig-root cache to invalidate and no bones
// to look up, so there is no dependence on an avatar having spawned either.
//
// That object is the whole input. Its position is the ring's centre and its yaw
// is the drape's facing — the arc's middle, the wind and the body collider are
// all derived from those two things — so moving or turning that one object moves
// and turns the cape, and hanging it from a character again is a matter of
// writing that body's centre and facing into it rather than rewriting the cape.
//
// ## Why the edge is an arc, and how much of the ring it takes
//
// The pinned edge follows the ring rather than cutting straight across it, so
// the sheet wraps the centre instead of hanging behind it as a flat plane. The
// one number that decides how far off the centre it stands is `anchorRadius`: at
// 0.75 m every point of the top edge is that far from the middle, and the sheet
// drapes down from the ring into a cloak with depth of its own.
//
// The arc does not have to close the ring, and its sweep is set directly in
// `readPinCircle` rather than derived here. Two landmarks are worth knowing:
// `width / radius` is the arc exactly as long as the sheet is wide — the one
// that neither gathers the top edge in nor stretches it — and 2π is a full turn,
// past which the edge overlaps its own start. Under a sweep shorter than the
// matching one the top edge is compressed and *stays* compressed, because the
// springs' rest lengths are measured where the grid was placed.
//
// Whatever the sweep, the arc is centred on the centre object's **back**, so the
// drape covers from behind and from either side, and nothing hangs in front.

/**
 * The point the cape hangs from: a plain `Object3D` at `(0, 2, 0)` — at the
 * world origin, two metres up, roughly shoulder height.
 *
 * It is never added to the scene graph; the cape reads its `position` and its
 * `rotation.y` and that is all it is for, so it never needs a parent, a matrix
 * update or a visible object. Its yaw is zero, which is the whole of the cape's
 * facing: the drape's arc is centred on its local `-Z` and the wind blows along
 * the same axis.
 */
const CAPE_CENTRE = new Object3D()
CAPE_CENTRE.position.set(0, 2, 0)

/**
 * Cape width, in world units — the sheet's size across its top edge. Wider than
 * the shoulders on purpose: a cape only as wide as the spacing of two arm bones
 * reads as a bib.
 *
 * It is also half of the arc that matches it exactly. A sweep of `width /
 * radius` is an arc precisely this long — the one that neither gathers the top
 * edge in nor stretches it — which is why that ratio is worth reaching for when
 * tuning the sweep in `readPinCircle`.
 */
const CAPE_WIDTH = 5

/**
 * The radius of the ring the cape hangs from, in world units — how far the
 * pinned edge stands off the centre at every point.
 *
 * This is the whole of the cape's stand-off from whatever is under it: the sheet
 * is placed on a circle this size around the centre and hangs from there, so it
 * starts clear and nothing has to push it out. It is also why the torso collider
 * below never touches the cloth — at this radius the drape is a good half-metre
 * outside it — and lowering this towards a body's own width is what would bring
 * the two back into contact.
 */
const CAPE_ANCHOR_RADIUS = 0.75

/**
 * Where the collider sits relative to the point the cape's ring is centred on,
 * in world units. Zero — on the attach point itself, which is the centre object,
 * already the chest. It used to be `[0, 1, 0]`, measured up from the feet: that
 * frame went away when the cape started hanging from the skeleton, and an offset
 * of one metre above a chest is a point above the head.
 *
 * A module constant rather than a literal in the props, because the cloth
 * rebuilds — losing the simulation — whenever this identity changes.
 */
const CAPE_PLAYER_OFFSET: [number, number, number] = [0, -0.125, 0.0]

/** Cape length in world units, hanging from the top edge: hip length on a 1.7 m
 *  body. */
const CAPE_LENGTH = 0.9

/** Cells per side. Denser than the demo cloth's 30 per metre in neither
 *  direction — the cape is a smaller sheet, so 24 cells is ~3 cm — and the
 *  pinned edge is a whole row here, so its resolution is the cape's silhouette. */
const CAPE_SEGMENTS = 36

// --- the ring, resolved and reused -------------------------------------------
// Module-level scratch, as the cloth's contract allows: `getPinCircle`'s result
// is read and copied synchronously, and this runs every frame.
const ANCHOR_CENTRE = new Vector3()
const ANCHOR_MIDDLE = new Vector3()
const ANCHOR_TANGENT = new Vector3()
const FORWARD = new Vector3()
const CENTRE = new Vector3()
// Its own vector rather than `FORWARD`, because the cloth reads the wind in the
// same frame as the ring: the facing is recomputed by whichever reads it, so
// negating in place would flip the ring's own axis out from under it.
const CAPE_WIND = new Vector3()

/**
 * The centre's facing, written into `FORWARD`.
 *
 * `CAPE_CENTRE` carries a yaw and nothing else — it is a plain object with no
 * rotation on the other two axes — and its local +Z is the direction the drape
 * is open towards. This one expression is therefore the whole of the cape's
 * rotation, and everything derived from it — the arc's middle, the back offset,
 * the wind — turns with it.
 */
function readFacing(centre: Object3D): Vector3 {
    return FORWARD.set(Math.sin(centre.rotation.y), 0, Math.cos(centre.rotation.y))
}

/**
 * The point the cape is attached to, written into `CENTRE`: the centre object's
 * own position, in world units.
 *
 * Both the ring and the body collider are built from it, so the two cannot
 * disagree about where the cape is — which they could while the collider tracked
 * a navmesh position and the ring tracked a skeleton. There is one source for
 * both now, and it is the same object the ring is centred on.
 */
function readCentre(centre: Object3D): Vector3 {
    return CENTRE.copy(centre.position)
}

/**
 * The ring the cape hangs from, in world units — read by the cloth once a frame.
 *
 * Built out of `CAPE_CENTRE` and nothing else: the centre is that object's
 * position, the plane is horizontal, and the arc's middle points straight out of
 * its **back**, so the drape ends up behind it and turns with it — the same
 * frame `readCapeWind` blows along. Nothing is parented and nothing is added to
 * the scene; the ring is arithmetic on one object's position and yaw.
 *
 * `span` is how much of the ring the pinned edge covers, in radians — set
 * directly rather than derived from the sheet's width, so the edge can be
 * gathered in (a sweep under `width / radius`) or wrapped past a full turn
 * (over 2π, where the edge overlaps its own start) instead of always matching
 * the grid.
 */
function readPinCircle(radius: number): PinCircle {
    ANCHOR_CENTRE.copy(readCentre(CAPE_CENTRE))
    ANCHOR_CENTRE.y += 1.1

    // Both directions come straight off `rotation.y` — one angle gives the pair,
    // rather than a facing read out of `readFacing` and a cross product taken
    // from it. The two are then a rigid quarter turn of the same angle: exactly
    // perpendicular and unit by construction, with nothing to normalise and
    // nothing read from the shared `FORWARD` scratch the wind writes later in
    // the same frame.
    const yaw = CAPE_CENTRE.rotation.y

    // Behind the centre. The arc is centred on this direction, so the cape hangs
    // behind it and turns with it.
    ANCHOR_MIDDLE.set(-Math.sin(yaw), 0, -Math.cos(yaw))

    // That angle opened a quarter turn: horizontal, perpendicular to `middle`,
    // and the direction `pinT` runs in — so the edge sweeps from one side of the
    // back to the other.
    ANCHOR_TANGENT.set(-Math.cos(yaw), 0, Math.sin(yaw))

    // A radius of zero divides into the span and leaves no ring to hang from, so
    // the degenerate case is floored rather than guarded.
    const safeRadius = radius * 12

    return {
        centre: ANCHOR_CENTRE,
        middle: ANCHOR_MIDDLE,
        tangent: ANCHOR_TANGENT,
        radius: safeRadius,
        span: Math.PI * 2,
    }
}

/**
 * The wind the cape is blown by: straight out of the centre's back, so the drape
 * is always pushed away from it.
 *
 * The cloth's default is a fixed world `-Z`, which is the one part of the
 * simulation that cannot follow a frame — gravity is world-down whoever is under
 * it and the springs only pull along themselves, but a wind direction is only
 * meaningful in a frame, and for a cape that frame is the centre's. Left in the
 * world's frame the cape reads as rotated with the world rather than with the
 * centre: turn 45° and the drape is still being blown along the old axis, turn
 * to `-Z` and it is blown against the front — a half-turn out.
 *
 * Straight out along the direction the arc is centred on (see `readPinCircle`),
 * which is what makes it a tailwind at every facing — and the reason the two are
 * built from the same facing rather than each deriving its own.
 */
function readCapeWind(): Vector3 {
    return CAPE_WIND.copy(readFacing(CAPE_CENTRE)).negate()
}

export interface ClothComponentProps extends Omit<
    ClothOptions,
    'renderer' | 'position' | 'getPinCircle' | 'getWindDirection'
> {
    /** Cape width in world units. Defaults to `CAPE_WIDTH` — this is also the
     *  length of the arc it hangs from, so the sheet is never gathered in at
     *  the top by an arc shorter than the grid. Widening it wraps more of the
     *  ring. */
    width?: number
    /** Radius of the ring the cape hangs from, in world units — how far its top
     *  edge stands off the centre. Defaults to `CAPE_ANCHOR_RADIUS`. */
    anchorRadius?: number
}

export function ClothComponent({
    width = CAPE_WIDTH,
    height = CAPE_LENGTH,
    anchorRadius = CAPE_ANCHOR_RADIUS,
    segmentsX = CAPE_SEGMENTS,
    segmentsY = CAPE_SEGMENTS,
    sphereRadius,
    wireframe,
    stepsPerSecond,
    sphereFollowSpeed,
    wind,
    playerOffset = CAPE_PLAYER_OFFSET,
    material,
}: ClothComponentProps) {
    const renderer = useThree((r) => r.gl)

    const cloth = useMemo(() => {
        return createCloth({
            // `gl` from R3F's store is the WebGPURenderer this scene draws with,
            // which is the one the compute passes must be dispatched on. R3F
            // declares `RootState['gl']` as the WebGL renderer regardless of what
            // the factory returned, so the cast goes through `unknown`.
            renderer: renderer as unknown as ClothOptions['renderer'],
            getPinCircle: () => readPinCircle(anchorRadius),
            // The wind follows the centre rather than the world — see
            // `readCapeWind`, which is the whole of "the cape turns with it".
            getWindDirection: readCapeWind,
            // Every vertex of the top edge, not the example's every fifth: a row
            // pinned sparsely sags between its pins and shows what it hangs from.
            pinEvery: 1,
            // The sheet's own size. How much of the ring the pins cover is
            // `readPinCircle`'s sweep, not this — a sweep of `width / radius` is
            // the one that matches the grid exactly, and anything under it
            // gathers the top edge in.
            width,
            height,
            segmentsX,
            segmentsY,
            sphereRadius,
            wireframe,
            stepsPerSecond,
            sphereFollowSpeed,
            wind,
            // The body, for the cape to slide over — the *same* point the cape's
            // ring is centred on, so the collider and the ring cannot disagree
            // about where the cape is. The sphere is hidden (`cloth.ts` hides the
            // mesh and keeps the force) because it stands in for the torso.
            getPlayerPosition: () => {
                let v = readCentre(CAPE_CENTRE)
                return v
            },
            playerOffset,
            material,
        })
    }, [
        renderer,
        width,
        height,
        anchorRadius,
        segmentsX,
        segmentsY,
        sphereRadius,
        wireframe,
        stepsPerSecond,
        sphereFollowSpeed,
        wind,
        playerOffset,
        // Must be a stable object. Built inline, it would rebuild the cloth —
        // and lose the simulation — on every render.
        material,
    ])

    useEffect(() => () => cloth?.dispose(), [cloth])

    // `delta` is seconds since the last frame, which the cloth turns into whole
    // fixed steps itself.
    useFrame((_state, delta) => {
        cloth?.update(delta)
    })

    // The cape is in world space — the pins carry it — so the group is left at
    // the origin and this is only ever about the object graph.
    return cloth ? <primitive object={cloth.object3D} /> : null
}
