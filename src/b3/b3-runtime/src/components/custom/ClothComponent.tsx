import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Vector3, type Bone, type Object3D } from 'three'
import { useGameGlobal } from '../../../../../components/useGameGlobal'
import { findBone } from '../AvatarSDK'
import { createCloth, type ClothOptions, type PinCircle } from './shader/cloth'

// ---------------------------------------------------------------------------
// The cape
// ---------------------------------------------------------------------------
// The GPU verlet cloth from `shader/cloth.ts`, worn: its top edge is pinned in a
// **ring around the character** at shoulder height and carried around the scene,
// so it trails when they run instead of hanging in one place.
//
// The simulation runs in **world space**, not in the avatar's. That is the whole
// design, and it is what makes the cape behave like a cape: with the cloth
// parented to a shoulder, the character would be stationary in its own frame and
// the sheet would just hang, however fast they ran. Holding the pins in world
// space means the cloth is genuinely dragged through the world by its top edge,
// so it lags behind, swings on turns and settles when they stop — with no
// pseudo-force to fake it.
//
// ## Where the cape hangs, and why the ring is centred on the hips
//
// The ring is **centred on the body's own root bone** — `Hips`, the bone every
// rig here roots at, which the rest of this project already depends on
// (`avatarLoader`, `headCompose`) — so it is centred on the character by
// construction rather than by the rig happening to agree.
//
// That is a deliberate choice over hanging it from the two shoulder bones, which
// is what a real cape does. A ring between `LeftArm` and `RightArm` puts the
// cape's centre wherever those two bones' midpoint happens to be — and there is
// no reason that is the body's centre: an arm bone carries the pose, the model
// may sit off its group's origin (each body has a placement offset in the
// manifest), and the midpoint of two bones is not a centre unless they are
// symmetrical. Taking the hips makes centring a property of the construction
// rather than of the rig agreeing with itself, which is why the cape can no
// longer come out off to one side.
//
// The height comes from `Spine2` — the chest — when the body has it, since that
// is body-scaled rather than a number guessed for a 1.7 m character, with a
// constant offset above the hips as the fallback.
//
// ## Why the edge is an arc, and how much of the ring it takes
//
// The pinned edge follows the ring rather than cutting straight across it, so
// the sheet wraps the body instead of hanging behind it as a flat plane. The one
// number that decides how far off the body it stands is `anchorRadius`: at
// 0.75 m every point of the top edge is that far from the body's midline, and
// the sheet drapes down from the ring into a cloak with depth of its own.
//
// The arc does not have to close the ring, and its sweep is set directly in
// `readPinCircle` rather than derived here. Two landmarks are worth knowing:
// `width / radius` is the arc exactly as long as the sheet is wide — the one
// that neither gathers the top edge in nor stretches it — and 2π is a full turn,
// past which the edge overlaps its own start. Under a sweep shorter than the
// matching one the top edge is compressed and *stays* compressed, because the
// springs' rest lengths are measured where the grid was placed.
//
// Whatever the sweep, the arc is centred on the character's **back**, so the
// drape covers them from behind and from either side, and nothing hangs in front
// of them.
//
// The bones are looked up once and cached: `findBone` is a traverse and this
// runs per frame. The cache is invalidated by the avatar being replaced — the
// rig root is a direct child of `playerGroup`, and a swapped-out one is detached
// from it.

/** Body root. The repo's rigs root at the hips — `avatarLoader` falls back to
 *  `findFirstBone` when even this is missing. */
const HIPS_BONES = ['mixamorig:Hips', 'Hips'] as const
/** The chest, used for the cape's height when present. */
const CHEST_BONES = ['mixamorig:Spine2', 'Spine2'] as const

/** How far above the hips the cape's top edge sits when there is no chest bone.
 *  Approximately right for the ~1.7 m bodies here; the chest bone, when there is
 *  one, measures it instead. */
const SHOULDER_ABOVE_HIPS = 0.45
/** And above the chest bone, where the shoulders actually are. */
const SHOULDER_ABOVE_CHEST = 0.15
/** The last resort, with no bones at all: shoulder height above the feet. */
const SHOULDER_ABOVE_FEET = 1.35

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
 * pinned edge stands off the body's midline at every point.
 *
 * This is the whole of the cape's stand-off from the body: the sheet is placed
 * on a circle this size around the character and hangs from there, so it starts
 * clear of the torso and nothing has to push it out. It is also why the torso
 * collider below never touches the cloth — at this radius the drape is a good
 * half-metre outside it — and lowering this towards the body's own width is what
 * would bring the two back into contact.
 */
