/**
 * NPC enemies — a small crowd of avatars that inhabit the NavMeshRig navmesh.
 *
 * Steering is navcat's crowd (the same library the rig already uses for the
 * player's pathfinding), driven by the pattern from the navcat crowd example:
 * scatter each agent to a random point on the navmesh with `findRandomPoint` +
 * `requestMoveTarget`, let `crowd.update` advance them, and re-scatter
 * periodically.
 *
 * On top of that, an agent that gets within `npcAggroRadius` of the player
 * abandons its wander target and chases, re-aiming at the player's live
 * position a few times a second. It holds at a standoff distance rather than
 * walking into the player, and drops back to wandering once the player is out
 * of range.
 *
 * **Being shot also aggros it, from any distance.** The radius test alone left a
 * hole: the player's reach is `playerFireRange` (30) and the crowd's aggro radius
 * is 12, so everything between those two numbers could be shot with impunity —
 * the NPC never noticed. A hit now latches `Npc.provoked`, and the latch is a
 * grudge rather than a timer: it holds until the NPC is down, and the respawn is
 * what ends it.
 *
 * An armed NPC tracks the player with its **whole body** and will not shoot
 * until the muzzle is on them (`facePlayer` / `aimedAtPlayer`) — the gun is
 * calibrated to the group's forward, so facing the player *is* aiming at them.
 *
 * ## Why this is not a set of R3F components
 *
 * The crowd is one simulation stepped once per frame, and its agents are plain
 * data — positions land in `agent.position`, not in React's graph. Wrapping
 * each NPC in a component would mean a store round-trip per agent per frame for
 * state that is already imperative. The avatars come from `loadAvatar`, which is
 * itself an imperative factory returning a `THREE.Group`, so this module follows
 * the same shape: build once, tick, dispose.
 *
 * ## Cost, and why the avatars load one at a time
 *
 * `loadAvatar` is expensive — `loadGLB` does not cache (a fresh `GLTFLoader` per
 * call, and `THREE.Cache` is off repo-wide), so every NPC pays two uncached
 * network + Draco/meshopt decodes for its body and face, plus its own clip
 * clones and a head-seating pass. Each freshly built rig is also invisible for
 * up to ~1.6 s while its reveal gate waits for the skeleton to stand.
 *
 * So the crowd is created and set walking *first*, and the avatars are then
 * loaded strictly one after another. The agents are simulated the whole time;
 * each merely stays invisible until its own avatar resolves. Kicking them all
 * off in `Promise.all` would stall the main thread on several decodes at once
 * and then reveal the whole crowd in one jump.
 */

import * as THREE from 'three'
import type { Vec3 } from 'mathcat'
import {
    createFindNearestPolyResult,
    DEFAULT_QUERY_FILTER,
    findNearestPoly,
    type FindNearestPolyResult,
    type NavMesh,
} from 'navcat'
import { crowd } from 'navcat/blocks'
import { randomNavMeshPoint } from './navmeshPoints'
import { BASE_SET_KEY, loadAvatar, type AvatarRig, type ClipSetConfig, type LocomotionKey } from './avatarLoader'
import { applyGunTuning, attachGun, calibrateGun, loadWeaponTemplate, type NpcGun, type NpcWeapon } from './npcProps'
import { createNpcProjectiles } from './npcProjectiles'
import {
    makeDefaultManifest,
    type Gender,
    type MotionClipDef,
} from '../b3/b3-runtime/src/components/AvatarSDK'
import { ARMED_FIRING_CLIP, ARMED_SET_KEY, armedClipSet } from './armedClipSet'
import { deathClipFor } from './deathClip'
import { FORCE_FIELD_SWEEP_SECONDS, ringJustCrossed, shoveImpulse, sweepReach } from './forceField'
import { BAR_HEIGHT_ABOVE, createHealthBar, type HealthBar } from './healthBar'
import { STUN_CLIP } from './stunClip'

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Agent collision radius. Matches the avatar's rough shoulder half-width. */
const NPC_RADIUS = 0.35
/** Agent height — used by navmesh queries and obstacle avoidance. */
const NPC_HEIGHT = 1.7
/** Wander pace. Slower than the player's walk, so NPCs drift rather than march. */
const NPC_WALK_SPEED = 2.2
/**
 * Chase pace. Above the player's `walkingSpeed` (4) so a walking player is
 * caught, and below `runningSpeed` (8) so a running one escapes — that gap is
 * what makes the chase interactive instead of inescapable.
 */
const NPC_RUN_SPEED = 4.5

/** How close the player must be before an NPC gives chase (world units). */
const DEFAULT_AGGRO = 12
/** How long an NPC walks a wander target before it is re-scattered. */
const DEFAULT_SCATTER_SECONDS = 6

/**
 * Fallback for the distance a chasing NPC stops at rather than walking into the
 * player — the ring it actually attacks from. The live value is
 * `tunables.npcStandoffDistance`; this mirrors the store's default and is only
 * a backstop for a settings object that predates the field.
 *
 * The player is not a crowd agent — it is moved by the rig's own code — so the
 * crowd cannot resolve a collision against it, and without a standoff the whole
 * crowd would converge onto the player's exact position.
 */
const STANDOFF_DISTANCE = 5

/** Seconds between chase re-aims. Pathfinding is expensive; the example throttles too. */
const CHASE_REAIM_SECONDS = 0.25

/** Search box (world units) used to snap a target onto the navmesh. */
const TARGET_HALF_EXTENTS: Vec3 = [4, 4, 4]

/** How far from the player a spawn lands when the sampler comes up empty. */
const SPAWN_FALLBACK_DISTANCE = 8

/** Considered "arrived" within this distance of the wander target. */
const ARRIVED_THRESHOLD = 0.6

/**
 * Seconds to wait for a death clip to *start* before giving up and removing the
 * body anyway.
 *
 * The emotion path resolves its FBX through a promise (`avatarLoader.ts:782`),
 * so `isEmotionActive()` reads false for a frame or two after
 * `playEmotionOnce()` — long enough for a naive "hide when the clip is over"
 * check to hide the body before the fall was ever drawn on screen. This is the
 * backstop for the other failure: a clip that never loads at all, which would
 * otherwise leave the corpse standing there for the whole respawn delay.
 */
const DEATH_ANIM_GRACE = 3

/**
 * Hard ceiling on how long a respawn will sit and wait for the death clip to
 * finish. Without it, an emotion that never reports itself over would strand the
 * NPC out of the crowd permanently — a standing corpse is a much worse bug than
 * a fall that gets cut short.
 */
const DEATH_ANIM_MAX_WAIT = 8

/** Below this speed an NPC is treated as standing still and blends to idle. */
const MOVING_SPEED = 0.04

/**
 * The crowd's defensive jump, expressed with the player's own numbers so the two
 * arcs are the same shape: `NavMeshRig`'s `JUMP_SPEED` (6.9) and `JUMP_GRAVITY`
 * (20) give ~1.2 m of apex and ~0.7 s of air, which is long enough for the jump's
 * field to sweep past the incoming water but short enough to read as a dodge
 * rather than a hover.
 *
 * Duplicated rather than imported: those two live inside the rig's frame-loop
 * closure, and the crowd owns its own movement constants (`NPC_WALK_SPEED`) for
 * the same reason. Change one and the other wants the change too.
 */
const NPC_JUMP_SPEED = 6.9
const NPC_JUMP_GRAVITY = 20

/**
 * Where the jump clip is restarted from on takeoff — mid-clip, skipping the
 * authored anticipation crouch, so the pose matches a body that is already
 * leaving the ground. The player's `JUMP_CLIP_START`.
 */
const NPC_JUMP_CLIP_START = 0.45

/** No field running. A field's elapsed time counts up from 0; see `advanceNpcField`. */
const NO_FIELD = -1

/**
 * Height above the player's origin that the NPCs shoot at — roughly the chest of
 * a ~1.7 m avatar. Same point is used for the aim and for the pool's hit test,
 * so a droplet that visibly reaches the player is also the one that is
 * recycled; aiming at the chest but testing against the feet would sail every
 * shot past the check.
 *
 * Exported because the player's line-of-sight check has to ray between the same
 * two chests: a ray drawn at some other height would be testing a line nobody
 * shoots along, and could report a hillside as blocking a shot that clears it.
 */
export const AIM_HEIGHT = 0.8

/**
 * How closely an armed NPC must be facing the player before it will shoot —
 * the cosine of the half-angle it is allowed to be off by, ~20 degrees.
 *
 * The gun is calibrated to the group's forward (`npcProps.calibrateGun`), so
 * "the NPC is facing the player" and "the muzzle is on the player" are the same
 * statement, and this is the threshold that makes the aim a *precondition* of
 * the shot rather than something that merely tends to be true. Tight enough
 * that a shot is never fired across the NPC's own shoulder; loose enough that
 * the turn, which converges in a handful of frames, never visibly stalls one.
 */
const AIM_TOLERANCE_COS = Math.cos(THREE.MathUtils.degToRad(20))

// The armed clip set is shared with the player's attack mode — see
// `armedClipSet.ts`, which owns the section lookups and the set key.


/** The firing one-shot, played through the rig's emotion path. */
const FIRING_CLIP: MotionClipDef | null = ARMED_FIRING_CLIP

/**
 * The rig's `ClipSetConfig` for the armed set, or undefined when the SDK's
 * section table is missing a clip (then every NPC stays in peace).
 *
 * The cadences are read once here as the set's *initial* values; the live GUI
 * values are re-applied through `setClipSetTimeScale` every time they change.
 */
