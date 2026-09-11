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
    findRandomPoint,
    type FindNearestPolyResult,
    type NavMesh,
} from 'navcat'
import { crowd } from 'navcat/blocks'
import { BASE_SET_KEY, loadAvatar, type AvatarRig, type ClipSetConfig, type LocomotionKey } from './avatarLoader'
import { applyGunTuning, attachGun, calibrateGun, loadWeaponTemplate, type NpcGun, type NpcWeapon } from './npcProps'
import { createNpcProjectiles } from './npcProjectiles'
import {
    makeDefaultManifest,
    MOTION_SECTIONS,
    partsFor,
    type Gender,
    type MotionClipDef,
} from '../b3/b3-runtime/src/components/AvatarSDK'

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

/** Below this speed an NPC is treated as standing still and blends to idle. */
const MOVING_SPEED = 0.05

/**
 * Height above the player's origin that the NPCs shoot at — roughly the chest of
 * a ~1.7 m avatar. Same point is used for the aim and for the pool's hit test,
 * so a droplet that visibly reaches the player is also the one that is
 * recycled; aiming at the chest but testing against the feet would sail every
 * shot past the check.
 */
const AIM_HEIGHT = 1.1

// ---------------------------------------------------------------------------
// Armed clip set
// ---------------------------------------------------------------------------

/**
 * One clip from a named SDK motion section, so the paths live in the SDK's
 * registry (`MOTION_SECTIONS`) rather than being spelled out here. The def name
 * is prefixed because it also becomes the `AnimationClip`'s name and the
 * `loadMotionClips` result key — a set's names must be unique within that set.
 */
function sectionClip(sectionId: string, name: string): MotionClipDef | null {
    const section = MOTION_SECTIONS.find((s) => s.id === sectionId)
    if (!section) return null
    return { name: `armed-${name}`, url: `${section.baseUrl}/${name}.fbx` }
}

/**
 * The rifle-holding locomotion set an NPC switches to when it draws. Taken from
 * the user's chosen clips: `gun/idle-aiming`, `shooter/walking`,
 * `gun/run-forward`.
 *
 * The idle is the *aiming* variant rather than plain `gun/idle`: this pose is
 * what an armed NPC holds at the standoff ring, where it is pointing the gun at
 * the player, so the raised sights read as aiming.
 *
 * `jump` is deliberately omitted, so the set falls back to the base jump clip —
 * there is no armed jump in the pack, and the caller's launch frame stays valid.
 */
function armedClipSet(): { clips: Partial<Record<LocomotionKey, MotionClipDef>> } | null {
    const idle = sectionClip('rifle', 'idle-aiming')
    const walk = sectionClip('shooter', 'walking')
    const run = sectionClip('rifle', 'run-forward')
    if (!idle || !walk || !run) {
        console.warn('[NpcEnemies] armed clip set incomplete — NPCs will stay in peace')
        return null
    }
    return { clips: { idle, walk, run } }
}

/** The firing one-shot, played through the rig's emotion path. */
const FIRING_CLIP: MotionClipDef | null = sectionClip('shooter', 'firing-rifle')

/** Key of the rifle-holding set, as handed to `loadAvatar` and `setClipSet`. */
const ARMED_SET_KEY = 'armed'

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
}

