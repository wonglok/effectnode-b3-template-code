"use client";

import { useEffect, useRef, type RefObject } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GUI } from "lil-gui";
import type { Vec3 } from "mathcat";
import {
  createFindNearestPolyResult,
  DEFAULT_QUERY_FILTER,
  findNearestPoly,
  moveAlongSurface,
} from "navcat";
import {
  generateSoloNavMesh,
  type SoloNavMeshInput,
  type SoloNavMeshOptions,
} from "navcat/blocks";
import { createNavMeshHelper, getPositionsAndIndices } from "navcat/three";
import { buildWalkableMeshesFromStore } from "./blenderWalkableMeshes";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const CHARACTER_URL = "/character/character.glb";

const guiSettings = {
  showNavMeshHelper: true,
  showAgentHelper: false,
  cellSize: 0.2,
  cellHeight: 0.2,
  walkableRadius: 0.3,
  walkableSlopeAngle: 45,
  walkableClimb: 0.4,
  walkableHeight: 1.5,
  walkingSpeed: 4,
  runningSpeed: 8,
  offsetAbove: 15,
  offsetBehind: 10,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    if (mesh.isMesh) {
      mesh.geometry?.dispose();
      const mats = Array.isArray(mesh.material)
        ? mesh.material
        : [mesh.material];
      for (const m of mats) {
        if (m) {
          const m2 = m as THREE.MeshStandardMaterial;
          for (const k of [
            "map",
            "normalMap",
            "roughnessMap",
            "metalnessMap",
            "emissiveMap",
          ] as const) {
            m2[k]?.dispose();
          }
          m.dispose();
        }
      }
    }
  });
}

/** Start position above the centre of the level's bounding box. */
function computeStartPosition(meshes: THREE.Mesh[]): Vec3 {
  const box = new THREE.Box3();
  for (const m of meshes) box.expandByObject(m);
  const center = box.getCenter(new THREE.Vector3());
  const maxY = box.max.y;
  return [center.x, maxY + 2, center.z];
}

// ---------------------------------------------------------------------------
// Per-frame state (created in the effect, consumed by useFrame)
// ---------------------------------------------------------------------------

interface RigFrame {
  frame: (delta: number) => void;
}

// ---------------------------------------------------------------------------
// Component — mounts inside CanvasGPU and drives the R3F scene + camera
// ---------------------------------------------------------------------------

interface NavMeshRigProps {
  /** Container div (inside the sidebar) that the lil-gui mounts into. */
  guiContainer?: RefObject<HTMLDivElement | null>;
}

