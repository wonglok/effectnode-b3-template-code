"use client";

import { useEffect, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";

// ---------------------------------------------------------------------------
// ZoomControls — wheel / pinch zoom for the viewers.
//
// Zoom dollies the *camera position* along its view direction using a
// THREE.Spherical (radius accumulates the signed dolly distance, phi/theta
// track the current view direction). It does not touch FOV.
//
// CameraSync and NavMeshRig both overwrite `camera.position` every frame, so a
// one-shot dolly would be wiped. Instead, while a zoom is active the position
// is re-applied each frame (later priority) as a pivot around an anchor point:
//
//   position = anchor + forward * radius        (radius > 0 = zoomed in)
//
// The anchor is captured from the camera when the zoom first engages, so the
// view lifts off from wherever the controller had it. Dollying back through a
// radius of 0 (or back up to it) hands full control back to the controller,
// keeping sync / character-follow seamless.
// ---------------------------------------------------------------------------

const MAX_RADIUS = 500;

export function ZoomControls() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const sphericalRef = useRef(new THREE.Spherical(0, Math.PI / 2, 0));
  const anchorRef = useRef(new THREE.Vector3());
  const forwardRef = useRef(new THREE.Vector3());
  const offsetRef = useRef(new THREE.Vector3());
  const lastPinchDist = useRef<number | null>(null);

  // Move the dolly distance by `delta` world units along the view direction.
  // Passing through 0 releases the camera back to the controller.
  const dolly = (delta: number) => {
    const r = sphericalRef.current.radius;
    if (r === 0 && delta !== 0) anchorRef.current.copy(camera.position);
    const next = r + delta;
    sphericalRef.current.radius =
      r !== 0 && r * next <= 0
        ? 0
        : THREE.MathUtils.clamp(next, -MAX_RADIUS, MAX_RADIUS);
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

  // Apply the dolly every frame, after CameraSync / NavMeshRig (priority 0).
  useFrame(() => {
    const radius = sphericalRef.current.radius;

    // Neutral → leave the position to the camera controller (live sync or the
    // navmesh follow). Keep the anchor fresh so the next zoom lifts off from
    // wherever the controller currently has the camera.
    if (radius === 0) {
      anchorRef.current.copy(camera.position);
      return;
    }

    // Dolly along the current view direction, pivoting around the anchor.
    camera.getWorldDirection(forwardRef.current);
    sphericalRef.current.setFromVector3(forwardRef.current); // phi/theta = view dir
    sphericalRef.current.radius = radius; // keep the accumulated dolly distance
    camera.position.copy(anchorRef.current).add(
      offsetRef.current.setFromSphericalCoords(
        sphericalRef.current.radius,
        sphericalRef.current.phi,
        sphericalRef.current.theta,
      ),
    );
  }, 10);

  return null;
}