export interface NpcEnemiesOptions {
    scene: THREE.Scene
    navMesh: NavMesh
    /** How many NPCs to spawn. */
    count: number
    /** Live player position, or null before the player exists. */
    getPlayerPosition: () => THREE.Vector3 | null
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
     * Re-base onto a freshly generated navmesh, keeping the loaded avatars.
     * The rig replaces its `navMesh` wholesale when the collider changes, so a
     * crowd built against the old one would be steering agents on a mesh that
     * no longer has anything to do with the scene.
     */
    setNavMesh(navMesh: NavMesh): void
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

/** Deterministic-ish spawn variation so NPCs don't all wear the same face. */
function pickVariant<T>(pool: T[], index: number): T | null {
    if (pool.length === 0) return null
    return pool[index % pool.length]
}

/**
 * Build the scene group for one NPC, choosing a body × face look from the
 * avatar library's catalog for its gender. Male and female alternate so the
 * crowd reads as mixed, and the body/face indices are offset differently so
 * repeated genders don't come out identical.
 */
function createNpcGroup(index: number): THREE.Group {
    const group = new THREE.Group()
    group.name = `npc-${index}`
    return group
}

/** Resolve the manifest for an NPC from the avatar library, or null when the
 *  catalog has nothing for that gender (defensive — the pools are populated). */
function manifestFor(index: number) {
    const gender: Gender = index % 2 === 0 ? 'male' : 'female'
    const body = pickVariant(partsFor(gender, 'body'), index)
    const face = pickVariant(partsFor(gender, 'face'), index)
    if (!body || !face) return null
    return makeDefaultManifest({
        name: `npc-${index}`,
        gender,
        assets: { body: body.url, face: face.url },
    })
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createNpcEnemies(opts: NpcEnemiesOptions): Promise<NpcEnemies> {
    const { scene, getPlayerPosition, tunables, weapon } = opts
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
     * A random walkable point, with retries — because `findRandomPoint` reports
     * failure on a point it actually found.
     *
     * It picks a polygon by area-weighted reservoir sampling, then rejects its
     * own result with `if (!selectedPoly || !selectedPolyRef)`. Node refs are
     * 1-based everywhere except the **first polygon of a tile, whose ref is
     * literally 0** — so every time the sampling happens to keep that polygon,
     * a perfectly good point is thrown away as `success: false`. Measured at
     * 6.4% on a 7-polygon mesh (it is just the odds that polygon 0 survives,
     * so it varies with that polygon's area share — higher on coarser meshes).
     *
     * One attempt per NPC would therefore under-spawn the crowd for no reason.
     * Eight is ample: 0.064^8 is about 3e-10.
     */
    const randomPoint = () => {
        for (let attempt = 0; attempt < 8; attempt++) {
            const random = findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, Math.random)
            if (random.success) return random
        }
        return null
    }

    /**
     * Where to drop a new NPC.
     *
     * The fallback is unreachable in practice (see `randomPoint`) but must not
     * be the player's own position: an NPC spawned inside the standoff ring
     * enters `hold` immediately and never moves again, so the crowd would look
     * broken. Put it at arm's length in a random direction instead.
     */
    const spawnOnNavMesh = (): Vec3 | null => {
        const random = randomPoint()
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

        const agentId = crowd.addAgent(state, navMesh, spawn, agentParams)
        npcs.push({
            group,
            rig: null,
            gun: null,
            agentId,
            mode: 'wander',
            wanderAge: Infinity,
            chaseAge: 0,
            armed: false,
            armedClips: false,
            shotTimer: 0,
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
        if (!manifest) {
            console.warn(`[NpcEnemies] no catalog look for npc-${i}`)
            continue
        }
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
     */
    const aimPoint = (): THREE.Vector3 | null => {
        const player = getPlayerPosition()
        return player ? _aimPoint.set(player.x, player.y + AIM_HEIGHT, player.z) : null
    }

    // Droplets outlive no NPC in particular, so they are owned here rather than
    // per avatar (see npcProjectiles for the pooling rationale).
    const projectiles = createNpcProjectiles({ scene, getTarget: aimPoint })

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

    /** Blend the locomotion clips and advance the mixers. */
    const animate = (npc: Npc, agent: crowd.Agent, delta: number) => {
        const rig = npc.rig
        if (!rig) return
        const speed = Math.hypot(agent.velocity[0], agent.velocity[2])
        const moving = speed > MOVING_SPEED
        const running = moving && npc.mode === 'chase'
        const alpha = Math.min(1, _lerpFactor(delta) * 5)
        rig.blend(
            {
                idle: moving ? 0 : 1,
                walk: moving && !running ? 1 : 0,
                run: running ? 1 : 0,
                jump: 0,
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
        const random = randomPoint()
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
    // Handle
    // ------------------------------------------------------------------

    const handle: NpcEnemies = {
        get group() {
            return root
        },

        setNavMesh(next: NavMesh) {
            if (disposed) return
            navMesh = next
            // The crowd is cheap to rebuild; the avatars are not. Keep them.
            state = crowd.create(NPC_RADIUS)
            for (const npc of npcs) {
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

        update(delta: number) {
            if (disposed || npcs.length === 0) return
            const playerPos = getPlayerPosition()
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

                let next: NpcMode = 'wander'
                let distanceSq = Infinity
                if (playerPos) {
                    const dx = agent.position[0] - playerPos.x
                    const dz = agent.position[2] - playerPos.z
                    distanceSq = dx * dx + dz * dz
                    if (distanceSq < aggroSq) {
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
                faceVelocity(npc, agent, delta)
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
                if (npc.armed && npc.gun && playerPos) {
                    const dx = playerPos.x - npc.group.position.x
                    const dz = playerPos.z - npc.group.position.z
                    const inRange = dx * dx + dz * dz <= fireRangeSq
                    if (npc.mode === 'hold' && inRange) {
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

/** Aim point for the projectile pool's `getTarget` (see `aimPoint`). */
const _aimPoint = new THREE.Vector3()

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
