import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Nav Rig Store
// ---------------------------------------------------------------------------
// Shared state for the NavMeshRig camera + character controls.
//
// `settings` is a plain mutable object bound directly by lil-gui (which reads
// and writes properties in place) and read every frame by the rig's frame
// loop. `zoomRadius` is the wheel / pinch dolly distance along the camera
// follow axis — owned by the store so the follow loop and the input handlers
// stay in sync without prop-drilling or module-level mutable singletons.

interface NavRigSettings {
    showNavMeshHelper: boolean
    showAgentHelper: boolean
    cellSize: number
    cellHeight: number
    walkableRadius: number
    walkableSlopeAngle: number
    walkableClimb: number
    walkableHeight: number
    walkingSpeed: number
    runningSpeed: number
    offsetAbove: number
    offsetBehind: number

    /** How many NPC enemies to spawn. Applied on spawn / respawn — each one
     *  loads its own composed avatar, which is far too costly to do live. */
    npcCount: number
    /** Distance at which an NPC notices the player and gives chase, in world
     *  units. Beyond it the NPC resumes wandering. */
    npcAggroRadius: number
    /** How long an NPC walks a wander target before being re-scattered to a new
     *  random point on the navmesh. */
    npcScatterSeconds: number
    /** How close a chasing NPC closes before it stops and holds, in world units
     *  — the distance it actually attacks from. Must stay inside
     *  `npcFireRange` for an armed NPC to shoot from the ring; the crowd aims
     *  a little wide of this so the overshoot lands on it (see `npcEnemies`). */
    npcStandoffDistance: number

    /** Master switch for the armed / peace states. Off leaves the whole crowd
     *  holstered and wandering, whatever its aggro state. Applied live. */
    npcArmedEnabled: boolean
    /** Seconds between shots while an armed NPC holds at the standoff ring. */
    npcFireInterval: number
    /** An armed NPC only shoots a player closer than this, in world units. */
    npcFireRange: number
    /** Water droplet muzzle velocity, world units / second. */
    npcProjectileSpeed: number
    /** Cadence of the rifle-holding walk / run clips. The armed pack is authored
     *  slower than the navmesh moves the NPCs, so matching the feet to the ground
     *  needs a multiplier well above 1 — otherwise they visibly skate. Derived
     *  from the clips' own root travel (walk ≈ 0.61 m/s authored against the
     *  crowd's 2.2 m/s; run ≈ 2.96 m/s against 4.5). Applied live. */
    npcArmedWalkTimescale: number
    npcArmedRunTimescale: number

    /** Cadence of the *player's* rifle-holding walk / run clips, in the armed
     *  set. Separate from the NPC pair above because the two move at different
     *  speeds — the armed pack is authored around 0.61 m/s walking and 2.96 m/s
     *  running, so the multiplier is `movementSpeed / authoredSpeed` and the
     *  crowd's 2.2 / 4.5 is not the player's 4 / 8. Reusing the NPC values
     *  makes the player visibly skate. Seeded from that ratio (≈ 6.5 / 2.7);
     *  these are arithmetic, not measured, so dial them in against the feet.
     *  Applied live. */
    playerArmedWalkTimescale: number
    playerArmedRunTimescale: number

    /** Health every character starts with. Ten droplets at `dropletDamage`. */
    maxHp: number
    /** Damage one water droplet does on contact. */
    dropletDamage: number
    /** How long a downed NPC lies there before coming back at full health. */
    npcRespawnSeconds: number
    /** How long the player stays down before reviving. */
    playerRespawnSeconds: number

    /** How many health crates stand on the floor. Live: the pool is sized to
     *  `CRATE_POOL_SIZE` and this only decides how many are shown. */
    crateCount: number
    /** Fraction of `maxHp` one crate restores. 1 = a full restore. A fraction
     *  rather than an absolute amount so it cannot drift out of step when
     *  `maxHp` is changed — an absolute would silently stop being "full". */
    crateHealFraction: number
    /** How close the player has to get to a crate for it to trigger, in world
     *  units. Measured on the ground plane, ignoring height. */
    cratePickupRadius: number
    /** How long a taken crate stays gone before reappearing somewhere else. */
    crateRespawnSeconds: number
}

