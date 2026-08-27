"use client";

import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { useBlenderStore } from "../stores/blenderStore";
import { useMemo } from "react";

// ---------------------------------------------------------------------------
// CameraSync — mirrors the Blender 3D-viewport camera into any Three.js scene.
//
// Blender sends position / euler (XYZ) / scale already converted to
// Three.js Y‑up space, so this component just reads the values directly.
// Drop it inside any <CanvasGPU> to enable live camera sync.
// ---------------------------------------------------------------------------

export function CameraSync() {
  const cameraData = useBlenderStore((s) => s.cameraData);
  const selectedCamera = useBlenderStore((s) => s.selectedCamera);
  const camera = useThree((s) => s.camera);

  const lo = useMemo(() => {
    return new THREE.Object3D();
  }, []);

  useFrame(() => {
    // Selected scene camera wins; otherwise follow the live Blender viewport.
    const activeCam = selectedCamera ?? cameraData;
    if (!activeCam) return;

    lo.position.set(
      activeCam.position[0],
      activeCam.position[1],
      activeCam.position[2],
    );
    lo.quaternion.set(
      activeCam.quaternion[0],
      activeCam.quaternion[1],
      activeCam.quaternion[2],
      activeCam.quaternion[3],
    );
    lo.scale.set(activeCam.scale[0], activeCam.scale[1], activeCam.scale[2]);

    camera.position.lerp(lo.position, 0.05);
    camera.scale.lerp(lo.scale, 0.1);
    camera.quaternion.slerp(lo.quaternion, 0.05);

    if ("fov" in camera && !activeCam.ortho) {
      (camera as THREE.PerspectiveCamera).fov = THREE.MathUtils.lerp(
        camera.fov,
        activeCam.fov,
        0.1,
      );
      (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
    }

    camera.up.set(0, 1, 0);
  });

  return null;
}
