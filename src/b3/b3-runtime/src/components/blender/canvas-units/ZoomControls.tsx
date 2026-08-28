"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { useBlenderStore } from "../../stores/blenderStore";

// ---------------------------------------------------------------------------
// ZoomControls — wheel / pinch zoom for the viewers.
//
// Zoom is applied to the camera FOV rather than the camera position: CameraSync
// and NavMeshRig overwrite `camera.position` every frame, so a dolly would be
// undone the moment it's applied. FOV zoom composes with any camera controller,
// and the Blender-synced FOV is used as the base when present so it still
// follows the viewport (mirroring CameraSync). Runs at a later frame priority
// than the controllers so the zoom always wins.
// ---------------------------------------------------------------------------

const MIN_FOV = 5;
const MAX_FOV = 160;

export function ZoomControls() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  // Blender's synced camera wins when present — same selection as CameraSync.
  const selectedCamera = useBlenderStore((s) => s.selectedCamera);
  const cameraData = useBlenderStore((s) => s.cameraData);

  const scaleRef = useRef(1); // 1 = no zoom
  const baseFovRef = useRef<number | null>(null); // captured when no sync data
  const lastPinchDist = useRef<number | null>(null);

  const applyZoom = (factor: number) => {
    scaleRef.current = THREE.MathUtils.clamp(
      scaleRef.current * factor,
      0.05,
      20,
    );
  };

  // Wheel → zoom
  useEffect(() => {
    const el = gl.domElement;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      applyZoom(Math.exp(e.deltaY * 0.001));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [gl]);

  // Two-finger pinch → zoom
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
      if (lastPinchDist.current != null && lastPinchDist.current > 0) {
        applyZoom(lastPinchDist.current / d);
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

  // Apply the zoom every frame, after CameraSync / NavMeshRig (priority 0).
  useFrame(() => {
    if (!(camera instanceof THREE.PerspectiveCamera)) return; // ortho — no fov

    // Until the user zooms, leave the FOV to the camera controller (CameraSync
    // follows the Blender viewport, NavMeshRig keeps its default framing).
    if (scaleRef.current === 1) {
      baseFovRef.current = camera.fov;
      return;
    }

    // Base FOV = the Blender-synced camera when present (so zoom still follows
    // the viewport, mirroring CameraSync), else the pre-zoom FOV captured above.
    const syncCam = selectedCamera ?? cameraData;
    const base =
      syncCam && !syncCam.ortho
        ? syncCam.fov
        : (baseFovRef.current ?? camera.fov);

    camera.fov = THREE.MathUtils.clamp(base * scaleRef.current, MIN_FOV, MAX_FOV);
    camera.updateProjectionMatrix();
  }, 10);

  return null;
}