function armedSetConfig(tunables: NpcTunables): ClipSetConfig | undefined {
    const defs = armedClipSet()
    if (!defs) return undefined
    return {
        clips: defs.clips,
        timeScale: {
            walk: tunables.npcArmedWalkTimescale,
            run: tunables.npcArmedRunTimescale,
        },
    }
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Live tunables, read every frame. The rig passes its lil-gui-bound settings
 *  object straight through, so edits apply without rebuilding anything. */
export interface NpcTunables {
    npcAggroRadius: number
    npcScatterSeconds: number
    /** How close a chasing NPC closes before it holds — the ring it attacks
     *  from, in world units. See `STANDOFF_DISTANCE` for the fallback. */
    npcStandoffDistance: number
    /** Master switch for the armed/peace states. Off leaves every NPC in peace. */
    npcArmedEnabled: boolean
    /** Seconds between shots while an armed NPC holds at the standoff ring. */
    npcFireInterval: number
    /** An armed NPC only shoots a player this close, in world units. */
    npcFireRange: number
    /** Droplet muzzle velocity, world units / second. */
    npcProjectileSpeed: number
    /** Cadence for the armed walk / run clips. The rifle pack is authored for a
     *  slower pace than the crowd's navmesh speed, so these run above 1 to keep
     *  the feet from sliding. */
    npcArmedWalkTimescale: number
    npcArmedRunTimescale: number
    /** How far the jump's force field reaches — the radius that both turns the
     *  crowd's droplets and shoves the crowd itself. Measured on the ground
     *  plane, like every other distance here. */
    forceFieldRadius: number
    /** How far the field throws an NPC outward, in world units — the distance
     *  the slide covers, not a speed. See `shoveImpulse`. */
    forceFieldPush: number
    /** How long the field leaves an NPC stunned, in seconds. */
    forceFieldStunSeconds: number
    /** Master switch for the crowd's own jump defence — the mirror of the
     *  player's field, built from `jump` / `advanceNpcField`. Off restores the
     *  pre-skill crowd exactly, and is what makes the feature A/B-able live
     *  without a rebuild. */
    npcJumpDefenceEnabled: boolean
    /** How close one of the player's inbound droplets must come before an NPC
     *  jumps, in world units on the ground plane. The cue, not the reach. */
    npcJumpThreatRadius: number
    /** How far an NPC's own jump field reaches, in world units. */
    npcJumpFieldRadius: number
    /** Seconds one NPC must wait between defensive jumps. Per NPC. */
    npcJumpCooldown: number
    /** Health every NPC starts with, and the value a respawn restores. */
    maxHp: number
    /** Damage one droplet does. Read by the crowd so `NpcTarget.damage` needs no
     *  argument, and the damage number lives in exactly one place. */
    dropletDamage: number
    /** How long a downed NPC stays down before getting back up. */
    npcRespawnSeconds: number
}

/** An opaque handle on one NPC, for a shooter outside this module.
 *  See {@link NpcEnemies.targetFromObject}. */
export interface NpcTarget {
    /**
     * The NPC's chest in world space, or null once the crowd is disposed or the
     * NPC is down.
     *
     * A **shared scratch vector**, like the crowd's own `aimPoint`: read it and
     * use it immediately, don't hold on to it across a frame.
     */
    aimPoint(): THREE.Vector3 | null
    /**
     * Apply one droplet's damage. Returns true if that was the killing blow.
     *
     * Takes no amount: the crowd reads `tunables.dropletDamage` itself, so the
     * damage number lives in one place and a shooter needs no knowledge of it.
     * A no-op on an NPC that is already down, which is what stops a stray
     * droplet in flight from re-killing a corpse.
     */
    damage(): boolean
}

/**
 * The player's water, as far as the crowd's jump defence needs it: two questions
 * and no ownership.
 *
 * Structural rather than imported so `npcEnemies` and `playerCombat` stay
 * unaware of each other — the rig, which holds both, is what connects them.
 */
export interface PlayerDroplets {
    /** Is a droplet of the player's inbound toward `point`, within `radius`? */
    inboundThreat(point: THREE.Vector3, radius: number): boolean
    /** Turn the player's inbound water inside `radius` of `origin` back out. */
    deflect(origin: THREE.Vector3, radius: number): number
}

export interface NpcEnemiesOptions {
    scene: THREE.Scene
    navMesh: NavMesh
    /** How many NPCs to spawn. */
    count: number
    /** Live player position, or null before the player exists. */
    getPlayerPosition: () => THREE.Vector3 | null
    /**
     * Whether the crowd treats the player as a target at all. Read per frame, so
     * flipping it takes effect on the next tick with nothing to re-seed — which
     * is why this is a getter rather than a `setHostile` setter (a setter would
     * need seeding on create *and* on every respawn, and would drift).
     *
     * False means the crowd ignores the player entirely: every NPC wanders,
     * holsters its gun, and no already-airborne droplet can splash them.
     */
    getHostile: () => boolean
    /**
     * One of this crowd's droplets just landed on the player.
     *
     * Injected rather than the crowd reaching for the player's health directly,
     * for the same reason as `getPlayerPosition`: it keeps this module importing
     * nothing from the store, and lets the rig own where player state lives.
     */
    onPlayerHit: () => void
    /**
     * The player's own droplet pool, or null before it exists — the crowd's jump
     * defence has to see the water coming at it, and water in flight belongs to
     * the pool that fired it.
     *
     * A getter, like `getPlayerPosition`: the pool is built once and lives as long
     * as the player, so this could equally be a plain reference — but reading it
     * per frame means a crowd built before the player's pool cannot hold a stale
     * null, which is the same trap `getHostile` avoids.
     *
     * The interface is structural — `PlayerCombat` satisfies it — so neither
     * module has to import the other's type, and the crowd only ever gets the two
     * questions it actually asks about the player's water.
     */
    getPlayerDroplets?: () => PlayerDroplets | null
    /** Read per frame so GUI edits take effect immediately. */
    tunables: NpcTunables
    /**
     * The weapon the crowd carries, or null to carry none. The rig owns this
     * object and **mutates it in place** from the avatar store, exactly like
     * `tunables` — the crowd holds the reference and reads it every frame, so
     * replacing it would leave the crowd reading a detached copy.
     *
     * `url` and `bone` are consumed once per avatar, at attach. Changing either
     * needs a respawn; the rest is live.
     */
    weapon: NpcWeapon | null
}

export interface NpcEnemies {
    /** Root holding every NPC — added to the scene by `createNpcEnemies`. */
    readonly group: THREE.Group
    /**
     * Resolve one of the crowd's scene objects to an opaque handle on the NPC
     * that owns it, or null when the object belongs to no NPC.
     *
     * A handle rather than a point: the projectile pool re-reads its target
     * every frame, so a snapshot would have the player's ball homing on where
     * the enemy *was*. The aim height stays here, next to the crowd's own
     * `AIM_HEIGHT`, so the two sides cannot drift.
     *
     * Accepts either an `npc-<index>` group or any descendant (a mesh, a bone),
     * so it works whether the caller has a raycast hit or a projected group.
     */
    targetFromObject(object: THREE.Object3D | null): NpcTarget | null
    /**
     * Re-base onto a freshly generated navmesh, keeping the loaded avatars.
     * The rig replaces its `navMesh` wholesale when the collider changes, so a
     * crowd built against the old one would be steering agents on a mesh that
     * no longer has anything to do with the scene.
     */
    setNavMesh(navMesh: NavMesh): void
    /**
     * The jump's force field: open a ring at `origin` that sweeps out to
     * `forceFieldRadius`, turning the crowd's droplets back and throwing and
     * stunning every NPC it passes.
     *
     * **A sweep, not a blast.** The ring travels out over
     * `FORCE_FIELD_SWEEP_SECONDS` and acts as it arrives, so an NPC at the rim is
     * thrown when the wave gets there rather than when the player left the
     * ground — the pulse is the cause, and reads as one. Each thing is hit once,
     * and the throw is an outward impulse the crowd's own integrator decelerates,
     * so an NPC slides back and settles instead of teleporting.
     *
     * One call, here, because this module owns both halves — the droplet pool and
     * the `npcs` array. Anywhere else would mean reaching through two private
     * handles to reach the same two things.
     *
     * Reads the tunables live, so a lil-gui drag applies to the next jump. Safe
     * to call at any time, including before the crowd has finished loading, and
     * safe to call again mid-sweep — the new pulse supersedes the old.
     */
    forceField(origin: THREE.Vector3): void
    /** Advance the crowd and pose the avatars. Call once per frame. */
    update(delta: number): void
    /** Stop the crowd, remove the avatars, and drop the group from the scene. */
    dispose(): void
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Where an NPC currently thinks it is going. */
type NpcMode = 'wander' | 'chase' | 'hold'

interface Npc {
    /** Per-NPC transform. The avatar rig is parented here once it resolves. */
    group: THREE.Group
    /** Null until the avatar finishes loading. */
    rig: AvatarRig | null
    /** Water gun in the right hand — null when unarmed. */
    gun: NpcGun | null
    /** Crowd agent id, reassigned on every `setNavMesh`. */
    agentId: string | null
    mode: NpcMode
    /** Seconds walked toward the current wander target. */
    wanderAge: number
    /** Seconds since the last chase re-aim — the re-aim throttle. */
    chaseAge: number
    /** Has the gun drawn? Armed while aggroed, peace while wandering. */
    armed: boolean
    /** Whether this avatar's rig actually built the armed clip set. A body that
     *  failed to load the rifle FBXs still draws and fires; it just keeps the
     *  peace clips, which beats toggling to nothing. */
    armedClips: boolean
    /** Countdown to the next shot, in seconds. Only ticks while armed and holding. */
    shotTimer: number
    /**
     * Seconds left of the jump field's stun, or 0 when not stunned.
     *
     * Distinct from `dead` in the one way that matters: a stunned NPC **keeps
     * its `agentId`**. It is still in the crowd, still on the navmesh, and still
     * a valid target — it is simply pinned for a moment. So the stun cannot use
     * the dead path's "null the agent and let step 1 skip it" trick; it needs its
     * own gate at the top of step 1 (see `forceField`).
     */
    stunTimer: number
    /**
     * The defensive jump's ballistic state: `jumpOffset` is the lift above the
     * navmesh surface and `jumpVelocity` its rate of change. Both zero means
     * grounded, which is the only state a jump may start from (and what
     * `animate` reads for its jump weight).
     *
     * Applied to `group.position.y` in step 3 and nowhere else, exactly like the
     * player's own arc is applied to `playerGroup`: the agent's position is the
     * ground truth, and the lift is a render-time addition to it.
     */
    jumpOffset: number
    jumpVelocity: number
    /**
     * Seconds until this NPC may jump again. Per NPC, and it exists so a crowd
     * under sustained fire dodges as individuals — without it, one shot fired
     * across six NPCs makes all six hop on the same frame.
     */
    jumpCooldown: number
    /** How far this NPC's own jump field has swept, in seconds — `NO_FIELD` when
     *  it has none running. Each NPC owns its own sweep, because two of them can
     *  be airborne at once. */
    fieldElapsed: number
    /**
     * How far that field reaches, snapshotted at takeoff from
     * `tunables.npcJumpFieldRadius` — the same reason the player's field
     * snapshots its own numbers: a lil-gui drag mid-sweep would otherwise have
     * one wave growing while another shrank, which is not a state anyone could
     * reason about.
     */
    fieldRadius: number
    /**
     * Where this NPC's field is centred: copied at takeoff, because the wave must
     * not travel with a body that is still walking.
     *
     * Allocated per NPC rather than shared as a scratch, since a live field is
     * read on frames long after the jump that opened it — a shared vector would
     * have every NPC's field anchored to whichever one jumped last.
     */
    fieldOrigin: THREE.Vector3
    /**
     * Has the player shot this NPC? Latches, and keeps the grudge for the rest of
     * this life — the only thing that clears it is the respawn.
     *
     * It exists because the aggro radius alone cannot see a shot from outside it:
     * the player outranges the crowd (30 against 12), so a hit has to be able to
     * start a chase the distance test would never have started.
     */
    provoked: boolean
    /** Health, 0..`tunables.maxHp`. At 0 the NPC goes down. */
    hp: number
    /** Downed: out of the crowd, not shooting, not a valid target. */
    dead: boolean
    /** Seconds left before a downed NPC gets back up. */
    respawnTimer: number
    /** Set once the death clip has actually been *seen* running. Latches, and is
     *  what licenses hiding the body — see `DEATH_ANIM_GRACE`. */
    deathClipSeen: boolean
    /** Seconds since the killing blow, for the give-up-on-a-stuck-clip backstop. */
    deathElapsed: number
    /** The floating bar above this NPC's head. */
    bar: HealthBar
}

/** Dispose every mesh under `root` (geometry + material). */
function disposeObject(root: THREE.Object3D) {
    root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.isMesh) {
            mesh.geometry?.dispose()
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
            for (const m of mats) m?.dispose()
        }
    })
}