export function NavMeshRig({ guiContainer }: NavMeshRigProps) {
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);
  const frameRef = useRef<RigFrame>({ frame: () => {} });

  // Setup once: navmesh from the synced *collider* meshes, character, GUI, input
  useEffect(() => {
    let disposed = false;
    let retryInterval = 0;

    // ------------------------------------------------------------------
    // Navmesh
    // ------------------------------------------------------------------
    let navMesh: any = null;
    let navMeshHelper: any = null;

    const buildColliderMeshes = () => buildWalkableMeshesFromStore();

    let warnedNoCollider = false;

    const generateNavMesh = () => {
      if (navMeshHelper?.object) {
        scene.remove(navMeshHelper.object);
        disposeObject(navMeshHelper.object);
        navMeshHelper = null;
      }

      const colliders = buildColliderMeshes();
      if (colliders.length === 0) {
        if (!warnedNoCollider) {
          console.warn(
            "[NavMeshRig] No *collider* mesh synced yet — name a Blender object 'collider'. Will retry.",
          );
          warnedNoCollider = true;
        }
        return null;
      }

      // Transient meshes only feed the generator — the collider is already
      // rendered in this canvas by SyncViewer.
      const [positions, indices] = getPositionsAndIndices(colliders);
      for (const m of colliders) disposeMesh(m);

      const input: SoloNavMeshInput = { positions, indices };
      const config: SoloNavMeshOptions = {
        cellSize: guiSettings.cellSize,
        cellHeight: guiSettings.cellHeight,
        walkableRadiusWorld: guiSettings.walkableRadius,
        walkableRadiusVoxels: Math.ceil(
          guiSettings.walkableRadius / guiSettings.cellSize,
        ),
        walkableClimbWorld: guiSettings.walkableClimb,
        walkableClimbVoxels: Math.ceil(
          guiSettings.walkableClimb / guiSettings.cellHeight,
        ),
        walkableHeightWorld: guiSettings.walkableHeight,
        walkableHeightVoxels: Math.ceil(
          guiSettings.walkableHeight / guiSettings.cellHeight,
        ),
        walkableSlopeAngleDegrees: guiSettings.walkableSlopeAngle,
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

      navMeshHelper = createNavMeshHelper(navMesh);
      navMeshHelper.object.position.y += 0.15;
      scene.add(navMeshHelper.object);

      console.log("[NavMeshRig] Navmesh generated");
      return navMesh;
    };

    // ------------------------------------------------------------------
    // Player + character
    // ------------------------------------------------------------------
    const playerGroup = new THREE.Group();
    playerGroup.position.set(0, 2, 0);
    scene.add(playerGroup);

    const agentHelper = new THREE.Mesh(
      new THREE.CapsuleGeometry(
        guiSettings.walkableRadius,
        guiSettings.walkableHeight,
      ),
      new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true }),
    );
    agentHelper.position.y = 0.9;
    playerGroup.add(agentHelper);

    let characterScene: THREE.Object3D | null = null;
    let mixer: THREE.AnimationMixer | null = null;
    const animations: {
      idle: THREE.AnimationAction | null;
      walk: THREE.AnimationAction | null;
      run: THREE.AnimationAction | null;
    } = { idle: null, walk: null, run: null };

    new GLTFLoader().load(
      CHARACTER_URL,
      (gltf) => {
        if (disposed) return;
        characterScene = gltf.scene;
        playerGroup.add(characterScene);

        mixer = new THREE.AnimationMixer(characterScene);
        const idleClip = gltf.animations.find((c) => c.name === "Idle");
        const walkClip = gltf.animations.find((c) => c.name === "Walk");
        const runClip = gltf.animations.find((c) => c.name === "Run");

        animations.idle = idleClip ? mixer.clipAction(idleClip) : null;
        animations.walk = walkClip ? mixer.clipAction(walkClip) : null;
        animations.run = runClip ? mixer.clipAction(runClip) : null;

        if (animations.idle) {
          animations.idle.loop = THREE.LoopRepeat;
          animations.idle.weight = 1;
          animations.idle.play();
        }
        if (animations.walk) {
          animations.walk.loop = THREE.LoopRepeat;
          animations.walk.weight = 0;
          animations.walk.timeScale = 1.5;
          animations.walk.play();
        }
        if (animations.run) {
          animations.run.loop = THREE.LoopRepeat;
          animations.run.weight = 0;
          animations.run.play();
        }
      },
      undefined,
      (err) => console.warn("[NavMeshRig] Failed to load character:", err),
    );

    // ------------------------------------------------------------------
    // Place the player on the navmesh
    // ------------------------------------------------------------------
    const placePlayer = () => {
      if (!navMesh) return;

      const colliders = buildColliderMeshes();
      if (colliders.length === 0) return;

      const box = new THREE.Box3();
      for (const m of colliders) box.expandByObject(m);
      const boxCenter = box.getCenter(new THREE.Vector3());
      const candidates: Vec3[] = [
        computeStartPosition(colliders),
        [boxCenter.x, boxCenter.y, boxCenter.z],
        [0, 2, 0],
      ];
      for (const m of colliders) disposeMesh(m);

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
          console.log("[NavMeshRig] Positioned player at:", result.position);
          return;
        }
      }
      console.warn("[NavMeshRig] Could not find starting position on navmesh");
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
            "[NavMeshRig] Gave up waiting for a *collider* mesh — use the GUI 'Generate NavMesh' once one is synced.",
          );
          window.clearInterval(retryInterval);
        }
      }, 1500);
    } else {
      placePlayer();
    }

    // ------------------------------------------------------------------
    // Input
    // ------------------------------------------------------------------
    const input = {
      forward: false,
      back: false,
      left: false,
      right: false,
      sprint: false,
    };

    const handleKeyDown = (event: KeyboardEvent) => {
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

    const handleKeyUp = (event: KeyboardEvent) => {
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

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);

    // ------------------------------------------------------------------
    // GUI
    // ------------------------------------------------------------------
    // `container` mounts the GUI into a DOM element (and skips auto-place);
    // `parent` would be for nesting another GUI and expects a GUI, not a div.
    const gui = new GUI({
      container: guiContainer?.current ?? undefined,
    });
    const navMeshFolder = gui.addFolder("Nav Mesh");
    navMeshFolder.add(guiSettings, "showNavMeshHelper").name("Show Helper");
    navMeshFolder.add(guiSettings, "showAgentHelper").name("Show Agent Helper");
    navMeshFolder
      .add(guiSettings, "cellSize", 0.05, 0.3, 0.01)
      .name("Cell Size");
    navMeshFolder
      .add(guiSettings, "cellHeight", 0.05, 0.3, 0.01)
      .name("Cell Height");
    navMeshFolder
      .add(guiSettings, "walkableRadius", 0.1, 1, 0.1)
      .name("Walkable Radius");
    navMeshFolder
      .add(guiSettings, "walkableSlopeAngle", 0, 90, 1)
      .name("Walkable Slope Angle");
    navMeshFolder
      .add(guiSettings, "walkableClimb", 0.1, 1, 0.1)
      .name("Walkable Climb");
    navMeshFolder
      .add(guiSettings, "walkableHeight", 0.1, 3, 0.1)
      .name("Walkable Height");
    navMeshFolder
      .add(
        {
          generateNavMesh: () => {
            generateNavMesh();
            placePlayer();
          },
        },
        "generateNavMesh",
      )
      .name("Generate NavMesh");

    const playerFolder = gui.addFolder("Player Speed");
    playerFolder
      .add(guiSettings, "walkingSpeed", 0.1, 50, 0.1)
      .name("Walking Speed");
    playerFolder
      .add(guiSettings, "runningSpeed", 0.1, 50, 0.1)
      .name("Running Speed");

    const cameraFolder = gui.addFolder("Camera");
    cameraFolder.add(guiSettings, "offsetBehind", 5, 30, 1).name("Offset Behind");
    cameraFolder.add(guiSettings, "offsetAbove", 2, 15, 1).name("Offset Above");

    // ------------------------------------------------------------------
    // Movement / animation / camera scratch state
    // ------------------------------------------------------------------
    const movement = { vector: new THREE.Vector3(), sprinting: false };
    let firstPositionUpdate = true;

    const movementTarget = new THREE.Vector3();
    const raycasterOrigin = new THREE.Vector3();
    const raycasterDirection = new THREE.Vector3();
    const playerEuler = new THREE.Euler();
    const playerQuaternion = new THREE.Quaternion();
    const cameraPosition = new THREE.Vector3();
    const cameraLookAt = new THREE.Vector3();
    const cameraOffset = new THREE.Vector3();
    const cameraPositionTarget = new THREE.Vector3();

    const raycaster = new THREE.Raycaster();
    raycaster.near = 0.01;
    raycaster.far = 10;

    // Rendered *collider* meshes (from SyncViewer) used for height raycasts.
    // Refreshed periodically — the scene changes as Blender re-syncs.
    const colliderObjects: THREE.Object3D[] = [];
    let frameCounter = 0;
    const refreshColliderObjects = () => {
      colliderObjects.length = 0;
      scene.traverse((obj) => {
        if (
          (obj as THREE.Mesh).isMesh &&
          obj.name.toLowerCase().includes("collider")
        ) {
          colliderObjects.push(obj);
        }
      });
    };
    refreshColliderObjects();

    camera.position.set(5, 8, 5);
    camera.lookAt(0, 0, 0);
    cameraPosition.copy(camera.position);

    // ------------------------------------------------------------------
    // Per-frame update
    // ------------------------------------------------------------------
    const frame = (delta: number) => {
      const clamped = Math.min(delta, 0.1);

      // --- movement ---
      if (navMesh) {
        const { left, right, forward, back, sprint } = input;

        movement.vector.set(0, 0, 0);
        if (forward) movement.vector.z -= 1;
        if (back) movement.vector.z += 1;
        if (left) movement.vector.x -= 1;
        if (right) movement.vector.x += 1;

        const scalar = sprint
          ? guiSettings.runningSpeed
          : guiSettings.walkingSpeed;
        movement.vector.normalize().multiplyScalar(scalar * clamped);

        if (movement.vector.length() > 0 || firstPositionUpdate) {
          movementTarget.copy(playerGroup.position).add(movement.vector);

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
        movement.sprinting = sprint;
      }

      // --- animation ---
      const t = 1.0 - 0.01 ** clamped;

      if (movement.vector.length() > 0) {
        const rotation = Math.atan2(movement.vector.x, movement.vector.z);
        const targetQuaternion = playerQuaternion.setFromEuler(
          playerEuler.set(0, rotation, 0),
        );
        playerGroup.quaternion.slerp(targetQuaternion, t * 5);
      }

      const speed = movement.vector.length();
      let idleWeight: number;
      let walkWeight: number;
      let runWeight: number;
      if (speed < 0.01) {
        idleWeight = 1;
        walkWeight = 0;
        runWeight = 0;
      } else if (movement.sprinting) {
        idleWeight = 0;
        walkWeight = 0;
        runWeight = 1;
      } else {
        idleWeight = 0;
        walkWeight = 1;
        runWeight = 0;
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

      // Height correction against the rendered collider meshes
      frameCounter++;
      if (frameCounter % 45 === 0) refreshColliderObjects();
      if (navMesh && colliderObjects.length > 0) {
        const origin = raycasterOrigin.copy(playerGroup.position);
        origin.y += 1;
        raycaster.set(origin, raycasterDirection.set(0, -1, 0));
        const hits = raycaster.intersectObjects(colliderObjects, false);
        const hit = hits.sort((a, b) => a.distance - b.distance)[0];
        if (hit) {
          const yDiff = Math.abs(hit.point.y - playerGroup.position.y);
          if (yDiff < 1) playerGroup.position.y = hit.point.y;
        }
      }

      // --- camera follow ---
      const offsetVector = cameraOffset.set(
        0,
        guiSettings.offsetAbove,
        guiSettings.offsetBehind,
      );
      const target = cameraPositionTarget
        .copy(playerGroup.position)
        .add(offsetVector);
      cameraPosition.lerp(target, t / 1.1);
      camera.position.copy(cameraPosition);
      camera.lookAt(
        cameraLookAt.copy(cameraPosition).sub(offsetVector),
      );

      // --- mixer + helpers ---
      if (mixer) mixer.update(clamped);
      if (navMeshHelper?.object) {
        navMeshHelper.object.visible = guiSettings.showNavMeshHelper;
      }
      agentHelper.visible = guiSettings.showAgentHelper;
    };

    frameRef.current = { frame };

    // ------------------------------------------------------------------
    // Cleanup
    // ------------------------------------------------------------------
    return () => {
      disposed = true;
      window.clearInterval(retryInterval);
      frameRef.current = { frame: () => {} };

      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      gui.destroy();

      if (navMeshHelper?.object) {
        scene.remove(navMeshHelper.object);
        disposeObject(navMeshHelper.object);
      }
      scene.remove(playerGroup);
      if (characterScene) disposeObject(characterScene);
      agentHelper.geometry.dispose();
      agentHelper.material.dispose();
    };
  }, [scene, camera]);

  useFrame((_, delta) => {
    frameRef.current.frame(delta);
  });

  return null;
}
