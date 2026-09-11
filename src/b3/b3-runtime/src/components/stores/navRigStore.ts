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
}

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
        npcCount: 5,
        npcAggroRadius: 12,
        npcScatterSeconds: 6,
        npcStandoffDistance: 5,
        npcArmedEnabled: true,
        npcFireInterval: 0.8,
        npcFireRange: 14,
        npcProjectileSpeed: 8,
        npcArmedWalkTimescale: 3.6,
        npcArmedRunTimescale: 1.5,
    },

    zoomRadius: 0,
    stick: { x: 0, y: 0 },
    running: false,
    emotionRequest: null,
    jumpRequest: null,

    setStick: (stick) => set({ stick }),

    setRunning: (running) => set({ running }),

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
