"use client";

/**
 * Avatar loader for the NavMeshRig character, rebuilt on the AvatarSDK.
 *
 * Previously this module loaded one bespoke `/character/avatar2/avatar.glb` and
 * bound four raw FBX clips to it by hand. It now composes a proper SDK avatar —
 * a rigged body GLB + a face/head GLB seated on the shared mixamorig skeleton
 * (`/char` catalog) — stands it up with the manifest's body offset, and remaps
 * the four locomotion clips (idle / walk / run / jump) onto that skeleton.
 *
 * The NavMeshRig drives *where* the character is and *how fast* it moves, so it
 * owns the group position on the navmesh. Motion clips are therefore expected to
 * be "in place" — any root translation the FBX carries is discarded (the jump
 * clip's hop is frozen at its standing value) so the character never drifts or
 * hops *inside* the player group.
 *
 * The SDK's `<Avatar>` React component plays a single clip at a time and is the
 * documented consumer path (see AvatarSDK/README.md). That model can't express
 * the rig's four-way weighted blend (crossfading idle/walk/run while a jump arcs
 * over the top), so this loader reuses the SDK's *assembly* primitives
 * (headCompose / attachHead / motion remap) and exposes a small imperative
 * controller the NavMeshRig's existing per-frame engine can drive unchanged.
 */

import * as THREE from "three";

import {
  UPRIGHT_REVEAL,
  applyBodyOffset,
  uprightFraction,
} from "../b3/b3-runtime/src/components/AvatarSDK/avatarPose";
import { loadGLB } from "../b3/b3-runtime/src/components/AvatarSDK/decoders";
import {
  classifyHeadCompose,
  createHeadAttachment,
  type HeadComposePlan,
} from "../b3/b3-runtime/src/components/AvatarSDK/headCompose";
import { parseManifest } from "../b3/b3-runtime/src/components/AvatarSDK/manifest";
import { loadMotionClips } from "../b3/b3-runtime/src/components/AvatarSDK/motionLibrary";
import { findBone, restrictClipToRoot } from "../b3/b3-runtime/src/components/AvatarSDK/rig";
import { makeDefaultManifest } from "../b3/b3-runtime/src/components/AvatarSDK/sample/charAssets";
import type {
  AvatarManifest,
  BodyInsertion,
  HeadInsertion,
  MotionClipDef,
} from "../b3/b3-runtime/src/components/AvatarSDK/types";

// ---------------------------------------------------------------------------
// Look + motion configuration
// ---------------------------------------------------------------------------

/**
 * HTTP source of the saved character manifest (body × face URLs, every tuned
 * body/face offset, and the motion library). This is the served URL of the file
 * the user edits on disk:
 *   `public/char/avatar.manifest.json`  →  GET `/char/avatar.manifest.json`
 * It is the sole source of the NavMeshRig character data.
 */
export const DEFAULT_MANIFEST_URL = "/char/avatar.manifest.json";

/** Locomotion states the NavMeshRig blends between. */
export type LocomotionKey = "idle" | "walk" | "run" | "jump";
/** Target weights (0..1) per locomotion state, fed to `AvatarRig.blend`. */
export type LocomotionTargets = Record<LocomotionKey, number>;

/**
 * Names the SDK's stay library (`/char/motion-2/fbx/stay`) gives each
 * locomotion state. A manifest's `motion.clips` is searched for one of these;
 * unknown names fall back to the same stay folder.
 */
const LOCOMOTION_SYNONYMS: Record<LocomotionKey, string[]> = {
  idle: ["idle-breathing", "idle-neutral", "idle-pose"],
  walk: ["walking", "walking2"],
  run: ["running", "rush"],
  jump: ["jumping", "jump"],
};
const STAY_FBX = "/char/motion-2/fbx/stay";

/** The four locomotion states a NavMeshRig avatar blends between. */
export const LOCOMOTION_KEYS: LocomotionKey[] = ["idle", "walk", "run", "jump"];

/** Cadence correction for the walk clip (matches the character's navmesh speed). */
const WALK_TIMESCALE = 1.5;

/**
 * GET the persisted character manifest over HTTP and validate it. Throws when
 * the fetch fails or the JSON doesn't parse as a manifest — callers decide how
 * to fall back. `cache: "no-cache"` revalidates so edits to the file on disk
 * (e.g. switching the look in `avatar.manifest.json`) show up on the next load.
 */
export async function loadSavedManifest(): Promise<AvatarManifest> {
  const res = await fetch(DEFAULT_MANIFEST_URL, {
    method: "GET",
    cache: "no-cache",
  });
  if (!res.ok) {
    throw new Error(
      `[avatarLoader] GET ${DEFAULT_MANIFEST_URL} → HTTP ${res.status}`,
    );
  }
  return parseManifest(await res.json());
}

