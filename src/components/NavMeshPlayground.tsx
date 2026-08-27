"use client";

import { useEffect, useRef } from "react";
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
import {
  createNavMeshHelper,
  getPositionsAndIndices,
} from "navcat/three";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NavMeshPlaygroundProps {
  /** Close the overlay. */
  onClose: () => void;
  /**
   * Supplies the world-space walkable meshes the navmesh is generated from
   * (e.g. the Blender-synced geometry). When omitted, a procedural level is
   * built instead. Called again on every "Generate NavMesh".
   */
  getWalkableMeshes?: () => THREE.Mesh[];
}

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

/** Level material used for supplied Blender meshes and the procedural level. */
const levelMaterial = new THREE.MeshStandardMaterial({
  color: 0x9aa4a6,
  metalness: 0.0,
  roughness: 0.9,
  flatShading: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dispose a mesh (and its geometry / materials) so regeneration doesn't leak. */
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
          for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap"] as const) {
            m2[k]?.dispose();
          }
          m.dispose();
        }
      }
    }
  });
}

/** Build a small procedural level (ground, stairs, ramp, platforms). */
export function buildProceduralLevel(): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];

  const walkable = (geometry: THREE.BufferGeometry, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geometry, levelMaterial);
    mesh.position.set(x, y, z);
    mesh.userData.walkable = true;
    meshes.push(mesh);
    return mesh;
  };

  // Ground
  walkable(new THREE.BoxGeometry(40, 0.2, 40), 0, -0.1, 0);

  // Stairs (3 steps)
  walkable(new THREE.BoxGeometry(6, 0.4, 2), 0, 0.2, -12);
  walkable(new THREE.BoxGeometry(6, 0.8, 2), 0, 0.4, -10);
  walkable(new THREE.BoxGeometry(6, 1.2, 2), 0, 0.6, -8);

  // Ramp
  const ramp = new THREE.BoxGeometry(4, 0.2, 8);
  const rampMesh = walkable(ramp, -8, 1.2, -2);
  rampMesh.rotation.x = -0.2;

  // Raised platform
  walkable(new THREE.BoxGeometry(8, 0.4, 8), 8, 0.2, 6);
  // Low step up to it
  walkable(new THREE.BoxGeometry(2, 0.6, 2), 4, 0.3, 6);

  // Scatter a few cubes to show the walkable-slope filter
  walkable(new THREE.BoxGeometry(1, 2, 1), 12, 1, -6);
  walkable(new THREE.BoxGeometry(1, 2.4, 1), 14, 1.2, -8);
  walkable(new THREE.BoxGeometry(1, 1.6, 1), -12, 0.8, 6);

  return meshes;
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
// Component
// ---------------------------------------------------------------------------