/** How many crate meshes are pooled. The `crateCount` slider's maximum — the
 *  pool is built once at this size and shown/hidden, so a live slider change
 *  never allocates or disposes geometry. */
export const CRATE_POOL_SIZE = 8

interface NavRigState {
    settings: NavRigSettings

    /** Dolly distance along the follow axis — >0 pulls the camera toward the
     *  player, <0 pushes it out. 0 = default follow distance. The resulting
     *  camera distance is clamped to [MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE]. */
    zoomRadius: number

    /** Move the dolly distance by `delta` world units; passing through 0
     *  releases the camera back to the default follow distance. */
    dolly: (delta: number) => void

    /** On-screen joystick deflection (-1..1 per axis). y > 0 = up = forward.
     *  Written by the bottom-centre joystick, read every frame by the rig's
     *  movement loop so it steers the character like WASD. */
    stick: { x: number; y: number }

    /** Replace the current joystick deflection (0,0 on release/unmount). */
    setStick: (value: { x: number; y: number }) => void

    /** Run toggle set by the bottom-left Walk/Run button — when true the
     *  character moves at `runningSpeed` without holding Shift (like Shift held
     *  the whole time). Defaults to false (walk). */
    running: boolean

    /** Turn the run toggle on/off. */
    setRunning: (running: boolean) => void

    /** Attack mode, set by the X key or the bottom-left button. While true the
     *  player holds a water gun and can shoot the crowd, and the crowd treats
     *  the player as hostile; while false (the default) the player is unarmed
     *  and the crowd ignores them entirely. Read every frame by the rig and by
     *  the crowd's `getHostile`, so it never needs a rebuild. */
    attackMode: boolean

    /** Turn attack mode on/off. */
    setAttackMode: (attackMode: boolean) => void

    /** Flip attack mode — the X key / button action. */
    toggleAttackMode: () => void

    /** The player's health, 0..`settings.maxHp`. Lives here rather than beside
     *  the NPCs' because the player HUD is a React component and has to render
     *  it; the crowd's NPCs each own theirs privately. */
    playerHp: number

    /** Take one droplet's damage. Clamped at 0. */
    damagePlayer: (amount: number) => void

    /** Restore health — the health-crate pickup. Clamped at `settings.maxHp`. */
    healPlayer: (amount: number) => void

    /** Back to full health — the revive after being downed. */
    resetPlayerHp: () => void

    /** Last one-shot gesture/dance requested by an emotion button. `nonce`
     *  advances on every request so even the same gesture can be re-triggered;
     *  NavMeshRig consumes it once per nonce and plays the clip then returns to
     *  the idle state. */
    emotionRequest: { def: EmotionDef; nonce: number } | null

    /** Fire a one-shot gesture/dance once — the rig plays the clip, then blends
     *  back to the idle locomotion state. */
    requestEmotion: (def: EmotionDef) => void

    /** One-shot jump requested by the on-screen button. `nonce` advances on every
     *  request so a quick re-tap is never swallowed; NavMeshRig consumes it once
     *  per nonce, exactly like the Space key. */
    jumpRequest: { nonce: number } | null

    /** Fire a single jump — one impulse per tap (the rig only jumps while
     *  grounded and not mid-gesture). */
    requestJump: () => void
}

/** A one-shot emotion (dance / gesture) mapped to an on-screen button. */
export interface EmotionDef {
    /** Unique id used as the clip name when loaded. */
    id: string
    /** Stable clip identifier fed to the avatar rig (must match the FBX name). */
    name: string
    /** `/char/...` URL of the gesture/dance FBX. */
    url: string
    /** Short button label (tooltip / a11y). */
    label: string
    /** Skip this many seconds of clip preamble (e.g. a "get up from the floor"
     *  intro) so the one-shot starts from the standing pose. */
    startAt?: number
    /** True for dances: the clip loops in place until the same button is tapped
     *  again (or another emotion is picked), and the character keeps steering/
     *  walking while it plays. Gestures default to one-shot then idle. */
    dance?: boolean
}