/** The per-NPC transform the avatar rig is parented to. Named for the index so
 *  a scene dump lines it up with `npcs[i]` and the spawn log. */
function createNpcGroup(index: number): THREE.Group {
    const group = new THREE.Group()
    group.name = `npc-${index}`
    return group
}

/**
 * The enemy NPCs' whole wardrobe: one pinned body and two pinned heads per
 * gender, written down by **URL**.
 *
 * This is a hard whitelist, not a sample of the avatar catalog. The crowd may
 * wear nothing else, so the looks are spelled out here rather than drawn from
 * `partsFor(...)`: the catalog holds dozens of looks for the *player* to pick
 * between, and every one of them would otherwise be a look an enemy could spawn
 * in. Keep this list closed — that is the whole point of it.
 *
 * URLs rather than catalog ids because that is what the list is a list of, and
 * because there is nothing here to gain by indirecting through the catalog: the
 * two bodies happen to be catalog entries, but the four heads are not (they
 * carry no variants, so they are not offered in the avatar picker), and
 * `makeDefaultManifest` resolves a plain URL either way.
 */
const NPC_BODY_URL: Record<Gender, string> = {
    male: '/char/male/body/water-guy.glb',
    female: '/char/female/body/water-lady.glb',
}

/** Per gender, alternating so the squad is uniform without being identical. */
const NPC_FACE_URLS: Record<Gender, string[]> = {
    male: ['/char/male/face/low-poly-asian-head.glb', '/char/male/face/low-poly-west-head.glb'],
    female: ['/char/female/face/low-poly-west.glb', '/char/female/face/low-poly-asian-head.glb'],
}

/**
 * Resolve the manifest for an NPC, read straight off the whitelist above. It
 * cannot fail and cannot select a look that is not on the list.
 *
 * Genders alternate so the crowd is mixed, and each gender alternates between
 * its two heads. The head index is the **per-gender ordinal** — `floor(index/2)`
 * because parity is what picks the gender — and not `index`: every male is an
 * even index, so `index % 2` would hand all of them head 0 and the variation
 * would silently vanish from the crowd.
 */
