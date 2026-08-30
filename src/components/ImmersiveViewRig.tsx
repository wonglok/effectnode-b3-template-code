"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  useImmersiveViewStore,
  useNavRigStore,
  useBlenderStore,
} from "../b3/b3-runtime/src/index";
import { createAvatarActions, loadAvatar } from "./avatarLoader";
import { buildWalkableMeshesFromStore } from "./blenderWalkableMeshes";
import {
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  moveAlongSurface,
} from "navcat";
import { generateSoloNavMesh } from "navcat/blocks";
import { getPositionsAndIndices } from "navcat/three";
import type { Vec3 } from "mathcat";

// ---------------------------------------------------------------------------
// ImmersiveViewRig — an OrbitControls third-person view that orbits the player
// GLB, with the character stuck to the navmesh surface (same as NavMeshRig).
//
// A navmesh is built from the synced *collider* meshes; the avatar walks it with
// WASD, constrained to its surface via navcat findNearestPoly + moveAlongSurface
// (plus a collider height-correction raycast, exactly like NavMeshRig).
//
// OrbitControls.target is locked onto the player's body, so dragging rotates the
// camera around the character and the wheel dollies in/out. When the player
// moves, both the camera and the target are translated together by the player's
// delta — the spherical offset (phi / theta / radius) that OrbitControls tracks
// is left untouched, so the viewing angle never jumps while walking.
//
// Rendered mutually exclusively with NavMeshRig / CameraSync in DevPage.
// ---------------------------------------------------------------------------

/** Start position above the centre of the level's bounding box. */
function computeStartPosition(meshes: THREE.Mesh[]): Vec3 {
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  const center = box.getCenter(new THREE.Vector3());
  const maxY = box.max.y;
  return [center.x, maxY + 2, center.z];
}

/**
 * World-space position of the "birthplace" marker — the first object whose
 * name contains "birthplace", from the live Blender sync or the rendered
 * scene. Returns null when no such object exists.
 */
function findBirthplacePosition(scene: THREE.Scene): THREE.Vector3 | null {
  const { sceneData } = useBlenderStore.getState();
  for (const obj of sceneData.objects) {
    if (obj.name.toLowerCase().includes("birthplace")) {
      return new THREE.Vector3(...obj.position);
    }
  }

  const markers: THREE.Object3D[] = [];
  scene.traverse((obj) => {
    if (obj.name.toLowerCase().includes("birthplace")) markers.push(obj);
  });
  return markers.length > 0
    ? markers[0].getWorldPosition(new THREE.Vector3())
    : null;
}

/** Dispose a mesh (and its geometry / materials). */
function disposeMesh(mesh: THREE.Mesh) {
  mesh.geometry?.dispose();
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) m?.dispose();
}

/** Dispose an entire Object3D subtree. */
function disposeObject(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.isMesh) disposeMesh(mesh);
  });
}

interface ImmersiveViewFrame {
  frame: (delta: number) => void;
}