/** Min / max camera distance from the player (world units). */
export const MIN_CAMERA_DISTANCE = 0.5
export const MAX_CAMERA_DISTANCE = 200

/** Starting (and revived) health. Exported because the initial `playerHp` and
 *  the `maxHp` tunable have to agree, and `settings` cannot reference itself
 *  from inside its own initialiser. */
export const DEFAULT_MAX_HP = 100

export const useNavRigStore = create<NavRigState>((set, get) => ({
    settings: {
        showNavMeshHelper: false,
        showAgentHelper: false,
        cellSize: 0.1,
        cellHeight: 0.1,
        walkableRadius: 0.3,
        walkableSlopeAngle: 45,
        walkableClimb: 0.2,
        walkableHeight: 1.5,
        walkingSpeed: 4,
        runningSpeed: 8,
        offsetAbove: 15,
        offsetBehind: 10,
        npcCount: 6,
        npcAggroRadius: 12,
        npcScatterSeconds: 6,
        npcStandoffDistance: 5,
        npcArmedEnabled: true,
        npcFireInterval: 0.8,
        npcFireRange: 14,
        npcProjectileSpeed: 8,
        npcArmedWalkTimescale: 3.6,
        npcArmedRunTimescale: 1.5,
        playerArmedWalkTimescale: 6.5,
        playerArmedRunTimescale: 2.7,
        maxHp: DEFAULT_MAX_HP,
        dropletDamage: 10,
        npcRespawnSeconds: 4,
        playerRespawnSeconds: 4,
        crateCount: 4,
        crateHealFraction: 1,
        cratePickupRadius: 0.5,
        crateRespawnSeconds: 8,
    },

    zoomRadius: 0,
    stick: { x: 0, y: 0 },
    running: false,
    attackMode: false,
    playerHp: DEFAULT_MAX_HP,
    emotionRequest: null,
    jumpRequest: null,

    setStick: (stick) => set({ stick }),

    setRunning: (running) => set({ running }),

    setAttackMode: (attackMode) => set({ attackMode }),

    toggleAttackMode: () => set((s) => ({ attackMode: !s.attackMode })),

    // Clamped at 0 rather than going negative: the rig watches for the crossing
    // to zero to trigger the death beat, and a value that keeps falling would
    // re-trigger it on every hit landed on an already-downed player.
    damagePlayer: (amount) =>
        set((s) => ({ playerHp: Math.max(0, s.playerHp - amount) })),

    // The outer `max` earns its keep: a bare `min(maxHp, hp + amount)` would
    // *lower* the player's health if it ever sat above `maxHp` — which is what
    // a heal would do the moment anyone drops `maxHp` below the current HP.
    // Healing must never be able to hurt.
    healPlayer: (amount) =>
        set((s) => ({
            playerHp: Math.max(s.playerHp, Math.min(s.settings.maxHp, s.playerHp + amount)),
        })),

    resetPlayerHp: () => set({ playerHp: get().settings.maxHp }),

    requestEmotion: (def) =>
        set((s) => ({
            emotionRequest: { def, nonce: (s.emotionRequest?.nonce ?? 0) + 1 },
        })),

    requestJump: () =>
        set((s) => ({
            jumpRequest: { nonce: (s.jumpRequest?.nonce ?? 0) + 1 },
        })),

    dolly: (delta) => {
        const { zoomRadius, settings } = get()
        // Camera distance = base follow offset length − zoomRadius; clamp the
        // radius so the distance stays within [MIN, MAX] for the current offset
        // (which the GUI can change live).
        const base = Math.hypot(settings.offsetAbove, settings.offsetBehind)
        const minRadius = base - MAX_CAMERA_DISTANCE
        const maxRadius = base - MIN_CAMERA_DISTANCE
        const next = zoomRadius + delta
        set({
            zoomRadius: zoomRadius !== 0 && zoomRadius * next <= 0 ? 0 : Math.min(maxRadius, Math.max(minRadius, next)),
        })
    },
}))