function manifestFor(index: number) {
    const gender: Gender = index % 2 === 0 ? 'male' : 'female'
    const faces = NPC_FACE_URLS[gender]
    const face = faces[Math.floor(index / 2) % faces.length]
    return makeDefaultManifest({
        name: `npc-${index}`,
        gender,
        assets: { body: NPC_BODY_URL[gender], face },
    })
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createNpcEnemies(opts: NpcEnemiesOptions): Promise<NpcEnemies> {
    const { scene, getPlayerPosition, getHostile, onPlayerHit, tunables, weapon, getPlayerDroplets } = opts
    let navMesh = opts.navMesh

    let disposed = false

    /** Single scratch result — `requestMoveTarget` copies out of it
     *  (`vec3.copy(agent.targetPosition, targetPos)`), so one is enough. */
    const nearestScratch: FindNearestPolyResult = createFindNearestPolyResult()

    const agentParams: crowd.AgentParams = {
        radius: NPC_RADIUS,
        height: NPC_HEIGHT,
        maxAcceleration: 8,
        maxSpeed: NPC_WALK_SPEED,
        collisionQueryRange: 2,
        separationWeight: 0.6,
        updateFlags:
            crowd.CrowdUpdateFlags.ANTICIPATE_TURNS |
            crowd.CrowdUpdateFlags.SEPARATION |
            crowd.CrowdUpdateFlags.OBSTACLE_AVOIDANCE |
            crowd.CrowdUpdateFlags.OPTIMIZE_TOPO |
            crowd.CrowdUpdateFlags.OPTIMIZE_VIS,
        queryFilter: DEFAULT_QUERY_FILTER,
        obstacleAvoidance: crowd.DEFAULT_OBSTACLE_AVOIDANCE_PARAMS,
        // Nothing adds off-mesh connections to this navmesh (it is generated
        // from the collider alone), so there is no custom arc animation to run.
        autoTraverseOffMeshConnections: true,
    }

    const root = new THREE.Group()
    root.name = 'npcs'
    scene.add(root)

    let state = crowd.create(NPC_RADIUS)
    const npcs: Npc[] = []

    /**
     * Where to drop a new NPC.
     *
     * The fallback is unreachable in practice (see `randomPoint`) but must not
     * be the player's own position: an NPC spawned inside the standoff ring
     * enters `hold` immediately and never moves again, so the crowd would look
     * broken. Put it at arm's length in a random direction instead.
     */
    const spawnOnNavMesh = (): Vec3 | null => {
        const random = randomNavMeshPoint(navMesh)
        if (random) return random.position
        const player = getPlayerPosition()
        if (!player) return null
        const angle = Math.random() * Math.PI * 2
        const at: Vec3 = [
            player.x + Math.cos(angle) * SPAWN_FALLBACK_DISTANCE,
            player.y,
            player.z + Math.sin(angle) * SPAWN_FALLBACK_DISTANCE,
        ]
        const hit = findNearestPoly(nearestScratch, navMesh, at, [50, 50, 50], DEFAULT_QUERY_FILTER)
        return hit.success ? hit.position : null
    }

    // ------------------------------------------------------------------
    // 1. Crowd first — agents start walking while the avatars load.
    // ------------------------------------------------------------------
    for (let i = 0; i < Math.max(0, opts.count); i++) {
        const spawn = spawnOnNavMesh()
        if (!spawn) {
            console.warn('[NpcEnemies] could not find a spawn point on the navmesh — fewer NPCs than requested')
            break
        }
        const group = createNpcGroup(i)
        group.position.fromArray(spawn)
        root.add(group)

        // The bar hangs off the group, not the rig, so it exists from the first
        // tick — an NPC whose avatar is still loading (or failed to) is still a
        // shootable target with health, and a bar that appeared late would make
        // it look like a different character.
        const bar = createHealthBar()
        // No `|| fallback` here on purpose: `maxHp` is a required tunable, and a
        // falsy-default would silently turn a deliberate 0 into a full bar.
        const barMax = tunables.maxHp
        bar.setFraction(1, barMax, barMax)
        bar.sprite.position.set(0, BAR_HEIGHT_ABOVE, 0)
        group.add(bar.sprite)

        const agentId = crowd.addAgent(state, navMesh, spawn, agentParams)
        npcs.push({
            group,
            rig: null,
            gun: null,
            agentId,
            mode: 'wander',
            wanderAge: Infinity,
            chaseAge: 0,
            provoked: false,
            armed: false,
            armedClips: false,
            shotTimer: 0,
            stunTimer: 0,
            jumpOffset: 0,
            jumpVelocity: 0,
            // Staggered by index rather than all starting at zero: a freshly
            // spawned crowd all reaching "ready" on the same frame is the same
            // unison problem the cooldown exists to prevent, and it would show up
            // on the very first volley rather than only under sustained fire.
            jumpCooldown: npcs.length * 0.4,
            fieldElapsed: NO_FIELD,
            fieldRadius: 0,
            fieldOrigin: new THREE.Vector3(),
            hp: barMax,
            dead: false,
            respawnTimer: 0,
            deathClipSeen: false,
            deathElapsed: 0,
            bar,
        })
    }

    // ------------------------------------------------------------------
    // 2. Avatars, strictly sequentially.
    // ------------------------------------------------------------------

    // Arm the guns before the first avatar lands, so `attachGun` is a plain
    // synchronous call inside the loop below. The template is cached across
    // crowds *by URL*, so this resolves immediately for every crowd but the
    // first to use that weapon, and a failure just leaves the NPCs unarmed.
    // (A teardown during that await is caught by the loop's own `disposed`
    // guard — `dispose()` has already removed the agents and the root.)
    const template = weapon ? await loadWeaponTemplate(weapon.url) : null

    // Built once and shared by every NPC's `loadAvatar` — the clip *bytes* are
    // cached per URL in the SDK's motion library, so the crowd pays for the
    // rifle pack once, not once per body.
    const armedSet = armedSetConfig(tunables)

    for (let i = 0; i < npcs.length; i++) {
        if (disposed) break
        const manifest = manifestFor(i)
        try {
            const rig = await loadAvatar({
                manifest,
                clipSets: armedSet ? { [ARMED_SET_KEY]: armedSet } : undefined,
            })
            // The whole thing may have been torn down while this loaded. Stop
            // rather than `return handle` — the handle isn't constructed yet
            // (and everything already built has been cleaned up by dispose()).
            if (disposed) {
                rig.dispose()
                disposeObject(rig.scene)
                break
            }
            npcs[i].rig = rig
            npcs[i].group.add(rig.scene)
            npcs[i].armedClips = armedSet !== undefined && rig.listClipSets().includes(ARMED_SET_KEY)
            // An NPC can aggro while its avatar is still loading (the crowd is
            // simulated from the first tick), so the state it arrived at may
            // already be "drawn" — the transition check below only sees *changes*
            // and would leave it on the peace clips forever.
            if (npcs[i].armed && npcs[i].armedClips) rig.setClipSet(ARMED_SET_KEY, 0)
            // Attached after the rig is parented, because the hand's frame is
            // read relative to the group — the node whose +Z is forward — and
            // that needs the rig in the graph with live world matrices.
            if (weapon) npcs[i].gun = attachGun(rig, npcs[i].group, weapon, template)
        } catch (err) {
            console.warn(`[NpcEnemies] failed to load avatar for npc-${i}:`, err)
        }
    }

    if (!disposed) console.log(`[NpcEnemies] ${npcs.length} NPC(s) spawned`)

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /**
     * Where a shot is aimed: the player, lifted to chest height.
     *
     * Returned as a shared scratch vector — the pool reads it once per frame
     * inside `update`, and the aim maths copies out of it immediately, so there
     * is nothing to hold on to. It is also the point the hit test uses; aiming
     * at one height and testing against another would make every droplet sail
     * past the check (see `AIM_HEIGHT`).
     *
     * Gated on hostility so that a crowd turned peaceful mid-volley cannot still
     * splash the player: with no target the hit test simply never fires, and the
     * airborne droplets fall through to their floor recycle. Reaching a `fire()`
     * call already requires an armed NPC, so this only ever removes shots that
     * were in the air when the mode flipped.
     */
    const aimPoint = (): THREE.Vector3 | null => {
        if (!getHostile()) return null
        const player = getPlayerPosition()
        return player ? _aimPoint.set(player.x, player.y + AIM_HEIGHT, player.z) : null
    }

    /**
     * The chest point of one NPC — the mirror of `aimPoint` for the player's
     * fire control, which targets an NPC rather than the player.
     *
     * `group.position` is the agent's navmesh position, i.e. the feet, so the
     * lift is the same `AIM_HEIGHT` the crowd aims at on the player. Same
     * constant on both sides means a droplet that visibly reaches an NPC's chest
     * is the one recycled by the hit test.
     */
    const npcAimPoint = (npc: Npc, out: THREE.Vector3 = _npcAimPoint): THREE.Vector3 =>
        out.set(npc.group.position.x, npc.group.position.y + AIM_HEIGHT, npc.group.position.z)

    // ------------------------------------------------------------------
    // Health, death and respawn
    // ------------------------------------------------------------------

    /** Redraw a bar for the NPC's current health. Only call on a change. */
    const refreshBar = (npc: Npc) => {
        npc.bar.setFraction(npc.hp / Math.max(1, tunables.maxHp), npc.hp, tunables.maxHp)
    }

    /** Index into `npcs`, needed because respawn has to hand the agent back with
     *  the same id and the death clip is chosen by it. */
    const indexOf = (npc: Npc) => npcs.indexOf(npc)

    /**
     * Take an NPC out of the fight.
     *
     * Removing the agent is what actually stops it — the crowd is stepped every
     * frame, so an NPC left in the simulation would keep steering, keep facing
     * the player and (worst) keep *shooting* from the ground. The `agentId` null
     * is the flag every downstream pass already skips on.
     */
    const killNpc = (npc: Npc) => {
        if (npc.dead) return
        npc.dead = true
        npc.hp = 0
        npc.respawnTimer = Math.max(0, tunables.npcRespawnSeconds)
        npc.deathClipSeen = false
        npc.deathElapsed = 0
        npc.bar.setFraction(0, 0, tunables.maxHp)
        npc.bar.setVisible(false)

        if (npc.agentId) {
            crowd.removeAgent(state, npc.agentId)
            npc.agentId = null
        }
        // Shot down mid-jump: the body drops rather than hanging where the arc
        // left it, and its field goes with it. Step 3 skips a corpse (there is no
        // agent to place it from), so the lift would otherwise never be taken back
        // off — and the wave would keep turning the player's water after the NPC
        // that raised it was gone.
        npc.jumpOffset = 0
        npc.jumpVelocity = 0
        npc.fieldElapsed = NO_FIELD
        // Holstered, and `armed` cleared so the disarm survives whatever the mode
        // computation decides next; a corpse must not count toward the crowd's
        // armed tally either.
        setArmed(npc, false)
        if (npc.gun) npc.gun.mount.visible = false

        const clip = deathClipFor(Math.max(0, indexOf(npc)))
        if (!npc.rig) return
        // With no clip available there is nothing to animate, so the body is
        // removed on the spot rather than left standing over its own grave.
        if (clip) npc.rig.playEmotionOnce(clip)
        else npc.rig.scene.visible = false
    }

    /**
     * Bring an NPC back at full health, somewhere else on the navmesh.
     *
     * Re-added as a *new* agent rather than having the old one resurrected —
     * `removeAgent` takes the corridor and the boundary state with it, so there
     * is nothing left to restore into.
     */
    const respawnNpc = (npc: Npc) => {
        // Still falling. The death clips run longer than the respawn delay would
        // sometimes allow, and popping back up mid-collapse reads as a glitch, so
        // the clip gets to finish before the NPC is moved anywhere. Bounded by
        // `DEATH_ANIM_MAX_WAIT`: the clip is advanced every frame so it does end,
        // but an NPC left standing in the scene forever is a worse failure than
        // one that cuts its own fall short.
        if (npc.rig && npc.rig.isEmotionActive() && npc.deathElapsed < DEATH_ANIM_MAX_WAIT) {
            npc.respawnTimer = 0.25
            return
        }
        const spawn = spawnOnNavMesh()
        if (!spawn) {
            // Nowhere to put it. Keep it down and try again next frame rather
            // than dropping it at the origin, which could be off the navmesh.
            npc.respawnTimer = 0.5
            return
        }
        npc.dead = false
        npc.hp = tunables.maxHp
        npc.respawnTimer = 0
        npc.deathClipSeen = false
        npc.deathElapsed = 0
        npc.wanderAge = Infinity
        npc.chaseAge = 0
        npc.shotTimer = 0
        // The grudge ends with the life that held it. Cleared here rather than in
        // `killNpc` because this is where the NPC actually becomes a fresh one —
        // and a dead NPC is out of the simulation anyway (`agentId` is null, which
        // step 1 skips on), so a flag left set on a corpse is never read.
        npc.provoked = false
        // Same reasoning for the stun, with one twist: a stunned NPC *keeps* its
        // agent, so a stun caught mid-flight by a killing blow is never cleared by
        // the loop — the corpse leaves step 1 through the `!agentId` skip, and its
        // stun timer sits at whatever it had left. A respawn that inherited it
        // would walk the fresh NPC straight back into a freeze.
        npc.stunTimer = 0
        // The jump's own state, for the same reason and with one more: a corpse
        // keeps whatever lift it died with (step 3 never reaches it), so a
        // respawn that inherited it would drop the fresh NPC back onto the
        // navmesh from mid-air.
        npc.jumpOffset = 0
        npc.jumpVelocity = 0
        npc.jumpCooldown = 0
        npc.fieldElapsed = NO_FIELD
        npc.group.position.fromArray(spawn)
        npc.agentId = crowd.addAgent(state, navMesh, spawn, agentParams)
        if (npc.rig) npc.rig.scene.visible = true
        refreshBar(npc)
        npc.bar.setVisible(true)
    }

    /**
     * One droplet's worth of damage, through an `NpcTarget` handle.
     *
     * Returns whether it was the killing blow. Ignores an already-down NPC, so a
     * droplet still in the air when its target dies cannot re-kill it.
     */
    const damageNpc = (npc: Npc): boolean => {
        if (npc.dead) return false
        // The one place the crowd learns it is under attack. This is reachable
        // only through `NpcTarget.damage`, which only the player's droplet pool
        // calls — the crowd's own pool shoots at the player, not at each other —
        // so a hit here is unambiguously the player's doing, and no faction check
        // is needed to know whose it was.
        npc.provoked = true
        npc.hp = Math.max(0, npc.hp - tunables.dropletDamage)
        refreshBar(npc)
        if (npc.hp > 0) return false
        killNpc(npc)
        return true
    }

    // Droplets outlive no NPC in particular, so they are owned here rather than
    // per avatar (see npcProjectiles for the pooling rationale).
    //
    // Every droplet in this pool is aimed at the player, so the damage hook is
    // pool-wide rather than per shot — the mirror of the player's own pool, where
    // each shot may be locked onto a different NPC.
    /**
     * The nearest NPC that a world point is close to, or null.
     *
     * The whole of the bounce's targeting: "is this water next to anyone?". Asked
     * on XZ from the NPC's feet — the convention the field and the aggro test
     * use — while the point handed back is its chest, because that is what the
     * pool measures the droplet against, so a bounce passing at chest height
     * counts and one that sails over the head does not.
     *
     * Deliberately unbounded. The pool's own capture radius decides whether a
     * droplet is close enough to have hit anything; a range check here would be a
     * second opinion about the same thing, and the two would eventually disagree.
     */
    const nearestNpcTo = (position: THREE.Vector3): Npc | null => {
        let best: Npc | null = null
        let bestSq = Infinity
        for (const npc of npcs) {
            // A corpse is not a target: the water flies past it rather than
            // bursting on it for nothing.
            if (npc.dead) continue
            const dx = npc.group.position.x - position.x
            const dz = npc.group.position.z - position.z
            const distSq = dx * dx + dz * dz
            if (distSq < bestSq) {
                bestSq = distSq
                best = npc
            }
        }
        return best
    }

    /** Where a deflected droplet may hit — see `getBouncePoint`. */
    const bouncePoint = (position: THREE.Vector3): THREE.Vector3 | null => {
        const npc = nearestNpcTo(position)
        // Its own scratch, not `_npcAimPoint`: the player's lock-on reads that
        // one through the same helper, and aliasing them would leave a shot aimed
        // at whichever target was resolved last.
        return npc ? npcAimPoint(npc, _bouncePoint) : null
    }

    /** One droplet's worth of damage to whatever the water flew into — the
     *  mirror of `bouncePoint`, resolved the same way. See `onBounceHit`. */
    const bounceHit = (position: THREE.Vector3) => {
        const npc = nearestNpcTo(position)
        if (npc) damageNpc(npc)
    }

    const projectiles = createNpcProjectiles({
        scene,
        getTarget: aimPoint,
        onHit: () => onPlayerHit(),
        // The other side of the jump's force field: water blown back can hit
        // whichever of the crowd it flies into, and still cannot touch the player
        // — see `deflect`. This is what makes the pulse an attack and not just a
        // shove.
        getBouncePoint: bouncePoint,
        onBounceHit: bounceHit,
    })

    /**
     * Draw or holster, on the player's aggro and the armed master switch.
     *
     * Guarded on a change because it is the crossfade trigger. Safe to call
     * before the rig resolves: the flag is what the pose loop reads, and the
     * clip set is applied by the load loop for an NPC that aggroed mid-load.
     */
    const setArmed = (npc: Npc, next: boolean) => {
        if (npc.armed === next) return
        npc.armed = next
        // Re-arm the shot clock, so a fresh draw does not fire on its first
        // frame — and so a re-draw after losing the player starts the interval
        // again rather than resuming a part-spent one.
        npc.shotTimer = 0
        if (npc.rig && npc.armedClips) npc.rig.setClipSet(next ? ARMED_SET_KEY : BASE_SET_KEY)
    }

    /**
     * Take one shot: play the firing clip and squirt a droplet from the muzzle
     * at the player.
     *
     * The droplet is the point of the exercise — the clip alone reads as the
     * NPC miming — so it spawns even if the firing FBX is unavailable.
     */
    const fire = (npc: Npc) => {
        const gun = npc.gun
        if (!gun) return
        const aim = aimPoint()
        if (!aim) return
        if (FIRING_CLIP) npc.rig?.playEmotionOnce(FIRING_CLIP)

        // Read the muzzle *after* the mixers have run this frame (the caller
        // fires at the end of the pose pass), so the droplet leaves the barrel
        // where it is actually pointing rather than one frame behind.
        gun.muzzle.getWorldPosition(_muzzleWorld)
        projectiles.spawn(_muzzleWorld, aim, tunables.npcProjectileSpeed)
    }

    /** Point an NPC at its direction of travel. */
    const faceVelocity = (npc: Npc, agent: crowd.Agent, delta: number) => {
        const vx = agent.velocity[0]
        const vz = agent.velocity[2]
        if (Math.hypot(vx, vz) <= MOVING_SPEED) return
        // Same convention as the player: yaw from the XZ velocity. Three.js
        // `atan2(x, z)` matches the rig's own facing maths (NavMeshRig.tsx).
        _euler.set(0, Math.atan2(vx, vz), 0)
        _quat.setFromEuler(_euler)
        npc.group.quaternion.slerp(_quat, Math.min(1, _lerpFactor(delta) * 5))
    }

    /**
     * Turn an NPC to face the player — whole body, not just the gun.
     *
     * The gun is calibrated (every frame) to the group's forward, so yawing the
     * group is what swings the muzzle onto the player: there is nothing to aim
     * separately. Body and barrel turn together, which is what makes the threat
     * read from any distance.
     *
     * Yaw-only, matching `faceVelocity` and the player's own facing maths —
     * `atan2(x, z)` puts the group's +Z on the player. This is also why the
     * shot still lands: the barrel points horizontally at the player, and the
     * droplet's ballistic solve (`npcProjectiles.spawn`) supplies the small
     * upward correction to the chest. Pitching the body would tilt the whole
     * avatar, which reads worse than the ~centimetres it would gain.
     */
    const facePlayer = (npc: Npc, playerPos: THREE.Vector3, delta: number) => {
        const dx = playerPos.x - npc.group.position.x
        const dz = playerPos.z - npc.group.position.z
        // Standing on the player: `atan2(0, 0)` has no answer, and any heading
        // is as good as another, so keep the one we have rather than snapping.
        if (dx * dx + dz * dz < 1e-6) return
        _euler.set(0, Math.atan2(dx, dz), 0)
        _quat.setFromEuler(_euler)
        npc.group.quaternion.slerp(_quat, Math.min(1, _lerpFactor(delta) * 5))
    }

    /**
     * Is the muzzle actually on the player? The gate that makes aiming a
     * *precondition* of firing rather than a thing that usually happens.
     *
     * The muzzle rides the group's forward (`calibrateGun`), so this reduces to
     * the group's yaw against the horizontal direction to the player — no muzzle
     * world transform needed, and no `sqrt` until the final compare.
     */
    const aimedAtPlayer = (npc: Npc, playerPos: THREE.Vector3): boolean => {
        const dx = playerPos.x - npc.group.position.x
        const dz = playerPos.z - npc.group.position.z
        const horizontal = Math.hypot(dx, dz)
        // Coincident with the player: nothing to be off by, so don't block on it.
        if (horizontal < 1e-4) return true
        // The group's local +Z in world space. `facePlayer`/`faceVelocity` only
        // ever write yaw, so the quaternion carries no roll or pitch to undo.
        _forward.set(0, 0, 1).applyQuaternion(npc.group.quaternion)
        return (_forward.x * dx + _forward.z * dz) / horizontal >= AIM_TOLERANCE_COS
    }

    /** Blend the locomotion clips and advance the mixers. */
    const animate = (npc: Npc, agent: crowd.Agent, delta: number) => {
        const rig = npc.rig
        if (!rig) return
        const speed = Math.hypot(agent.velocity[0], agent.velocity[2])
        const moving = speed > MOVING_SPEED
        const running = moving && npc.mode === 'chase'
        const alpha = Math.min(1, _lerpFactor(delta) * 5)
        // The jump clip for the whole airborne arc, over whatever the legs were
        // doing — the same policy the player's rig applies, and the reason the
        // walk/run weights are zeroed here rather than left to blend underneath.
        // A dodging NPC is still *moving* (its agent never leaves the navmesh:
        // the lift is a render-time offset), so without this the jump would show
        // as a walk that happens to hover.
        const inAir = airborne(npc)
        rig.blend(
            {
                idle: inAir || moving ? 0 : 1,
                walk: !inAir && moving && !running ? 1 : 0,
                run: !inAir && running ? 1 : 0,
                jump: inAir ? 1 : 0,
            },
            alpha,
        )
        // Reveals the avatar on its first standing frame — see avatarLoader's
        // reveal gate. Must run every frame, including while still hidden.
        rig.advance(delta)
    }

    /** Give an NPC a fresh wander target somewhere else on the navmesh. */
    const scatter = (npc: Npc) => {
        if (!npc.agentId) return
        const random = randomNavMeshPoint(navMesh)
        // Still nothing after the retries: leave `wanderAge` alone so the next
        // tick tries again rather than resetting the timer on a failed pick.
        if (!random) return
        crowd.requestMoveTarget(state, npc.agentId, random.nodeRef, random.position)
        npc.wanderAge = 0
    }

    /** Aim an NPC at the player's current position. */
    const chase = (npc: Npc, playerPos: THREE.Vector3) => {
        if (!npc.agentId) return
        const hit = findNearestPoly(
            nearestScratch,
            navMesh,
            [playerPos.x, playerPos.y, playerPos.z],
            TARGET_HALF_EXTENTS,
            DEFAULT_QUERY_FILTER,
        )
        // The player can stand on a spot with no navmesh under it (mid-jump,
        // off the collider) — hold the last target rather than clearing it.
        if (!hit.success) return
        crowd.requestMoveTarget(state, npc.agentId, hit.nodeRef, hit.position)
        npc.chaseAge = 0
    }

    // ------------------------------------------------------------------
    // The jump's force field
    // ------------------------------------------------------------------
    // A ring sweeping out from where the player left the ground, acting on the
    // crowd and the crowd's water as it passes them. The state is a handful of
    // numbers rather than a per-NPC flag: the ring's own position *is* the memory
    // of what it has already hit — something is thrown when its distance falls in
    // this frame's slice of the sweep, and never again (see `ringJustCrossed`).
    let fieldActive = false
    let fieldElapsed = 0
    let fieldRadius = 0
    let fieldPush = 0
    let fieldStun = 0
    /** Where the ring is centred. Copied: the player keeps moving, and the wave
     *  does not travel with them. */
    const fieldOrigin = new THREE.Vector3()

    /**
     * Throw one NPC back from the field, and leave it dizzy.
     *
     * `dist` is the NPC's ground distance from the ring's centre, already known
     * to be inside it.
     */
    const throwBack = (npc: Npc, agent: crowd.Agent, dist: number) => {
        if (dist > 1e-4 && fieldPush > 0) {
            // An outward *impulse*, not a moved position. The crowd's integrator
            // takes it from here: it clamps the change in velocity to
            // `maxAcceleration`, and the stun below holds the speed cap at zero,
            // so the NPC slides out and decelerates into a stop. Writing the
            // position directly would instead teleport it — the whole 3 m in one
            // frame, which is what made the pulse look like a glitch rather than
            // a shove.
            const speed = shoveImpulse(agent.maxAcceleration, fieldPush)
            agent.velocity[0] = ((agent.position[0] - fieldOrigin.x) / dist) * speed
            agent.velocity[1] = 0
            agent.velocity[2] = ((agent.position[2] - fieldOrigin.z) / dist) * speed
        } else if (dist <= 1e-4) {
            // Dead centre of the field: no outward line to throw along. It is
            // still stopped and stunned, it just has nowhere in particular to go.
            agent.velocity[0] = 0
            agent.velocity[1] = 0
            agent.velocity[2] = 0
        }

        // The cap the stun keeps at zero for the next second, which is also what
        // lets the impulse above decay into a stop instead of steering fighting
        // it back the whole way.
        agent.maxSpeed = 0

        npc.stunTimer = fieldStun
        // The shot clock restarts, so an NPC caught mid-interval does not resume
        // by firing the instant it comes out of the stun.
        npc.shotTimer = 0

        // Last, so a clip that fails to load cannot cost the shove or the stun. A
        // stunned NPC with no clip is still stunned — see STUN_CLIP.
        //
        // Gated on the stun actually lasting, because the stun branch in step 1 is
        // the only thing that cuts this clip: at a stun of zero seconds it would
        // play out in full while the NPC walked away underneath it.
        if (fieldStun > 0 && STUN_CLIP) npc.rig?.playEmotionOnce(STUN_CLIP)
    }

    /**
     * Advance the ring, and let it hit whatever it has just reached.
     *
     * Runs at the top of `update`, ahead of the crowd's own step, so an impulse
     * applied here is carried by the simulation on this same frame.
     */
    const sweepField = (delta: number) => {
        if (!fieldActive) return

        const previousReach = sweepReach(fieldRadius, fieldElapsed)
        fieldElapsed += delta
        const reach = sweepReach(fieldRadius, fieldElapsed)

        // The crowd's water, as the edge passes it. Safe to call with a reach
        // that only grows: `deflect` turns inbound shots only, and a shot it has
        // already turned is travelling outward, so nothing can be caught twice.
        projectiles.deflect(fieldOrigin, reach)

        for (const npc of npcs) {
            // The same skip step 1 opens with: a downed NPC has no agent to throw.
            if (!npc.agentId) continue
            const agent = state.agents[npc.agentId]
            if (!agent) continue
            const dist = Math.hypot(agent.position[0] - fieldOrigin.x, agent.position[2] - fieldOrigin.z)
            // Not reached yet, or the wave is already past it.
            if (!ringJustCrossed(dist, previousReach, reach)) continue
            throwBack(npc, agent, dist)
        }

        if (fieldElapsed >= FORCE_FIELD_SWEEP_SECONDS) fieldActive = false
    }

    // ------------------------------------------------------------------
    // The crowd's jump defence
    // ------------------------------------------------------------------
    // The mirror of the player's field, and deliberately only half of it. An NPC
    // that jumps turns the player's inbound water back at the player — but it
    // throws and stuns nobody: the player is not a crowd agent, and taking their
    // movement away is a different kind of change than taking an NPC's.
    //
    // So there is no sweep state shared here as there is above: each NPC owns its
    // own `fieldElapsed`/`fieldOrigin`, because two of a crowd of six can be
    // airborne at once and a single pair of variables would have the second jump
    // move the first one's wave.

    /** In the air: the arc has started and has not landed. */
    const airborne = (npc: Npc) => npc.jumpOffset > 0 || npc.jumpVelocity > 0

    /**
     * Jump one NPC: launch the arc, and open its field where it stood.
     *
     * Only ever called from the ground (the trigger gates on it), so the arc
     * starts from a known-zero lift.
     */
    const jump = (npc: Npc) => {
        npc.jumpOffset = 0
        npc.jumpVelocity = NPC_JUMP_SPEED
        npc.jumpCooldown = tunables.npcJumpCooldown

        // Anchored where the NPC is standing and copied, not followed: the wave
        // does not travel with a body that walks on underneath it. Only the XZ
        // matters — `deflect` measures on the ground plane, like every other
        // distance in this module.
        npc.fieldOrigin.copy(npc.group.position)
        npc.fieldRadius = tunables.npcJumpFieldRadius
        npc.fieldElapsed = 0

        // Restart the clip past its anticipation crouch, exactly as the player's
        // jump does, so the pose matches a body already leaving the ground. The
        // crowd's armed clip set carries no jump of its own and falls back to the
        // base one (see `armedClipSet`).
        npc.rig?.startJumpAt(NPC_JUMP_CLIP_START)
    }

    /**
     * Sweep one NPC's field, turning the player's water as the edge reaches it.
     *
     * The same sweep the player's field runs, run per NPC and against the
     * player's pool rather than the crowd's own. No `ringJustCrossed` slice is
     * needed, unlike the player's sweep: this only ever calls `deflect`, which
     * acts on **inbound** water alone, and water it has already turned is
     * travelling away — so a reach that only grows cannot catch anything twice.
     */
    const advanceNpcField = (npc: Npc, delta: number, droplets: PlayerDroplets | null) => {
        if (npc.fieldElapsed === NO_FIELD) return
        npc.fieldElapsed += delta
        droplets?.deflect(npc.fieldOrigin, sweepReach(npc.fieldRadius, npc.fieldElapsed))
        if (npc.fieldElapsed >= FORCE_FIELD_SWEEP_SECONDS) npc.fieldElapsed = NO_FIELD
    }

    /**
     * Integrate one NPC's jump arc and write the lift onto its group.
     *
     * Called from the pose pass immediately after the group has been placed on
     * the navmesh, so the lift is added to *this* frame's surface position — the
     * group's `y` is overwritten from the agent every frame, which is what keeps
     * the arc from accumulating drift of its own.
     *
     * The lift rides `npc.group.position`, and every point that reads an NPC's
     * body reads that group (`npcAimPoint` included), so a jumping NPC genuinely
     * lifts its chest out of the way of a shot as well as turning it.
     */
    const advanceJump = (npc: Npc, delta: number) => {
        if (!airborne(npc)) return
        npc.jumpVelocity -= NPC_JUMP_GRAVITY * delta
        npc.jumpOffset += npc.jumpVelocity * delta
        // Landed. Both zero, which is the whole of "grounded" and what lets the
        // next jump start from a clean arc.
        if (npc.jumpOffset <= 0) {
            npc.jumpOffset = 0
            npc.jumpVelocity = 0
        }
        npc.group.position.y += npc.jumpOffset
    }

    // ------------------------------------------------------------------
    // Handle
    // ------------------------------------------------------------------

    const handle: NpcEnemies = {
        get group() {
            return root
        },

        /**
         * Walk up from `object` to the `npc-<index>` group the spawn loop named,
         * then hand back a handle onto that NPC's live chest point.
         *
         * The name is the index the crowd already uses to line its scene graph
         * up with `npcs[i]` (see `createNpcGroup`), so it is the one identifier
         * that survives outside this module without exposing the array.
         */
        targetFromObject(object: THREE.Object3D | null): NpcTarget | null {
            let node: THREE.Object3D | null = object
            // Stop at `root`, so an object outside the crowd (or the root itself)
            // resolves to null rather than matching something on the way up.
            while (node && node !== root) {
                const match = /^npc-(\d+)$/.exec(node.name)
                if (match) {
                    const npc = npcs[Number(match[1])]
                    if (!npc) return null
                    return {
                        // Null once down, which is also what makes a corpse
                        // un-targetable: the picker skips a target with no aim
                        // point, so a dead NPC cannot be clicked or shot at.
                        aimPoint: () => (disposed || npc.dead ? null : npcAimPoint(npc)),
                        damage: () => (disposed ? false : damageNpc(npc)),
                    }
                }
                node = node.parent
            }
            return null
        },

        setNavMesh(next: NavMesh) {
            if (disposed) return
            navMesh = next
            // The crowd is cheap to rebuild; the avatars are not. Keep them.
            state = crowd.create(NPC_RADIUS)
            for (const npc of npcs) {
                // A downed NPC must stay down. Its `agentId` is null, and
                // re-adding it here would teleport the corpse onto the new mesh
                // and drop it back into the fight; `respawnNpc` puts it back
                // against whichever mesh is live when its timer expires, so
                // nothing is lost by skipping it.
                if (npc.dead) continue
                const at: Vec3 = [npc.group.position.x, npc.group.position.y, npc.group.position.z]
                const hit = findNearestPoly(nearestScratch, next, at, TARGET_HALF_EXTENTS, DEFAULT_QUERY_FILTER)
                const spawn: Vec3 = hit.success ? hit.position : at
                npc.group.position.fromArray(spawn)
                npc.agentId = crowd.addAgent(state, next, spawn, agentParams)
                // Re-place them on the new mesh, then wander afresh from there.
                npc.mode = 'wander'
                npc.wanderAge = Infinity
            }
        },

        forceField(origin: THREE.Vector3) {
            if (disposed) return
            fieldRadius = tunables.forceFieldRadius
            if (!(fieldRadius > 0)) return // a disabled field turns nothing and moves nobody

            // Snapshotted rather than read per NPC as the wave sweeps: half a
            // crowd thrown by an old number and half by a new one, because a
            // lil-gui drag landed mid-sweep, is not a thing anyone could debug.
            fieldPush = tunables.forceFieldPush
            fieldStun = tunables.forceFieldStunSeconds
            // The wave is anchored where the player left the ground and does not
            // follow them, so this is copied — `forceField` is handed the rig's
            // live `playerGroup.position`, which moves a frame later.
            fieldOrigin.copy(origin)
            // A second jump mid-sweep restarts it, which is the honest read of two
            // pulses: the first is simply superseded. `sweepField` does the work
            // from here, a slice of the ring per frame.
            fieldElapsed = 0
            fieldActive = true
        },

        update(delta: number) {
            if (disposed || npcs.length === 0) return
            const playerPos = getPlayerPosition()
            const hostile = getHostile()
            // Resolved once per frame, not per NPC, and used for both halves of
            // the jump defence: what is coming at them (the trigger) and what
            // their own fields turn (the sweep).
            const droplets = getPlayerDroplets?.() ?? null

            // --- The jump's force field -------------------------------------
            // Ahead of the crowd's own step, so a throw applied here is integrated
            // on this frame rather than the next.
            sweepField(delta)

            // --- The crowd's own fields -------------------------------------
            // Every NPC's sweep, in the same pass and for the same reason: an
            // impulse or a turn applied here is carried by this frame's step.
            // These turn the *player's* water, so the reversal is integrated by
            // `playerCombat.update` on its own next call rather than here — one
            // frame late for a droplet that was already at the NPC it was aimed
            // at, which is a frame the field has, since the water has to survive
            // the turn before anything else can happen to it.
            for (const npc of npcs) advanceNpcField(npc, delta, droplets)

            // --- 0. The dead -----------------------------------------------
            // Ahead of everything else, because a downed NPC is a hole in the
            // crowd: no agent to step, no mode to decide, and a respawn that has
            // to land before the passes below look for one.
            for (const npc of npcs) {
                if (!npc.dead) continue
                npc.deathElapsed += delta
                if (npc.rig) {
                    // Drive the rig by hand. `animate` is the only other ticker
                    // and it needs an agent to read a velocity from, so a dead NPC
                    // — whose agent has been removed — would otherwise never reach
                    // it. A frozen mixer holds the death clip on its first frame:
                    // the fall is never drawn, `advanceEmotion` never counts to the
                    // end of the clip, and `emotionActiveFlag` latches true forever.
                    //
                    // Advancing unconditionally, rather than only while the body is
                    // visible, is deliberate: it is what guarantees that flag
                    // eventually clears, which is what the respawn below waits on.
                    npc.rig.advance(delta)

                    // The emotion path drops back to idle the instant a one-shot
                    // ends, so the body is removed when the clip finishes rather
                    // than left to stand back up. But `isEmotionActive` is also
                    // false *before* the clip is running — `playEmotionOnce`
                    // resolves its FBX through a promise — so hiding on
                    // `!isEmotionActive()` alone killed the body on the very next
                    // frame and drew the whole fall on an invisible avatar. Hence
                    // the latch: only a true→false transition counts as "finished".
                    // The elapsed-time backstop covers a clip that never arrives.
                    if (npc.rig.isEmotionActive()) npc.deathClipSeen = true
                    else if (npc.rig.scene.visible && (npc.deathClipSeen || npc.deathElapsed >= DEATH_ANIM_GRACE)) {
                        npc.rig.scene.visible = false
                    }
                }
                npc.respawnTimer -= delta
                if (npc.respawnTimer <= 0) respawnNpc(npc)
            }
            const aggro = tunables.npcAggroRadius || DEFAULT_AGGRO
            const scatterSeconds = tunables.npcScatterSeconds || DEFAULT_SCATTER_SECONDS
            // No gun refresh here any more: the rig hands us its weapon object
            // and mutates it in place, so `applyGunTuning` below reads the live
            // placement straight off it. (This block used to copy nine
            // `tunables.npcGun*` fields into a module-level mirror every frame.)

            // Live armed cadence. The rifle walk/run are authored slower than
            // the navmesh moves the NPCs, so their timescales are dialled from
            // the GUI; only push them into the rigs when a slider actually
            // moves, since this writes every live action's timescale.
            const armedWalk = tunables.npcArmedWalkTimescale
            const armedRun = tunables.npcArmedRunTimescale
            const armedCadenceChanged = armedTimeScale.walk !== armedWalk || armedTimeScale.run !== armedRun
            if (armedCadenceChanged) {
                armedTimeScale.walk = armedWalk
                armedTimeScale.run = armedRun
            }

            const armedEnabled = tunables.npcArmedEnabled
            const fireInterval = Math.max(0.1, tunables.npcFireInterval)
            const fireRange = tunables.npcFireRange || Infinity
            const fireRangeSq = fireRange * fireRange

            const aggroSq = aggro * aggro
            const standoff = tunables.npcStandoffDistance || STANDOFF_DISTANCE
            // The mode is decided every frame, but the aim only refreshes every
            // CHASE_REAIM_SECONDS — so a chasing NPC can close a further
            // (run speed x re-aim interval) before the check catches it, and
            // would otherwise end up standing almost on top of the player
            // (measured: a 1.8 m standoff settling at ~0.55 m). Budget for that
            // overshoot so the ring lands at roughly the intended distance.
            const holdRadius = standoff + NPC_RUN_SPEED * CHASE_REAIM_SECONDS
            const holdSq = holdRadius * holdRadius

            // --- 1. Decide targets, before the simulation steps -----------
            for (const npc of npcs) {
                if (!npc.agentId) continue
                const agent = state.agents[npc.agentId]
                if (!agent) continue

                // Stunned by the jump's force field. Handled ahead of the mode
                // decision because everything the stun has to suppress is
                // downstream of this branch: `continue` is what keeps the
                // `maxSpeed` write at the bottom of this loop from re-issuing the
                // NPC's chase speed, and what stops a dizzy NPC from picking a
                // wander target, re-aiming at the player, or re-deciding to chase.
                if (npc.stunTimer > 0) {
                    npc.stunTimer -= delta
                    // The cap is the whole of it, and it must *not* be joined by
                    // a zeroed velocity: this branch runs every frame of the stun,
                    // and the field's throw is an impulse that needs those frames
                    // to spend itself. Zeroing here would cut the shove off after
                    // a single frame — 11 cm of a 3 m throw. Speed zero is what
                    // stops the NPC: the steering asks for a velocity of nothing
                    // and the integrator brings the current one down to meet it at
                    // `maxAcceleration`, which is exactly the deceleration that
                    // turns the impulse into a slide that settles.
                    agent.maxSpeed = 0
                    // On the crossing frame only, and only while the stun's own
                    // clip is the one playing. The check earns its keep because
                    // the death clip supersedes the stun clip: cancelling *that*
                    // would leave a corpse standing, which is exactly what
                    // `respawnNpc`'s wait on `isEmotionActive` exists to prevent.
                    if (npc.stunTimer <= 0 && STUN_CLIP && npc.rig?.getEmotionId() === STUN_CLIP.id) {
                        npc.rig.cancelEmotion()
                    }
                    continue
                }

                // --- The jump defence -------------------------------------
                // Ahead of the mode decision, and deliberately so: jumping out of
                // the way of a shot is not a change of intent, so the NPC decides
                // where it is going on the same frame it leaves the ground.
                //
                // The cooldown ticks here rather than at the top of the loop,
                // which means it does not tick during a stun. That is the right
                // trade: a stunned NPC could not have jumped anyway, and returning
                // to the fight with a jump already owed is what makes the freeze
                // read as the field's doing rather than as a reset.
                npc.jumpCooldown -= delta
                if (
                    tunables.npcJumpDefenceEnabled &&
                    // Attack mode. The player can only fire while hostile, so this
                    // is mostly belt-and-braces — but it is what stops a crowd
                    // reacting to water still in the air from a fight that just
                    // ended, and it makes the switch mean the same thing here as it
                    // does everywhere else in this module.
                    hostile &&
                    npc.jumpCooldown <= 0 &&
                    !airborne(npc) &&
                    // The question the whole skill is triggered by: is one of the
                    // player's droplets closing on me? Read against the group's
                    // own position, which is where the water is aimed.
                    droplets?.inboundThreat(npc.group.position, tunables.npcJumpThreatRadius)
                ) {
                    jump(npc)
                }

                let next: NpcMode = 'wander'
                let distanceSq = Infinity
                // `hostile` is the player's attack mode, read per frame. A
                // peaceful crowd never even measures against the player, so
                // `next` stays `'wander'` — and everything else falls out of
                // that one fact: `setArmed(npc, armedEnabled && next !== 'wander')`
                // below holsters the gun, `agent.maxSpeed` stays at walk speed,
                // and facing reverts to the direction of travel.
                if (playerPos && hostile) {
                    const dx = agent.position[0] - playerPos.x
                    const dz = agent.position[2] - playerPos.z
                    distanceSq = dx * dx + dz * dz
                    // Within the radius, or already shot. The `provoked` half is
                    // what lets a hit from outside the radius start a chase — and
                    // it has to be here rather than at the distance test above,
                    // because `distanceSq` is still needed for the hold ring: a
                    // provoked NPC already standing at the standoff distance
                    // should be holding and firing, not walking into the player.
                    if (distanceSq < aggroSq || npc.provoked) {
                        next = distanceSq > holdSq ? 'chase' : 'hold'
                    }
                }

                const was = npc.mode
                npc.mode = next

                // Armed while it has the player's scent, holstered while
                // wandering — and the master switch forces peace everywhere.
                // Driven from the mode rather than from the transition, so
                // flipping the switch disarms a mid-chase crowd immediately.
                setArmed(npc, armedEnabled && next !== 'wander')

                // Pace by intent — and note that zeroing the cap is the only
                // way to stand an agent still. The crowd has no stop: its
                // `resetMoveTarget` merely abandons the target and leaves the
                // agent coasting along its existing corridor (measured ~3.4 s
                // of walking), which carries it straight through the player.
                // Re-aiming at the agent's own position does halt it, but
                // leaves the corridor degenerate so it never sets off again.
                // Clamping the speed cap stops it in place and, because the
                // corridor is untouched, raising the cap resumes the walk on
                // the very next frame.
                agent.maxSpeed = next === 'chase' ? NPC_RUN_SPEED : next === 'hold' ? 0 : NPC_WALK_SPEED

                if (next === 'chase') {
                    npc.chaseAge += delta
                    if (npc.chaseAge >= CHASE_REAIM_SECONDS) chase(npc, playerPos!)
                } else if (next === 'hold') {
                    // Close enough — already standing still via the cap above,
                    // and deliberately not re-aimed, so the NPC waits where it
                    // is instead of pressing into the player. Reset the re-aim
                    // timer so a chase resumes promptly once the player moves
                    // back out of standoff range.
                    if (was !== 'hold') npc.chaseAge = 0
                } else {
                    // Wandering. Coming back from a chase, `wanderAge` is left at
                    // Infinity so a new target is picked on this very tick.
                    npc.wanderAge += delta
                    const arrived = crowd.isAgentAtTarget(state, npc.agentId, ARRIVED_THRESHOLD)
                    if (arrived || npc.wanderAge >= scatterSeconds) scatter(npc)
                }
            }

            // --- 2. Step the crowd ----------------------------------------
            crowd.update(state, navMesh, delta)

            // --- 3. Pose from the updated agent state ---------------------
            for (const npc of npcs) {
                // Guns ride the hand bone, so they need no posing — only the
                // live placement, which is what makes the sidebar sliders
                // immediate. `weapon` is the rig's own object, kept current by
                // its store subscription.
                if (npc.gun && weapon) {
                    applyGunTuning(npc.gun, weapon)
                    // Holstered in peace. Written *after* the placement pass,
                    // which owns `visible` (through `enabled`) and runs every
                    // frame; this only ever narrows what that pass allowed.
                    npc.gun.mount.visible = weapon.enabled && npc.armed
                }
                if (armedCadenceChanged && npc.armedClips) {
                    npc.rig?.setClipSetTimeScale(ARMED_SET_KEY, armedTimeScale)
                }

                if (!npc.agentId) continue
                const agent = state.agents[npc.agentId]
                if (!agent) continue
                npc.group.position.fromArray(agent.position)
                // After the placement, never before: the agent's position is the
                // surface and the arc is a lift above it.
                advanceJump(npc, delta)
                // Armed NPCs keep the player at gunpoint with their whole body —
                // this is the aim the shot below is gated on. It replaces (does
                // not compose with) the travel facing, because the two disagree:
                // `faceVelocity` early-returns under `MOVING_SPEED`, so an NPC
                // standing at the standoff ring would otherwise keep whichever
                // heading it happened to arrive on and fire across its shoulder.
                // Peaceful NPCs still face where they are going.
                // A stunned NPC is the one case where an armed NPC does *not* keep
                // the player at gunpoint: a dizzy body tracking you with its head
                // reads as a glare, not as a stagger. It falls through to
                // `faceVelocity`, which holds the heading on the zeroed velocity.
                if (npc.armed && playerPos && npc.stunTimer <= 0) facePlayer(npc, playerPos, delta)
                else faceVelocity(npc, agent, delta)
                animate(npc, agent, delta)

                // Keep the gun aimed along the character's forward, on every
                // frame — `calibrateGun` re-derives the mount's *local* rotation
                // so the gun's world rotation is `forwardRoot`'s, which means
                // re-running it cancels whatever the hand did in this frame's
                // pose. Runs after `animate` so it reads the pose of the frame
                // being drawn, not the last one.
                //
                // Unconditional because the pose the aim is taken from is only
                // ever wrong *before* the first standing frame: an NPC spawns
                // walking, so gating on "is it parked" left the spawn walk and
                // the blend into the idle holding the home-pose default (up to
                // the old 4 s fallback) — visibly the wrong pose at the start,
                // which is exactly the frame the player first sees.
                //
                // The trade: the gun holds its aim while the hand rotates under
                // it, so it no longer swings with the arm. A walking NPC reads
                // as keeping the muzzle on target rather than carrying the gun
                // at its side.
                if (npc.gun) calibrateGun(npc.gun)

                // Fire on the cadence, but only from the standoff ring: a
                // chasing NPC is still closing the distance and a shot mid-
                // stride reads as a stumble. `hold` is the stance that is
                // already standing still, so the muzzle is settled.
                //
                // `aimedAtPlayer` is the "aim, then shoot" gate: the shot waits
                // until `facePlayer` above has actually swung the muzzle onto
                // the player. It is a check on the pose of *this* frame — read
                // after the turn and the mixers — so a shot can never leave the
                // barrel before the barrel points. The wait is short (the turn
                // converges in a handful of frames) but it is what closes the
                // gap where a just-aggroed NPC fires the instant it stops.
                // `npc.stunTimer` is on this gate as well as the one in step 1:
                // the stun deliberately leaves `npc.mode` at whatever it was (it
                // skips the mode write rather than faking one), so an NPC stunned
                // mid-`hold` would otherwise sail straight through the `mode ===
                // 'hold'` test below and keep firing while dizzy.
                if (npc.armed && npc.gun && playerPos && npc.stunTimer <= 0) {
                    const dx = playerPos.x - npc.group.position.x
                    const dz = playerPos.z - npc.group.position.z
                    const inRange = dx * dx + dz * dz <= fireRangeSq
                    if (npc.mode === 'hold' && inRange && aimedAtPlayer(npc, playerPos)) {
                        // Fires last, after the mixers have posed this frame, so
                        // the droplet leaves the muzzle where it is now
                        // pointing (see `fire`).
                        npc.shotTimer += delta
                        if (npc.shotTimer >= fireInterval) {
                            npc.shotTimer = 0
                            fire(npc)
                        }
                    } else {
                        // Cleared out of the stance: hold the shot clock at zero
                        // so settling back in takes a full interval rather than
                        // firing instantly.
                        npc.shotTimer = 0
                    }
                }
            }

            projectiles.update(delta)
        },

        dispose() {
            if (disposed) return
            disposed = true
            // Frees the droplet pool's shared geometry/material — it is owned
            // here, not by any avatar, so the per-NPC teardown below misses it.
            projectiles.dispose()
            for (const npc of npcs) {
                if (npc.agentId) crowd.removeAgent(state, npc.agentId)
                npc.agentId = null
                // Each bar owns a material and a canvas texture of its own, and
                // `disposeObject` above only walks meshes — a Sprite is not one —
                // so this does not happen by accident.
                npc.bar.dispose()
                // AvatarRig.dispose stops the mixers and detaches the head; the
                // GPU resources under `scene` are this module's to release.
                if (npc.rig) {
                    npc.rig.dispose()
                    disposeObject(npc.rig.scene)
                    npc.rig = null
                }
                npc.group.clear()
            }
            npcs.length = 0
            scene.remove(root)
        },
    }

    return handle
}

// ---------------------------------------------------------------------------
// Scratch objects — allocation-free per frame
// ---------------------------------------------------------------------------

const _quat = new THREE.Quaternion()
const _euler = new THREE.Euler()

/** The group's forward, read by the aim gate (see `aimedAtPlayer`). */
const _forward = new THREE.Vector3()

/** Aim point for the projectile pool's `getTarget` (see `aimPoint`). */
const _aimPoint = new THREE.Vector3()

/** The mirror of `_aimPoint` for the player shooting an NPC (see `npcAimPoint`). */
const _npcAimPoint = new THREE.Vector3()

/**
 * Where a deflected droplet is being aimed, kept apart from `_npcAimPoint`
 * because both are live in the same frame: the player's lock reads the latter
 * and the bounce reads this, and one scratch serving both would have the two
 * shots aiming at each other's target.
 */
const _bouncePoint = new THREE.Vector3()

/** Muzzle world position, read once per shot. */
const _muzzleWorld = new THREE.Vector3()

/**
 * The armed set's live cadence, compared against the settings each frame so the
 * rigs are only re-timed when a slider moves — no allocation per frame.
 */
const armedTimeScale: Partial<Record<LocomotionKey, number>> = { walk: 1, run: 1 }

/**
 * Frame-rate-independent lerp factor, matching the rig's own
 * `t = 1 - 0.01 ** clamped` (NavMeshRig.tsx) so NPC turning and clip
 * crossfades feel the same as the player's.
 */
function _lerpFactor(delta: number): number {
    return 1 - Math.pow(0.01, delta)
}
