import { create } from "zustand";

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
  showNavMeshHelper: boolean;
  showAgentHelper: boolean;
  cellSize: number;
  cellHeight: number;
  walkableRadius: number;
  walkableSlopeAngle: number;
  walkableClimb: number;
  walkableHeight: number;
  walkingSpeed: number;
  runningSpeed: number;
  offsetAbove: number;
  offsetBehind: number;
}

interface NavRigState {
  settings: NavRigSettings;

  /** Dolly distance along the follow axis — >0 pulls the camera toward the
   *  player, <0 pushes it out. 0 = default follow distance. The resulting
   *  camera distance is clamped to [MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE]. */
  zoomRadius: number;

  /** Replace one or more settings fields (used by the lil-gui controls). */
  set: (patch: Partial<NavRigSettings>) => void;

  /** Move the dolly distance by `delta` world units; passing through 0
   *  releases the camera back to the default follow distance. */
  dolly: (delta: number) => void;

  /** On-screen joystick deflection (-1..1 per axis). y > 0 = up = forward.
   *  Written by the bottom-centre joystick, read every frame by the rig's
   *  movement loop so it steers the character like WASD. */
  stick: { x: number; y: number };

  /** Replace the current joystick deflection (0,0 on release/unmount). */
  setStick: (value: { x: number; y: number }) => void;

  /** Last one-shot gesture/dance requested by an emotion button. `nonce`
   *  advances on every request so even the same gesture can be re-triggered;
   *  NavMeshRig consumes it once per nonce and plays the clip then returns to
   *  the idle state. */
  emotionRequest: { def: EmotionDef; nonce: number } | null;

  /** Fire a one-shot gesture/dance once — the rig plays the clip, then blends
   *  back to the idle locomotion state. */
  requestEmotion: (def: EmotionDef) => void;
}

/** A one-shot emotion (dance / gesture) mapped to an on-screen button. */
export interface EmotionDef {
  /** Unique id used as the clip name when loaded. */
  id: string;
  /** Stable clip identifier fed to the avatar rig (must match the FBX name). */
  name: string;
  /** `/char/...` URL of the gesture/dance FBX. */
  url: string;
  /** Short button label (tooltip / a11y). */
  label: string;
  /** Skip this many seconds of clip preamble (e.g. a "get up from the floor"
   *  intro) so the one-shot starts from the standing pose. */
  startAt?: number;
}

/** Min / max camera distance from the player (world units). */
export const MIN_CAMERA_DISTANCE = 2.0;
export const MAX_CAMERA_DISTANCE = 200;

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
  },

  zoomRadius: 0,
  stick: { x: 0, y: 0 },
  emotionRequest: null,

  set: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  setStick: (stick) => set({ stick }),

  requestEmotion: (def) =>
    set((s) => ({
      emotionRequest: { def, nonce: (s.emotionRequest?.nonce ?? 0) + 1 },
    })),

  dolly: (delta) => {
    const { zoomRadius, settings } = get();
    // Camera distance = base follow offset length − zoomRadius; clamp the
    // radius so the distance stays within [MIN, MAX] for the current offset
    // (which the GUI can change live).
    const base = Math.hypot(settings.offsetAbove, settings.offsetBehind);
    const minRadius = base - MAX_CAMERA_DISTANCE;
    const maxRadius = base - MIN_CAMERA_DISTANCE;
    const next = zoomRadius + delta;
    set({
      zoomRadius:
        zoomRadius !== 0 && zoomRadius * next <= 0
          ? 0
          : Math.min(maxRadius, Math.max(minRadius, next)),
    });
  },
}));
