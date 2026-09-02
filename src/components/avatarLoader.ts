"use client";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

const AVATAR_URL = "/character/avatar2/avatar.glb";
const IDLE_URL = "/character/avatar2/breathing-motion.fbx";
const WALK_URL = "/character/avatar2/walking-motion.fbx";
const RUN_URL = "/character/avatar2/running-motion.fbx";
const JUMP_URL = "/character/avatar2/jumping.fbx";

export interface AvatarAnimations {
  idle: THREE.AnimationClip | null;
  walk: THREE.AnimationClip | null;
  run: THREE.AnimationClip | null;
  jump: THREE.AnimationClip | null;
}

export interface Avatar {
  scene: THREE.Object3D;
  skeleton: THREE.Skeleton | null;
  mixer: THREE.AnimationMixer;
  clips: AvatarAnimations;
}

export interface AvatarActions {
  idle: THREE.AnimationAction | null;
  walk: THREE.AnimationAction | null;
  run: THREE.AnimationAction | null;
  jump: THREE.AnimationAction | null;
}

/** Find the first SkinnedMesh skeleton in a loaded character. */
function findSkeleton(root: THREE.Object3D): THREE.Skeleton | null {
  let skeleton: THREE.Skeleton | null = null;
  root.traverse((obj) => {
    const mesh = obj as THREE.SkinnedMesh;
    if (!skeleton && mesh.isSkinnedMesh && mesh.skeleton) {
      skeleton = mesh.skeleton;
    }
  });
  return skeleton;
}

/**
 * Rebind an FBX motion clip's tracks onto the avatar's skeleton by bone name.
 * Tracks for bones the avatar doesn't have are dropped (graceful) so a
 * mismatched rig degrades to a static character instead of crashing.
 *
 * Names are compared colon-agnostically: three's FBXLoader sanitises bone
 * names (mixamo's "mixamorig:Hips" → "mixamorigHips") but the GLB skeleton
 * keeps the colon, so exact matching would drop every track.
 *
 * When `freezeRootPosition` is true the root bone's `.position` track is kept
 * but frozen at its first (standing) value. Mixamo clips carry the root
 * translation of the motion (the clip's own hop / drift); the NavMeshRig owns
 * the group's position, so the root motion is discarded — but the track must
 * still animate so the mixer never drops the hips to its bind pose and sinks
 * the model while the jump action dominates.
 */
function retargetClip(
  clip: THREE.AnimationClip,
  skeleton: THREE.Skeleton,
  freezeRootPosition = false,
): THREE.AnimationClip {
  // Compare names without the mixamo ":" (present in the GLB, stripped by the
  // FBX loader) so the clips actually bind.
  const norm = (name: string) => name.replace(/:/g, "");
  const boneNames = new Set(skeleton.bones.map((b) => norm(b.name)));
  const rootName = skeleton.bones[0] ? norm(skeleton.bones[0].name) : "";
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const parts = track.name.split(".");
    const boneName = norm(parts[0]);
    const property = parts[1];
    if (!boneNames.has(boneName)) continue;
    if (freezeRootPosition && boneName === rootName && property === "position") {
      // Rewrite the track as a constant of its first value (the standing pose).
      const TrackClass = track.constructor as new (
        name: string,
        times: ArrayLike<number>,
        values: ArrayLike<number>,
      ) => THREE.KeyframeTrack;
      const size = track.getValueSize();
      const times = track.times.slice();
      const base = track.values.slice(0, size);
      const values = new Float32Array(times.length * size);
      for (let i = 0; i < times.length; i++) values.set(base, i * size);
      tracks.push(new TrackClass(track.name, times, values));
      continue;
    }
    tracks.push(track.clone());
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Load the avatar GLB and bind the four FBX motion clips (idle / walk / run /
 * jump) to its skeleton. The returned mixer is ready to drive the avatar.
 */
export async function loadAvatar(): Promise<Avatar> {
  // avatar.glb is Draco-compressed — use three's decoder files from a
  // dedicated subpath (kept separate from /draco/ used by the draco3d npm path).
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath("/draco/three/");
  const gltfLoader = new GLTFLoader();
  gltfLoader.setDRACOLoader(dracoLoader);

  const gltf = await gltfLoader.loadAsync(AVATAR_URL);
  const scene = gltf.scene;
  const skeleton = findSkeleton(scene);

  // The avatar imports lying down (Blender Z-up convention) — stand it up.
  // Applied to a wrapper so the rig's yaw-facing logic on the parent group is
  // left untouched.
  const avatarRoot = new THREE.Group();
  avatarRoot.rotation.x = -Math.PI / 2;
  avatarRoot.add(scene);

  const [idleObj, walkObj, runObj, jumpObj] = await Promise.all([
    new FBXLoader().loadAsync(IDLE_URL),
    new FBXLoader().loadAsync(WALK_URL),
    new FBXLoader().loadAsync(RUN_URL),
    new FBXLoader().loadAsync(JUMP_URL),
  ]);

  const clips: AvatarAnimations = {
    idle: null,
    walk: null,
    run: null,
    jump: null,
  };
  if (skeleton) {
    const sources = [
      idleObj.animations[0],
      walkObj.animations[0],
      runObj.animations[0],
      jumpObj.animations[0],
    ];
    const keys: (keyof AvatarAnimations)[] = ["idle", "walk", "run", "jump"];
    // The jump clip carries root-bone translation (its own hop); freeze it at
    // the standing pose so the rig's group (and camera) stays the motion.
    const freezeRoot = [false, false, false, true];
    sources.forEach((clip, i) => {
      if (clip) clips[keys[i]] = retargetClip(clip, skeleton, freezeRoot[i]);
    });
  }

  return {
    scene: avatarRoot,
    skeleton,
    mixer: new THREE.AnimationMixer(scene),
    clips,
  };
}

/**
 * Create + start the idle/walk/run/jump actions on the avatar's mixer. Idle
 * starts at weight 1 with walk/run/jump at 0 — the NavMeshRig crossfades the
 * weights at runtime (jump is raised for the airborne arc).
 */
export function createAvatarActions(avatar: Avatar): AvatarActions {
  const { mixer, clips } = avatar;
  const actions: AvatarActions = { idle: null, walk: null, run: null, jump: null };

  if (clips.idle) {
    actions.idle = mixer.clipAction(clips.idle);
    actions.idle.loop = THREE.LoopRepeat;
    actions.idle.weight = 1;
    actions.idle.play();
  }
  if (clips.walk) {
    actions.walk = mixer.clipAction(clips.walk);
    actions.walk.loop = THREE.LoopRepeat;
    actions.walk.weight = 0;
    actions.walk.timeScale = 1.5;
    actions.walk.play();
  }
  if (clips.run) {
    actions.run = mixer.clipAction(clips.run);
    actions.run.loop = THREE.LoopRepeat;
    actions.run.weight = 0;
    actions.run.play();
  }
  if (clips.jump) {
    actions.jump = mixer.clipAction(clips.jump);
    actions.jump.loop = THREE.LoopRepeat;
    actions.jump.weight = 0;
    actions.jump.play();
  }

  return actions;
}
