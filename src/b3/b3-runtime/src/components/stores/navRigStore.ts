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
}

/** Min / max camera distance from the player (world units). */
export const MIN_CAMERA_DISTANCE = 5;
export const MAX_CAMERA_DISTANCE = 100;

export const useNavRigStore = create<NavRigState>((set, get) => ({
  settings: {
    showNavMeshHelper: false,
    showAgentHelper: false,
    cellSize: 0.05,
    cellHeight: 0.05,
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

  set: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

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