/** Convenience used by `loadAvatar()`: the saved manifest from
 *  `public/char/avatar.manifest.json` (via GET), with the SDK's sample default
 *  male look (swat × chinese) only as a last resort when the GET/parse fails. */
export async function fetchSavedManifest(): Promise<AvatarManifest> {
  try {
    return await loadSavedManifest();
  } catch (error) {
    console.warn(
      "[avatarLoader] Failed to GET saved manifest — using sample default.",
      error,
    );
    return makeDefaultManifest({ gender: "male" });
  }
}

/**
 * Resolve the four locomotion clips out of a manifest's motion library.
 * Each state maps to one stay-clip whose name matches its synonym list, with a
 * hardcoded `/char/motion-2/fbx/stay` fallback so the rig still works even for a
 * manifest whose motion list only carries, say, breakdance poses.
 */
function resolveLocomotionDefs(manifest: AvatarManifest): Record<LocomotionKey, MotionClipDef> {
  const byName = new Map(manifest.motion.clips.map((c) => [c.name, c]));
  const out = {} as Record<LocomotionKey, MotionClipDef>;
  for (const key of LOCOMOTION_KEYS) {
    const found = LOCOMOTION_SYNONYMS[key]
      .map((name) => byName.get(name))
      .find((c): c is MotionClipDef => !!c);
    out[key] =
      found ?? { name: LOCOMOTION_SYNONYMS[key][0], url: `${STAY_FBX}/${LOCOMOTION_SYNONYMS[key][0]}.fbx` };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clip helpers
// ---------------------------------------------------------------------------

/** First bone under a scene (the mixamo rig always roots at the hips). */
function findFirstBone(root: THREE.Object3D): THREE.Bone | null {
  let hit: THREE.Bone | null = null;
  root.traverse((o) => {
    const b = o as THREE.Bone;
    if (!hit && b.isBone) hit = b;
  });
  return hit;
}

/**
 * The rig owns the group's position, so the *root* (hips) translation an FBX
 * carries — the clip's own hop/drift — is discarded. This returns a copy of
 * `clip` whose root `.position` track is frozen at its first (standing) value.
 * The track must still animate so the mixer never drops the hips to the bind
 * pose and sinks the model while the action is running.
 */
function freezeClipRootPosition(clip: THREE.AnimationClip, bodyScene: THREE.Object3D): THREE.AnimationClip {
  const root =
    findBone(bodyScene, "mixamorig:Hips") ??
    findBone(bodyScene, "Hips") ??
    findFirstBone(bodyScene);
  if (!root) return clip;

  const trackName = `${root.name}.position`;
  const source = clip.tracks.find((t) => t.name === trackName);
  if (!source) return clip;

  const TrackClass = source.constructor as new (
    name: string,
    times: ArrayLike<number>,
    values: ArrayLike<number>,
  ) => THREE.KeyframeTrack;
  const size = source.getValueSize();
  const times = source.times.slice();
  const base = source.values.slice(0, size);
  const values = new Float32Array(times.length * size);
  for (let i = 0; i < times.length; i++) values.set(base, i * size);

  const next = clip.clone();
  next.tracks = clip.tracks.map((t) =>
    t.name === trackName ? new TrackClass(trackName, times, values) : t,
  );
  return next;
}

/** Start one looping clip on a mixer at a given weight. */
function playClip(
  mixer: THREE.AnimationMixer,
  clip: THREE.AnimationClip | null,
  weight: number,
  timeScale = 1,
): THREE.AnimationAction | null {
  if (!clip) return null;
  const action = mixer.clipAction(clip);
  action.loop = THREE.LoopRepeat;
  action.weight = weight;
  action.timeScale = timeScale;
  action.play();
  return action;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The composed, SDK-built avatar plus the small imperative controller the
 * NavMeshRig drives each frame. `scene` is the group to add under the player
 * group; the rest replace the mixer/action plumbing the rig used to own.
 */
/** Which clip each rig state uses (built from a manifest by default). */
export interface AvatarConfig {
  /** Composed look (body/face assets, head bone, body + head offsets). */
  manifest: AvatarManifest;
  /** Optional per-state stay-clip overrides (what the Motion tab retunes). */
  clips?: Partial<Record<LocomotionKey, MotionClipDef>>;
  /** Rigged-head composition: `'auto'` (geometry decides) or `'seat'` (force
   * seat-glue at authored size, no dual-drive). Defaults to `'auto'`. */
  headMode?: "auto" | "seat";
}

export interface AvatarRig {
  /** Composed avatar root (body + seated/dual-drive head), upright "home"
   * applied. Add this under the player group — it carries the whole character. */
  readonly scene: THREE.Group;
  /** Crossfade the idle/walk/run/jump weights (on body *and* dual-drive head
   * mixers) toward `targets`. `alpha` is the frame lerp factor. */
  blend(targets: LocomotionTargets, alpha: number): void;
  /** Advance all mixers, re-glue the head to the live head bone, and reveal the
   * avatar once its skeleton stands (hides a floor-splayed clip intro). */
  advance(delta: number): void;
  /** Restart the jump clip at `time` (skips the anticipation crouch so the pose
   * matches the ballistic launch). */
  startJumpAt(time: number): void;

  // ---- live retuning (no rebuild — cheap, called on store changes) ----
  /** Body placement offset → applyBodyOffset on the composed root. */
  setBodyOffset(offset: BodyInsertion): void;
  /** Head-insertion offset → re-seat the face on the live head bone. */
  setHeadOffset(offset: HeadInsertion): void;
  /** Show/hide the body and/or face meshes of the composed avatar. */
  setVisibility(visibility: { body?: boolean; face?: boolean }): void;
  /** Global playback speed × (1 = natural). Multiplies every action's own
   * timescale (walk runs at 1.5× naturally). */
  setSpeed(factor: number): void;
  /** Pause/resume the whole character's animation. */
  setPaused(paused: boolean): void;

  /** Stop mixers/actions and detach the head mount. GPU disposal of `scene` is
   * the caller's job (NavMeshRig disposes it on teardown). */
  dispose(): void;
}

/** Clone an offset group so store mutations can't alias into the rig. */
function cloneOffset(o: BodyInsertion): BodyInsertion {
  return {
    position: [...o.position] as BodyInsertion["position"],
    rotation: [...o.rotation] as BodyInsertion["rotation"],
    scale: [...o.scale] as BodyInsertion["scale"],
  };
}

/**
 * Build a composed avatar for the NavMeshRig. Optional `config.manifest` (a
 * saved `/char` look + motion library) defaults to `fetchSavedManifest()`;
 * `config.clips` overrides which stay clips feed the four rig states.
 */
export async function loadAvatar(
  config?: AvatarConfig | AvatarManifest,
): Promise<AvatarRig> {
  const cfg: AvatarConfig | undefined = config
    ? "assets" in config
      ? { manifest: config }
      : config
    : undefined;
  const manifest = cfg?.manifest ?? (await fetchSavedManifest());

  // --- load + compose body & face on the shared mixamorig skeleton ----------
  const [bodyGltf, faceGltf] = await Promise.all([
    loadGLB(manifest.assets.body),
    loadGLB(manifest.assets.face),
  ]);
  const bodyScene = bodyGltf.scene;
  const faceScene = faceGltf.scene;

  // Classify (congruent dual-drive vs cross-look seat) while both scenes are
  // still unparented so the measurement can't be skewed by the upright rotation.
  const plan: HeadComposePlan = classifyHeadCompose({
    bodyScene,
    faceScene,
    headBone: manifest.headBone,
    headMode: cfg?.headMode ?? "auto",
  });

  const root = new THREE.Group();
  root.name = "Avatar";
  // Hidden until the reveal gate (in advance) sees the skeleton standing — a
  // clip can open with the character floor-splayed and stand over the first
  // seconds; that intro must never render on the navmesh.
  root.visible = false;
  root.add(bodyScene);

  // Body mixer bound to the root: the clips are remapped onto the body bone
  // names, which the mixer resolves through the root's subtree.
  const mixer = new THREE.AnimationMixer(root);
  const attachment = createHeadAttachment({ root, faceScene, plan });
  const mount = attachment.mount;
  const faceGroup = attachment.group;

  // Live offset copies the tuning panel writes through `setBody/HeadOffset`.
  let bodyOffset = cloneOffset(manifest.body);
  let headOffset = cloneOffset(manifest.head) as HeadInsertion;
  applyBodyOffset(root, bodyOffset);
  mount?.update(headOffset);

  // --- load + remap the four locomotion clips --------------------------------
  const baseDefs = resolveLocomotionDefs(manifest);
  const defs = {} as Record<LocomotionKey, MotionClipDef>;
  for (const key of LOCOMOTION_KEYS) {
    defs[key] = cfg?.clips?.[key] ?? baseDefs[key];
  }
  const loaded = await loadMotionClips(LOCOMOTION_KEYS.map((k) => defs[k]), bodyScene);

  const clips: Record<LocomotionKey, THREE.AnimationClip | null> = {
    idle: null,
    walk: null,
    run: null,
    jump: null,
  };
  for (const key of LOCOMOTION_KEYS) {
    const clip = loaded.get(defs[key].name) ?? null;
    clips[key] = key === "jump" && clip ? freezeClipRootPosition(clip, bodyScene) : clip;
  }

  // The face's own rig (dual-drive heads only — cross-look heads are rigid-glued
  // onto the body head bone and need no clip of their own) plays the same clips
  // restricted to the bones that actually exist under the face skeleton.
  const headMixer = attachment.headMixer;
  const headClips: Record<LocomotionKey, THREE.AnimationClip | null> = {
    idle: null,
    walk: null,
    run: null,
    jump: null,
  };
  if (headMixer) {
    for (const key of LOCOMOTION_KEYS) {
      headClips[key] = clips[key] ? restrictClipToRoot(clips[key]!, faceScene) : null;
    }
  }

  // --- actions (idle at full weight; the rig crossfades from there) ----------
  // Walk naturally runs at 1.5×; every action is scaled further by `speedFactor`
  // so the tuning panel's playback speed stays live-tunable.
  const BASE_TIMESCALE: Record<LocomotionKey, number> = {
    idle: 1,
    walk: WALK_TIMESCALE,
    run: 1,
    jump: 1,
  };
  const bodyActions = {} as Record<LocomotionKey, THREE.AnimationAction | null>;
  const headActions = {} as Record<LocomotionKey, THREE.AnimationAction | null>;
  for (const key of LOCOMOTION_KEYS) {
    const ts = BASE_TIMESCALE[key];
    bodyActions[key] = playClip(mixer, clips[key], key === "idle" ? 1 : 0, ts);
    if (headMixer) headActions[key] = playClip(headMixer, headClips[key], key === "idle" ? 1 : 0, ts);
  }

  // --- reveal gate -----------------------------------------------------------
  let revealed = false;
  let hiddenElapsed = 0;
  const maybeReveal = (dt: number) => {
    if (revealed) return;
    hiddenElapsed += dt;
    // Refresh world matrices so the standing test reads live bone positions.
    root.updateMatrixWorld(true);
    const up = uprightFraction(plan.bone, plan.hips);
    // No head/hips to measure → don't gate; also un-hide after ~1.6s no matter
    // what so a clip with no obvious "stand" never leaves the avatar invisible.
    if (up === null || up >= UPRIGHT_REVEAL || hiddenElapsed > 1.6) {
      revealed = true;
      root.visible = true;
    }
  };

  // Live-playback state (set by the tuning panel / NavMeshRig).
  let speedFactor = 1;
  let paused = false;
  const applySpeed = () => {
    for (const key of LOCOMOTION_KEYS) {
      const target = BASE_TIMESCALE[key] * speedFactor;
      const body = bodyActions[key];
      if (body) body.timeScale = target;
      const head = headActions[key];
      if (head) head.timeScale = target;
    }
  };

  return {
    scene: root,
    blend(targets, alpha) {
      for (const key of LOCOMOTION_KEYS) {
        const body = bodyActions[key];
        if (body) body.weight = THREE.MathUtils.lerp(body.weight, targets[key], alpha);
        const head = headActions[key];
        if (head) head.weight = THREE.MathUtils.lerp(head.weight, targets[key], alpha);
      }
    },
    advance(delta) {
      const dt = paused ? 0 : delta;
      mixer.update(dt);
      if (headMixer) headMixer.update(dt);
      // Re-seat the face on the *live* head bone (both rigid glue and the
      // dual-drive offset nudge recompute against the bone's current transform).
      mount?.update(headOffset);
      maybeReveal(delta);
    },
    startJumpAt(time) {
      const body = bodyActions.jump;
      if (body) body.time = time;
      const head = headActions.jump;
      if (head) head.time = time;
    },
    setBodyOffset(offset) {
      bodyOffset = cloneOffset(offset);
      applyBodyOffset(root, bodyOffset);
    },
    setHeadOffset(offset) {
      headOffset = cloneOffset(offset) as HeadInsertion;
      mount?.update(headOffset);
    },
    setVisibility(visibility) {
      if (visibility.body !== undefined) bodyScene.visible = visibility.body;
      if (visibility.face !== undefined && faceGroup) faceGroup.visible = visibility.face;
    },
    setSpeed(factor) {
      speedFactor = factor;
      applySpeed();
    },
    setPaused(value) {
      paused = value;
    },
    dispose() {
      mixer.stopAllAction();
      if (headMixer) headMixer.stopAllAction();
      attachment.dispose();
    },
  };
}
