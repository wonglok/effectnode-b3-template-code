"use client";

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";

// ---------------------------------------------------------------------------
// ZoomControls — wheel / pinch zoom for the viewers.
//
// Follows the navmesh player (an object named "player", added by NavMeshRig)
// with an overhead-behind offset and lets wheel / pinch dolly the camera in
// and out along that axis:
//
//   camera = playerPosition + offsetPosition
//   offset = normalize(initPosition) * (initDistance - radius)
//
// The zoom radius accumulates the signed dolly distance (radius > 0 = zoomed
// in, camera pulled toward the player). It does not touch FOV.
//
// Runs at frame priority 10 so it wins over CameraSync / NavMeshRig. When no
// player object exists (e.g. CameraSync mode), it leaves the camera to its
// controller.
// ---------------------------------------------------------------------------

const MAX_RADIUS = 500;
const MIN_RADIUS = -500;

export function ZoomControls() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  const sphericalRef = useRef(new THREE.Spherical(0, Math.PI / 2, 0));
  const anchorRef = useRef(new THREE.Vector3(0, 15, 15));
  const offsetRef = useRef(new THREE.Vector3());
  const tmpRef = useRef(new THREE.Vector3());
  const lastPinchDist = useRef<number | null>(null);

  const initPosition = useMemo(() =>{
    return new THREE.Vector3(0,1.5,1.5)
  }, [])
  const playerPosition = useMemo(() =>{
    return new THREE.Vector3(0,0,0)
  }, [])

  // Move the dolly distance by `delta` world units along the view direction.
  // Passing through 0 releases the camera back to the controller.
  const dolly = (delta: number) => {
    const r = sphericalRef.current.radius;
    if (r === 0 && delta !== 0) anchorRef.current.copy(camera.position);
    const next = r + delta;
    sphericalRef.current.radius =
      r !== 0 && r * next <= 0
        ? 0
        : THREE.MathUtils.clamp(next, MIN_RADIUS, MAX_RADIUS);
  };

  // Wheel → dolly. Scroll up (deltaY < 0) zooms in: radius increases.
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      dolly(-e.deltaY * 0.015);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gl]);

  // Two-finger pinch → dolly. Spreading (distance grows) zooms in.
  useEffect(() => {
    const el = gl.domElement;
    const pinchDist = (t: TouchList) => {
      const a = t[0];
      const b = t[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length === 2) lastPinchDist.current = pinchDist(e.touches);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      e.preventDefault(); // keep the browser from panning mid-pinch
      const d = pinchDist(e.touches);
      if (lastPinchDist.current != null) {
        dolly((d - lastPinchDist.current) * 0.03);
      }
      lastPinchDist.current = d;
    };
    const onTouchEnd = () => {
      lastPinchDist.current = null;
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd);
    el.addEventListener("touchcancel", onTouchEnd);
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      el.removeEventListener("touchend", onTouchEnd);
      el.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [gl]);


  // Follow the player with an overhead-behind offset; wheel / pinch dolly the
  // camera along that axis. No player object → leave the camera to its controller.
  useFrame((_) => {
    _.camera.near = 1
    _.camera.far = 500
    _.camera.updateProjectionMatrix()
    // 1. compute player position (world space)
    const player = scene.getObjectByName("player");
    if (!player) return;

    playerPosition.copy(player.getWorldPosition(tmpRef.current));

    // 2. compute offset position — baseline overhead-behind offset, pulled
    //    toward the player as you zoom in (radius > 0), pushed out as you zoom out.
    const radius = sphericalRef.current.radius;
    offsetRef.current
      .copy(initPosition)
      .normalize()
      .multiplyScalar(Math.max(1, initPosition.length() - radius));

    // 3. camera = player position + offset position
    camera.position.copy(playerPosition).add(offsetRef.current);
    camera.lookAt(playerPosition);
  }); // frame priority 10 — wins over CameraSync / NavMeshRig (both priority 0)

  return null;
}