const CAPE_ANCHOR_RADIUS = 0.75

/**
 * Where the collider sits relative to the point the cape's ring is centred on,
 * in world units. Zero — on the attach point itself, which is the body's midline
 * at shoulder height, and already the chest. It used to be `[0, 1, 0]`, measured
 * up from the feet: that frame went away when the cape started hanging from the
 * skeleton, and an offset of one metre above a chest is a point above the head.
 *
 * A module constant rather than a literal in the props, because the cloth
 * rebuilds — losing the simulation — whenever this identity changes.
 */
const CAPE_PLAYER_OFFSET: [number, number, number] = [0, -0.125, 0.0]

/** Cape length in world units, hanging from the shoulders: hip length on a
 *  1.7 m body. */
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

let avatarRoot: Object3D | null = null
let hipsBone: Bone | null = null
let chestBone: Bone | null = null

/**
 * The character's facing, written into `FORWARD`.
 *
 * `playerGroup` carries a yaw and nothing else — both writers of it
 * (`NavMeshRig`'s walk steering and its aim) set `rotation.y` alone — and its
 * local +Z is the direction the character walks and looks, which `npcProps`
 * states outright for the gun mount ("+Z *is* forward for the avatar root").
 * This one expression is therefore the whole of the character's rotation, and
 * everything the cape derives from it — the line, the back offset, the wind —
 * turns with them.
 */
function readFacing(playerGroup: Object3D): Vector3 {
    return FORWARD.set(Math.sin(playerGroup.rotation.y), 0, Math.cos(playerGroup.rotation.y))
}

/**
 * The point the cape is attached to, written into `CENTRE`: the body's own
 * midline, at shoulder height.
 *
 * Both the ring and the body collider are built from it, so the two cannot
 * disagree about where the character is — which they could while the collider
 * tracked `playerGroup.position` (the feet on the navmesh) and the ring tracked
 * the skeleton. A body whose model sits off its group's origin, or a rig whose
 * shoulders are not where a constant guessed them to be, would have had the
 * cloth draping around a point that was not the one it hung from.
 */
function readBodyCentre(playerGroup: Object3D): Vector3 {
    const { hips, chest } = resolveBody(playerGroup)

    // The midline: the body's own root when there is one, else the group's
    // position — which is the feet on the navmesh.
    if (hips) {
        hips.getWorldPosition(CENTRE)
    } else {
        CENTRE.copy(playerGroup.position)
    }

    // The height, from the chest bone when the body has one — it is on the
    // midline too, so re-reading it is not a second centre, just a point that
    // already sits the right way up.
    if (chest) {
        chest.getWorldPosition(CENTRE)
        CENTRE.y += SHOULDER_ABOVE_CHEST
    } else {
        CENTRE.y += hips ? SHOULDER_ABOVE_HIPS : SHOULDER_ABOVE_FEET
    }

    return CENTRE
}

/** The body's own midline, from its root bone. Cached against the group the
 *  root hangs from, so a replaced avatar re-resolves. */
function resolveBody(playerGroup: Object3D) {
    if (avatarRoot === null || avatarRoot.parent !== playerGroup) {
        // The rig root is named 'Avatar' and is a direct child of the group
        // (`avatarLoader.loadAvatar` builds it; NavMeshRig adds it).
        avatarRoot = playerGroup.getObjectByName('Avatar') ?? null

        const root = avatarRoot
        const find = (names: readonly string[]) =>
            root ? (names.map((name) => findBone(root, name)).find(Boolean) ?? null) : null

        hipsBone = find(HIPS_BONES)
        chestBone = find(CHEST_BONES)
    }

    return { hips: hipsBone, chest: chestBone }
}

/**
 * The ring the cape hangs from, in world units — read by the cloth once a frame.
 *
 * Built out of the body itself rather than out of anything in the scene graph:
 * the centre is the hips' midline point, the plane is horizontal, and the arc's
 * middle points straight out of the character's **back**, so the drape ends up
 * behind them and turns with them — the same frame `readCapeWind` blows along.
 * Nothing is parented and nothing is added to `playerGroup`; the ring is
 * arithmetic on bones that are already positioned.
 *
 * `span` is how much of the ring the pinned edge covers, in radians — set
 * directly rather than derived from the sheet's width, so the edge can be
 * gathered in (a sweep under `width / radius`) or wrapped past a full turn
 * (over 2π, where the edge overlaps its own start) instead of always matching
 * the grid.
 *
 * Returns null until the avatar exists, which is what keeps the cape from being
 * built against a character that has not spawned.
 */