export function ImmersiveViewRig() {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const frameRef = useRef<ImmersiveViewFrame>({ frame: () => {} });

  useEffect(() => {
    let disposed = false;
    let retryInterval = 0;

    // Immersive tuning (orbit + player speed) — mutable, read live per frame.
    const settings = useImmersiveViewStore.getState().settings;
    // Navmesh build config shared with the navmesh rig's GUI settings.
    const navSettings = useNavRigStore.getState().settings;

    // ------------------------------------------------------------------
    // Navmesh — built from the synced *collider* meshes (same as NavMeshRig)
    // ------------------------------------------------------------------
    let navMesh: any = null;
    let warnedNoCollider = false;

    /**
     * Collect the walkable collider meshes. Prefers the live Blender store
     * (transient copies we own); falls back to collider meshes already rendered
     * in this scene (e.g. a deployment rendered by ProductionViewer), which the
     * scene owns and must not be disposed.
     */
    const buildColliderMeshes = (): {
      meshes: THREE.Mesh[];
      owned: boolean;
    } => {
      const store = buildWalkableMeshesFromStore();
      if (store.length > 0) return { meshes: store, owned: true };

      const sceneColliders: THREE.Mesh[] = [];
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh && m.name.toLowerCase().includes("collider")) {
          sceneColliders.push(m);
        }
      });
      return { meshes: sceneColliders, owned: false };
    };

    const generateNavMesh = () => {
      const { meshes: colliders, owned } = buildColliderMeshes();
      if (colliders.length === 0) {
        if (!warnedNoCollider) {
          console.warn(
            "[ImmersiveViewRig] No *collider* mesh found — name a Blender object 'collider' or include one in the deployment.",
          );
          warnedNoCollider = true;
        }
        return null;
      }

      const [positions, indices] = getPositionsAndIndices(colliders);
      // Only dispose the transient store copies — scene-owned meshes stay.
      if (owned) for (const m of colliders) disposeMesh(m);

      const input = { positions, indices };
      const config = {
        cellSize: navSettings.cellSize,
        cellHeight: navSettings.cellHeight,
        walkableRadiusWorld: navSettings.walkableRadius,
        walkableRadiusVoxels: Math.ceil(
          navSettings.walkableRadius / navSettings.cellSize,
        ),
        walkableClimbWorld: navSettings.walkableClimb,
        walkableClimbVoxels: Math.ceil(
          navSettings.walkableClimb / navSettings.cellHeight,
        ),
        walkableHeightWorld: navSettings.walkableHeight,
        walkableHeightVoxels: Math.ceil(
          navSettings.walkableHeight / navSettings.cellHeight,
        ),
        walkableSlopeAngleDegrees: navSettings.walkableSlopeAngle,
        borderSize: 4,
        minRegionArea: 12,
        mergeRegionArea: 20,
        maxSimplificationError: 1.3,
        maxEdgeLength: 12,
        maxVerticesPerPoly: 6,
        detailSampleDistance: 6,
        detailSampleMaxError: 1,
      };

      const result = generateSoloNavMesh(input, config);
      navMesh = result.navMesh;
      console.log("[ImmersiveViewRig] Navmesh generated");
      return navMesh;
    };

    // ------------------------------------------------------------------
    // Player — the avatar GLB the camera orbits around.
    // ------------------------------------------------------------------
    const playerGroup = new THREE.Group();
    playerGroup.name = "player";
    scene.add(playerGroup);

    let characterScene: THREE.Object3D | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    const animations: {
      idle: THREE.AnimationAction | null;
      walk: THREE.AnimationAction | null;
      run: THREE.AnimationAction | null;
    } = { idle: null, walk: null, run: null };

    loadAvatar()
      .then((avatar) => {
        if (disposed) return;
        characterScene = avatar.scene;
        playerGroup.add(characterScene);
        mixer = avatar.mixer;
        const a = createAvatarActions(avatar);
        animations.idle = a.idle;
        animations.walk = a.walk;
        animations.run = a.run;
      })
      .catch((err) => {
        console.warn("[ImmersiveViewRig] Failed to load avatar:", err);
      });

    // ------------------------------------------------------------------
    // Place the player on the navmesh (birthplace first, else auto-placement)
    // ------------------------------------------------------------------
    const placePlayer = () => {
      if (!navMesh) return;

      const birthplace = findBirthplacePosition(scene);
      if (birthplace) {
        const result = findNearestPoly(
          createFindNearestPolyResult(),
          navMesh,
          [birthplace.x, birthplace.y, birthplace.z],
          [50, 50, 50],
          DEFAULT_QUERY_FILTER,
        );
        if (result.success) {
          playerGroup.position.fromArray(result.position);
          console.log(
            "[ImmersiveViewRig] Positioned player at birthplace:",
            result.position,
          );
          return;
        }
        console.warn(
          "[ImmersiveViewRig] Birthplace not on navmesh — falling back to auto placement",
        );
      }

      const { meshes: colliders, owned } = buildColliderMeshes();
      if (colliders.length === 0) return;

      const box = new THREE.Box3();
      for (const m of colliders) box.expandByObject(m);
      const boxCenter = box.getCenter(new THREE.Vector3());
      const candidates: Vec3[] = [
        computeStartPosition(colliders),
        [boxCenter.x, boxCenter.y, boxCenter.z],
        [0, 2, 0],
      ];
      if (owned) for (const m of colliders) disposeMesh(m);

      for (const candidate of candidates) {
        const result = findNearestPoly(
          createFindNearestPolyResult(),
          navMesh,
          candidate,
          [50, 50, 50],
          DEFAULT_QUERY_FILTER,
        );
        if (result.success) {
          playerGroup.position.fromArray(result.position);
          console.log("[ImmersiveViewRig] Positioned player at:", result.position);
          return;
        }
      }
      console.warn("[ImmersiveViewRig] Could not find starting position on navmesh");
    };

    // Generate now; if the collider hasn't synced yet, retry for a while.
    let retries = 0;
    if (!generateNavMesh()) {
      retryInterval = window.setInterval(() => {
        if (disposed) return;
        if (generateNavMesh()) {
          placePlayer();
          window.clearInterval(retryInterval);
          return;
        }
        retries++;
        if (retries > 20) {
          console.warn(
            "[ImmersiveViewRig] Gave up waiting for a *collider* mesh to build the navmesh.",
          );
          window.clearInterval(retryInterval);
        }
      }, 1500);
    } else {
      placePlayer();
    }

    // ------------------------------------------------------------------
    // OrbitControls — rotate around the player, wheel to dolly.
    // Pan is disabled so the camera can't be dragged off the player.
    // ------------------------------------------------------------------
    const pivot = new THREE.Vector3();
    pivot
      .copy(playerGroup.position)
      .add(new THREE.Vector3(0, settings.orbitPivotHeight, 0));

    const controls = new OrbitControls(camera, gl.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.minDistance = settings.minDistance;
    controls.maxDistance = settings.maxDistance;
    controls.target.copy(pivot);

    // Start behind the player at eye height — OrbitControls derives the
    // spherical (phi / theta / radius) from this initial offset.
    camera.position.copy(playerGroup.position);
    camera.position.y += settings.eyeHeight;
    camera.position.z += settings.orbitRadius;
    controls.update();

    // ------------------------------------------------------------------
    // Keyboard input
    // ------------------------------------------------------------------
    const input = {
      forward: false,
      back: false,
      left: false,
      right: false,
      sprint: false,
    };

    const onKeyDown = (event: KeyboardEvent) => {
      switch (event.code) {
        case "ArrowUp":
        case "KeyW":
          input.forward = true;
          break;
        case "ArrowDown":
        case "KeyS":
          input.back = true;
          break;
        case "ArrowLeft":
        case "KeyA":
          input.left = true;
          break;
        case "ArrowRight":
        case "KeyD":
          input.right = true;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          input.sprint = true;
          break;
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      switch (event.code) {
        case "ArrowUp":
        case "KeyW":
          input.forward = false;
          break;
        case "ArrowDown":
        case "KeyS":
          input.back = false;
          break;
        case "ArrowLeft":
        case "KeyA":
          input.left = false;
          break;
        case "ArrowRight":
        case "KeyD":
          input.right = false;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          input.sprint = false;
          break;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);

    // ------------------------------------------------------------------
    // Rendered *collider* meshes used for the height-correction raycast.
    // Refreshed periodically — the scene changes as Blender re-syncs.
    // ------------------------------------------------------------------
    const colliderObjects: THREE.Object3D[] = [];
    let frameCounter = 0;
    const refreshColliderObjects = () => {
      colliderObjects.length = 0;
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh;
        if (m.isMesh && m.name.toLowerCase().includes("collider")) {
          colliderObjects.push(obj);
        }
      });
    };
    refreshColliderObjects();

    // ------------------------------------------------------------------
    // Movement / animation scratch state
    // ------------------------------------------------------------------
    const raycaster = new THREE.Raycaster();
    raycaster.far = 10;
    const downDirection = new THREE.Vector3(0, -1, 0);
    const forward = new THREE.Vector3();
    const right = new THREE.Vector3();
    const movement = new THREE.Vector3();
    const movementTarget = new THREE.Vector3();
    const origin = new THREE.Vector3();
    const playerEuler = new THREE.Euler();
    const playerQuaternion = new THREE.Quaternion();
    const prevPosition = new THREE.Vector3();

    // Force the first navmesh move so the player snaps onto the surface.
    let firstPositionUpdate = true;

    const frame = (delta: number) => {
      if (disposed) return;
      const clamped = Math.min(delta, 0.1);
      camera.updateMatrixWorld();

      frameCounter++;
      if (frameCounter % 45 === 0) refreshColliderObjects();

      prevPosition.copy(playerGroup.position);

      // --- WASD → camera-relative horizontal movement for the player ---
      camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() > 0) forward.normalize();
      right.crossVectors(forward, camera.up); // forward × up = right (looking down -z)

      movement.set(0, 0, 0);
      if (input.forward) movement.addScaledVector(forward, 1);
      if (input.back) movement.addScaledVector(forward, -1);
      if (input.right) movement.addScaledVector(right, 1);
      if (input.left) movement.addScaledVector(right, -1);
      if (movement.lengthSq() > 0) {
        const speed = input.sprint ? settings.runSpeed : settings.walkSpeed;
        movement.normalize().multiplyScalar(speed * clamped);
      }

      // --- move along the navmesh surface (stuck to the walkable mesh) ---
      if (navMesh) {
        if (movement.lengthSq() > 0 || firstPositionUpdate) {
          movementTarget.copy(playerGroup.position).add(movement);
          const nearestResult = findNearestPoly(
            createFindNearestPolyResult(),
            navMesh,
            [
              playerGroup.position.x,
              playerGroup.position.y,
              playerGroup.position.z,
            ],
            [1, 1, 1],
            DEFAULT_QUERY_FILTER,
          );
          if (nearestResult.success) {
            const moveResult = moveAlongSurface(
              navMesh,
              nearestResult.nodeRef,
              [
                playerGroup.position.x,
                playerGroup.position.y,
                playerGroup.position.z,
              ],
              [movementTarget.x, movementTarget.y, movementTarget.z],
              DEFAULT_QUERY_FILTER,
            );
            if (moveResult.success && moveResult.position) {
              playerGroup.position.fromArray(moveResult.position);
            }
          }
          firstPositionUpdate = false;
        }

        // Face the walk direction (yaw only) so the avatar leads the way.
        if (movement.lengthSq() > 0) {
          const rotation = Math.atan2(movement.x, movement.z);
          const targetQuaternion = playerQuaternion.setFromEuler(
            playerEuler.set(0, rotation, 0),
          );
          playerGroup.quaternion.slerp(targetQuaternion, Math.min(1, clamped * 10));
        }

        // Height correction against the rendered collider meshes — keeps the
        // feet glued to the actual geometry (same belt-and-suspenders pass as
        // NavMeshRig) on top of the navmesh surface.
        if (colliderObjects.length > 0) {
          origin.copy(playerGroup.position);
          origin.y += 1;
          raycaster.set(origin, downDirection);
          const hits = raycaster.intersectObjects(colliderObjects, false);
          const hit = hits.sort((a, b) => a.distance - b.distance)[0];
          if (hit) {
            const yDiff = Math.abs(hit.point.y - playerGroup.position.y);
            if (yDiff < 1) playerGroup.position.y = hit.point.y;
          }
        }
      }

      // --- follow the player, preserving the spherical offset ---
      // Translating the camera AND the pivot by the same delta leaves
      // OrbitControls' (phi, theta, radius) untouched — the view angle holds.
      const dx = playerGroup.position.x - prevPosition.x;
      const dy = playerGroup.position.y - prevPosition.y;
      const dz = playerGroup.position.z - prevPosition.z;
      controls.target.set(
        playerGroup.position.x,
        playerGroup.position.y + settings.orbitPivotHeight,
        playerGroup.position.z,
      );
      camera.position.x += dx;
      camera.position.y += dy;
      camera.position.z += dz;
      controls.update();

      // --- animation blend (idle / walk / run) ---
      const t = 1.0 - 0.01 ** clamped;
      const speed = movement.length();
      let idleWeight = 1;
      let walkWeight = 0;
      let runWeight = 0;
      if (speed >= 0.01) {
        idleWeight = 0;
        if (input.sprint) runWeight = 1;
        else walkWeight = 1;
      }
      if (animations.idle) {
        animations.idle.weight = THREE.MathUtils.lerp(
          animations.idle.weight,
          idleWeight,
          t * 5,
        );
      }
      if (animations.walk) {
        animations.walk.weight = THREE.MathUtils.lerp(
          animations.walk.weight,
          walkWeight,
          t * 5,
        );
      }
      if (animations.run) {
        animations.run.weight = THREE.MathUtils.lerp(
          animations.run.weight,
          runWeight,
          t * 5,
        );
      }
      if (mixer) mixer.update(clamped);
    };

    frameRef.current = { frame };

    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------
    return () => {
      disposed = true;
      window.clearInterval(retryInterval);
      frameRef.current = { frame: () => {} };
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      controls.dispose();

      scene.remove(playerGroup);
      if (characterScene) disposeObject(characterScene);
    };
  }, [scene, camera, gl]);

  useFrame((_, delta) => {
    frameRef.current.frame(delta);
  });

  return null;
}
