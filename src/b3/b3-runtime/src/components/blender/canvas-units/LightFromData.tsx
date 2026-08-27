"use client";

import * as THREE from "three";
import type { LightData } from "../../types/blenderTypes";

// ---------------------------------------------------------------------------
// Shared R3F light component — used by both ProductionViewer and SyncViewer
// ---------------------------------------------------------------------------

export interface LightFromDataProps {
  light: LightData;
  /** Multiplier applied to light.intensity before passing to Three.js.
   *  Default 1.0 (no scaling). SyncViewer uses 1/10 to convert Blender
   *  radiant flux to practical luminous intensity. */
  intensityScale?: number;
}

export function LightFromData({
  light,
  intensityScale = 1.0 / 10.0,
}: LightFromDataProps) {
  const color = new THREE.Color(light.color[0], light.color[1], light.color[2]);
  const position: [number, number, number] = light.position;
  const quaternion: [number, number, number, number] = light.quaternion;
  const intensity = light.intensity * intensityScale;

  switch (light.type) {
    case "SUN":
      return (
        <directionalLight
          position={position}
          quaternion={quaternion}
          intensity={intensity}
          color={color}
          castShadow={light.castShadow ?? true}
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-near={0.1}
          shadow-camera-far={500}
          shadow-camera-left={-200}
          shadow-camera-right={200}
          shadow-camera-top={200}
          shadow-camera-bottom={-200}
          shadow-bias={-0.00005}
          shadow-normalBias={0.02}
        />
      );

    case "POINT":
      return (
        <pointLight
          position={position}
          quaternion={quaternion}
          intensity={intensity}
          color={color}
          distance={light.distance ?? 0}
          decay={light.distance && light.distance > 0 ? 2 : undefined}
          castShadow={light.castShadow ?? true}
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-near={0.01}
          shadow-camera-far={light.distance || 50}
          shadow-bias={-0.0001}
          shadow-normalBias={0.02}
        />
      );

    case "SPOT":
      return (
        <spotLight
          position={position}
          quaternion={quaternion}
          intensity={intensity}
          color={color}
          distance={light.distance ?? 0}
          angle={light.coneAngle ?? Math.PI / 4}
          penumbra={light.penumbra ?? 0}
          decay={light.distance && light.distance > 0 ? 2 : undefined}
          castShadow={light.castShadow ?? true}
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-near={0.1}
          shadow-camera-far={light.distance || 50}
          shadow-bias={-0.0001}
          shadow-normalBias={0.02}
        />
      );

    case "AREA":
      return (
        <rectAreaLight
          position={position}
          quaternion={quaternion}
          intensity={intensity}
          color={color}
          width={light.width ?? 1}
          height={light.height ?? 1}
          castShadow={light.castShadow ?? true}
        />
      );

    default:
      // Unknown light type — fall back to point light
      return (
        <pointLight
          position={position}
          quaternion={quaternion}
          intensity={intensity}
          color={color}
        />
      );
  }
}