export function NavMeshPlayground({
  onClose,
  getWalkableMeshes,
}: NavMeshPlaygroundProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current!;
    let disposed = false;

    /** Show a status banner (e.g. "no walkable collider yet"). */
    const setStatus = (message: string | null) => {
      if (statusRef.current) {
        statusRef.current.textContent = message ?? "";
        statusRef.current.style.display = message ? "block" : "none";
      }
    };

    // ------------------------------------------------------------------
    // Renderer / scene / camera
    // ------------------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111415);

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      0.1,
      1000,
    );
    camera.position.set(5, 8, 5);
    camera.lookAt(0, 0, 0);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 1.5);
    directionalLight.position.set(5, 10, 7.5);
    directionalLight.castShadow = true;
    scene.add(directionalLight);

    // ------------------------------------------------------------------
    // Level (walkable meshes)
    // ------------------------------------------------------------------
    let levelMeshes: THREE.Mesh[] = [];

    const refreshLevel = () => {
      for (const m of levelMeshes) {
        scene.remove(m);
        disposeMesh(m);
      }
      levelMeshes = getWalkableMeshes ? getWalkableMeshes() : buildProceduralLevel();
      for (const m of levelMeshes) {
        if (!m.material) m.material = levelMaterial;
        if (!m.userData.walkable) m.userData.walkable = true;
        m.castShadow = true;
        m.receiveShadow = true;
        scene.add(m);
      }
    };

    refreshLevel();

    // ------------------------------------------------------------------
    // Character
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
      (err) => {
        console.warn("[NavMeshPlayground] Failed to load character:", err);
      },
    );

    // ------------------------------------------------------------------
    // GUI
    // ------------------------------------------------------------------
    const gui = new GUI();
    let navMesh: any;
    let navMeshHelper: any;

    const navMeshFolder = gui.addFolder("Nav Mesh");
    navMeshFolder.add(guiSettings, "showNavMeshHelper").name("Show Helper");
    navMeshFolder.add(guiSettings, "showAgentHelper").name("Show Agent Helper");
    navMeshFolder.add(guiSettings, "cellSize", 0.05, 0.3, 0.01).name("Cell Size");
    navMeshFolder.add(guiSettings, "cellHeight", 0.05, 0.3, 0.01).name("Cell Height");
    navMeshFolder.add(guiSettings, "walkableRadius", 0.1, 1, 0.1).name("Walkable Radius");
    navMeshFolder.add(guiSettings, "walkableSlopeAngle", 0, 90, 1).name("Walkable Slope Angle");
    navMeshFolder.add(guiSettings, "walkableClimb", 0.1, 1, 0.1).name("Walkable Climb");
    navMeshFolder.add(guiSettings, "walkableHeight", 0.1, 3, 0.1).name("Walkable Height");
    navMeshFolder
      .add(
        {
          generateNavMesh: () => {
            console.log("Generating navmesh...");
            generateNavMesh();
          },
        },
        "generateNavMesh",
      )
      .name("Generate NavMesh");

    const playerFolder = gui.addFolder("Player Speed");
    playerFolder.add(guiSettings, "walkingSpeed", 0.1, 50, 0.1).name("Walking Speed");
    playerFolder.add(guiSettings, "runningSpeed", 0.1, 50, 0.1).name("Running Speed");

    const cameraFolder = gui.addFolder("Camera");
    cameraFolder.add(guiSettings, "offsetBehind", 5, 30, 1).name("Offset Behind");
    cameraFolder.add(guiSettings, "offsetAbove", 2, 15, 1).name("Offset Above");

    // ------------------------------------------------------------------
    // NavMesh generation
    // ------------------------------------------------------------------
    const generateNavMesh = () => {
      console.log("Generating navmesh with current settings...");

      // Rebuild level from the supplier (Blender sync) when present
      if (getWalkableMeshes) refreshLevel();

      // No walkable collider — nothing to generate from. Show why.
      if (levelMeshes.length === 0) {
        setStatus(
          "No walkable collider found — sync a Blender object named “collider”.",
        );
        console.warn("NavMeshPlayground: no walkable meshes to generate from");
        return;
      }
      setStatus(null);

      // Clean up existing navmesh helper if it exists
      if (navMeshHelper?.object) {
        scene.remove(navMeshHelper.object);
        disposeObject(navMeshHelper.object);
      }

      // Update agent helper geometry with current settings
      agentHelper.geometry.dispose();
      agentHelper.geometry = new THREE.CapsuleGeometry(
        guiSettings.walkableRadius,
        guiSettings.walkableHeight,
      );

      const [positions, indices] = getPositionsAndIndices(levelMeshes);

      const navMeshInput: SoloNavMeshInput = { positions, indices };

      const navMeshConfig: SoloNavMeshOptions = {
        cellSize: guiSettings.cellSize,
        cellHeight: guiSettings.cellHeight,
        walkableRadiusWorld: guiSettings.walkableRadius,
        walkableRadiusVoxels: Math.ceil(guiSettings.walkableRadius / guiSettings.cellSize),
        walkableClimbWorld: guiSettings.walkableClimb,
        walkableClimbVoxels: Math.ceil(guiSettings.walkableClimb / guiSettings.cellHeight),
        walkableHeightWorld: guiSettings.walkableHeight,
        walkableHeightVoxels: Math.ceil(guiSettings.walkableHeight / guiSettings.cellHeight),
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

      const navMeshResult = generateSoloNavMesh(navMeshInput, navMeshConfig);
      navMesh = navMeshResult.navMesh;

      // Create new helper and add to scene
      navMeshHelper = createNavMeshHelper(navMesh);
      navMeshHelper.object.position.y += 0.15;
      scene.add(navMeshHelper.object);

      console.log("Navmesh generated successfully!");
    };

    // Generate initial navmesh and place the player
    generateNavMesh();

    if (navMesh) {
      // Try a few candidate start points — the navmesh may sit far from the
      // level's bounding-box centre (e.g. scattered Blender colliders).
      const box = new THREE.Box3();
      for (const m of levelMeshes) box.expandByObject(m);
      const boxCenter = box.getCenter(new THREE.Vector3());
      const candidates: Vec3[] = [
        computeStartPosition(levelMeshes),
        [boxCenter.x, boxCenter.y, boxCenter.z],
        [0, 2, 0],
      ];

      let placed = false;
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
          console.log("Positioned player at:", result.position);
          placed = true;
          break;
        }
      }
      if (!placed) {
        console.warn("Could not find starting position on navmesh");
      }
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
    // Movement / animation / camera
    // ------------------------------------------------------------------
    const movement = {
      vector: new THREE.Vector3(),
      sprinting: false,
    };

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

    cameraPosition.copy(camera.position);

    const movementUpdate = (delta: number) => {
      // No navmesh → nothing to walk on.
      if (!navMesh) return;

      const { left, right, forward, back, sprint } = input;

      movement.vector.set(0, 0, 0);

      if (forward || back) {
        if (forward) movement.vector.z -= 1;
        if (back) movement.vector.z += 1;
      }

      if (left || right) {
        if (left) movement.vector.x -= 1;
        if (right) movement.vector.x += 1;
      }

      const movementScalar = sprint
        ? guiSettings.runningSpeed
        : guiSettings.walkingSpeed;

      movement.vector.normalize().multiplyScalar(movementScalar * delta);

      if (movement.vector.length() > 0 || firstPositionUpdate) {
        movementTarget.copy(playerGroup.position).add(movement.vector);

        const halfExtents: Vec3 = [1, 1, 1];
        const nearestResult = findNearestPoly(
          createFindNearestPolyResult(),
          navMesh,
          [
            playerGroup.position.x,
            playerGroup.position.y,
            playerGroup.position.z,
          ],
          halfExtents,
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
    };

    const animationUpdate = (delta: number) => {
      const t = 1.0 - 0.01 ** delta;

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

      // Raycast to correct character height against walkable meshes
      const characterRayOrigin = raycasterOrigin.copy(playerGroup.position);
      characterRayOrigin.y += 1;

      raycaster.set(
        characterRayOrigin,
        raycasterDirection.set(0, -1, 0),
      );

      const characterRayHits = raycaster.intersectObjects(levelMeshes, false);
      const characterRayHit = characterRayHits
        .filter((hit) => hit.object.userData.walkable)
        .sort((a, b) => a.distance - b.distance)[0];

      if (characterRayHit) {
        const yDifference = Math.abs(
          characterRayHit.point.y - playerGroup.position.y,
        );
        if (yDifference < 1) {
          playerGroup.position.y = characterRayHit.point.y;
        }
      }
    };

    const cameraUpdate = (delta: number) => {
      const offsetVector = cameraOffset.set(
        0,
        guiSettings.offsetAbove,
        guiSettings.offsetBehind,
      );
      const target = cameraPositionTarget
        .copy(playerGroup.position)
        .add(offsetVector);

      const t = 1.0 - 0.01 ** delta;

      cameraPosition.lerp(target, t / 1.1);
      camera.position.copy(cameraPosition);

      const lookAt = cameraLookAt.copy(cameraPosition).sub(offsetVector);
      camera.lookAt(lookAt);
    };

    // ------------------------------------------------------------------
    // Main loop
    // ------------------------------------------------------------------
    let prevTime = performance.now();
    let rafId = 0;

    const update = () => {
      if (disposed) return;
      rafId = requestAnimationFrame(update);

      const time = performance.now();
      const deltaTime = (time - prevTime) / 1000;
      const clampedDeltaTime = Math.min(deltaTime, 0.1);
      prevTime = time;

      movementUpdate(clampedDeltaTime);
      animationUpdate(clampedDeltaTime);
      cameraUpdate(clampedDeltaTime);

      if (mixer) mixer.update(clampedDeltaTime);

      if (navMeshHelper?.object) {
        navMeshHelper.object.visible = guiSettings.showNavMeshHelper;
      }
      agentHelper.visible = guiSettings.showAgentHelper;

      renderer.render(scene, camera);
    };

    update();

    // ------------------------------------------------------------------
    // Resize
    // ------------------------------------------------------------------
    const handleResize = () => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener("resize", handleResize);

    // ------------------------------------------------------------------
    // Teardown
    // ------------------------------------------------------------------
    return () => {
      disposed = true;
      cancelAnimationFrame(rafId);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("resize", handleResize);

      gui.destroy();

      for (const m of levelMeshes) {
        scene.remove(m);
        disposeMesh(m);
      }
      if (navMeshHelper?.object) {
        scene.remove(navMeshHelper.object);
        disposeObject(navMeshHelper.object);
      }
      if (characterScene) disposeObject(characterScene);
      agentHelper.geometry.dispose();
      agentHelper.material.dispose();

      renderer.dispose();
      if (renderer.domElement.parentElement === container) {
        container.removeChild(renderer.domElement);
      }
    };
  }, [onClose, getWalkableMeshes]);

  return (
    <div className="fixed inset-0 z-50 bg-studio-950">
      {/* Close */}
      <button
        onClick={onClose}
        className="absolute top-3 left-3 z-[60] px-3 py-1.5 rounded-md bg-studio-800 border border-studio-700 text-ice-200 text-xs font-mono hover:bg-studio-700 transition-colors"
      >
        ✕ Close
      </button>

      {/* three.js mount */}
      <div ref={containerRef} className="w-full h-full" />

      {/* Status banner (hidden unless there's something to say) */}
      <div
        ref={statusRef}
        style={{ display: "none" }}
        className="absolute bottom-4 left-1/2 -translate-x-1/2 px-4 py-2 rounded-md bg-studio-800/90 border border-status-yellow/40 text-status-yellow text-xs font-mono pointer-events-none"
      />
    </div>
  );
}
