import { create } from "zustand";

// ---------------------------------------------------------------------------
// Immersive View Store
// ---------------------------------------------------------------------------
// Shared state for the ImmersiveViewRig — the OrbitControls third-person view
// that orbits the player GLB. `settings` is a plain mutable object (same shape
// as navRigStore) so the rig's frame loop can read it live without
// re-subscribing.

interface ImmersiveViewSettings {
  /** Walking speed (world units / second). */
  walkSpeed: number;
  /** Sprint speed (world units / second). */
  runSpeed: number;
  /** Clearance kept between the player and collider meshes when sliding along walls. */
  collisionRadius: number;
  /** Default camera distance from the player (world units). */
  orbitRadius: number;
  /** Height of the orbit pivot (OrbitControls.target) above the player's feet. */
  orbitPivotHeight: number;
  /** Initial camera height above the player's feet. */
  eyeHeight: number;
  /** OrbitControls zoom clamp — how far in/out the wheel may dolly. */
  minDistance: number;
  maxDistance: number;
}

interface ImmersiveViewState {
  settings: ImmersiveViewSettings;

  /** Replace one or more settings fields. */
  set: (patch: Partial<ImmersiveViewSettings>) => void;
}

export const useImmersiveViewStore = create<ImmersiveViewState>((set) => ({
  settings: {
    walkSpeed: 4,
    runSpeed: 8,
    collisionRadius: 0.5,
    orbitRadius: 8,
    orbitPivotHeight: 1.2,
    eyeHeight: 1.6,
    minDistance: 2,
    maxDistance: 20,
  },

  set: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
}));
