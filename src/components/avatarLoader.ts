"use client";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";

const AVATAR_URL = "/character/avatar2/avatar.glb";
const IDLE_URL = "/character/avatar2/breathing-motion.fbx";
const WALK_URL = "/character/avatar2/walking-motion.fbx";
const RUN_URL = "/character/avatar2/running-motion.fbx";

export interface AvatarAnimations {
  idle: THREE.AnimationClip | null;
  walk: THREE.AnimationClip | null;
  run: THREE.AnimationClip | null;
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
 */
function retargetClip(
  clip: THREE.AnimationClip,
  skeleton: THREE.Skeleton,
): THREE.AnimationClip {
  const boneNames = new Set(skeleton.bones.map((b) => b.name));
  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const boneName = track.name.split(".")[0];
    if (boneNames.has(boneName)) tracks.push(track.clone());
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Load the avatar GLB and bind the three FBX motion clips (idle / walk / run)
 * to its skeleton. The returned mixer is ready to drive the avatar.
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

  const [idleObj, walkObj, runObj] = await Promise.all([
    new FBXLoader().loadAsync(IDLE_URL),
    new FBXLoader().loadAsync(WALK_URL),
    new FBXLoader().loadAsync(RUN_URL),
  ]);

  const clips: AvatarAnimations = { idle: null, walk: null, run: null };
  if (skeleton) {
    const sources = [
      idleObj.animations[0],
      walkObj.animations[0],
      runObj.animations[0],
    ];
    const keys: (keyof AvatarAnimations)[] = ["idle", "walk", "run"];
    sources.forEach((clip, i) => {
      if (clip) clips[keys[i]] = retargetClip(clip, skeleton);
    });
  }

  return { scene, skeleton, mixer: new THREE.AnimationMixer(scene), clips };
}

/**
 * Create + start the idle/walk/run actions on the avatar's mixer with the
 * weights used by the navmesh rig (idle=1, walk/run=0, crossfaded at runtime).
 */
export function createAvatarActions(avatar: Avatar): AvatarActions {
  const { mixer, clips } = avatar;
  const actions: AvatarActions = { idle: null, walk: null, run: null };

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

  return actions;
}