function readPinCircle(radius: number): PinCircle | null {
    const playerGroup = useGameGlobal.getState().playerGroup as Object3D | null
    if (!playerGroup) return null

    ANCHOR_CENTRE.copy(readBodyCentre(playerGroup))
    ANCHOR_CENTRE.y += 0.15

    // Both directions come straight off `rotation.y` — one angle gives the pair,
    // rather than a facing read out of `readFacing` and a cross product taken
    // from it. The two are then a rigid quarter turn of the same angle: exactly
    // perpendicular and unit by construction, with nothing to normalise and
    // nothing read from the shared `FORWARD` scratch the wind writes later in
    // the same frame.
    const yaw = playerGroup.rotation.y

    // Behind the character. The arc is centred on this direction, so the cape
    // hangs behind them and turns with them.
    ANCHOR_MIDDLE.set(-Math.sin(yaw), 0, -Math.cos(yaw))

    // That angle opened a quarter turn: horizontal, perpendicular to `middle`,
    // and the direction `pinT` runs in — so the edge sweeps from one side of
    // the back to the other.
    ANCHOR_TANGENT.set(-Math.cos(yaw), 0, Math.sin(yaw))

    // A radius of zero divides into the span and leaves no ring to hang from, so
    // the degenerate case is floored rather than guarded.
    const safeRadius = Math.max(radius, 1e-3)

    return {
        centre: ANCHOR_CENTRE,
        middle: ANCHOR_MIDDLE,
        tangent: ANCHOR_TANGENT,
        radius: safeRadius,
        span: Math.PI * 2 * 1.0 * Math.abs(Math.sin((performance.now() / 1000.0) * 0.5)),
    }
}

/**
 * The wind the cape is blown by: straight out of the wearer's back, so the
 * drape is always pushed away from them.
 *
 * The cloth's default is a fixed world `-Z`, which is the one part of the
 * simulation that cannot follow the character — gravity is world-down whoever
 * they are and the springs only pull along themselves, but a wind direction is
 * only meaningful in a frame, and for a cape that frame is the wearer's. Left in
 * the world's frame the cape reads as rotated with the world rather than with
 * the character: turn 45° and the drape is still being blown along the old axis,
 * turn to face `-Z` and it is blown against their front — a half-turn out from
 * the body.
 *
 * Straight out along the direction the arc is centred on (see `readPinCircle`),
 * which is what makes it a tailwind at every facing — and the reason the two are
 * built from the same facing rather than each deriving its own.
 */
function readCapeWind(): Vector3 | null {
    const playerGroup = useGameGlobal.getState().playerGroup as Object3D | null
    if (!playerGroup) return null

    return CAPE_WIND.copy(readFacing(playerGroup)).negate()
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
     *  edge stands off the character. Defaults to `CAPE_ANCHOR_RADIUS`. */
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

    // Subscribing to `playerGroup` is safe where subscribing to the player's
    // position would not be: the group object is stable for the life of the
    // scene, so this re-renders when the avatar appears and not once per frame.
    const playerGroup = useGameGlobal((r) => r.playerGroup) as Object3D | null

    const cloth = useMemo(() => {
        // No player, no cape: the cloth's pins are the character's body, and
        // there is nothing to hang it from yet. Reading the ring is the
        // readiness test — the cloth reads it again in its own frame, so this
        // one is only about whether a character exists at all.
        if (!playerGroup || !readPinCircle(anchorRadius)) return null

        return createCloth({
            // `gl` from R3F's store is the WebGPURenderer this scene draws with,
            // which is the one the compute passes must be dispatched on. R3F
            // declares `RootState['gl']` as the WebGL renderer regardless of what
            // the factory returned, so the cast goes through `unknown`.
            renderer: renderer as unknown as ClothOptions['renderer'],
            getPinCircle: () => readPinCircle(anchorRadius),
            // The wind follows the wearer rather than the world — see
            // `readCapeWind`, which is the whole of "the cape turns with them".
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
            // about where the character is. The sphere is hidden (`cloth.ts`
            // hides the mesh and keeps the force) because it stands in for the
            // torso.
            getPlayerPosition: () => {
                const group = useGameGlobal.getState().playerGroup as Object3D | null
                return group ? readBodyCentre(group) : null
            },
            playerOffset,
            material,
        })
    }, [
        renderer,
        playerGroup,
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
