"use client";

import { useEffect } from "react";
import { useThree } from "@react-three/fiber";
import { useBlenderStore } from "../../stores/blenderStore";
import {
  _geoMaterialCache,
  getOrCreateTexture,
  buildGeometryFromBuffer,
  computeMeshCacheKey,
} from "../../utils/meshBuilder";
import type { BlenderObject } from "../../types/blenderTypes";
import { LightFromData } from "../canvas-units/LightFromData";
import { useMeshSync } from "../canvas-units/useMeshSync";
import { useEmptySync } from "../canvas-units/useEmptySync";
import { useEnvironmentMap } from "../canvas-units/useEnvironmentMap";

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

import { useBlenderSyncStore } from "../../stores/blenderSyncStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { LoadObject3DAsync } from "../../custom/LoadObject3DAsync";

export function RefreshButton({
  className = "block px-3 py-1 text-white text-sm bg-blue-500 rounded-lg m-1",
}) {
  let connectionState = useBlenderStore((r) => r.connectionState);
  return (
    <>
      <button
        onClick={() => {
          useBlenderSyncStore.getState().refresh();
        }}
        className={className}
      >
        Refresh{" "}
        {connectionState === "connected" ? `[Connected]` : `[Disconnected]`}
      </button>
    </>
  );
}

export function BlenderConnection() {
  const disconnect = useBlenderSyncStore((s) => s.disconnect);

  // Hydrate persisted settings from localStorage on the client (SSR-safe)
  const hydrate = useSettingsStore((s) => s.hydrate);
  useEffect(() => {
    hydrate();
  }, [hydrate]);

  // Connect to Blender WebSocket on mount, disconnect on unmount
  useEffect(() => {
    const connectFn = useBlenderSyncStore.getState().connect;
    connectFn();

    return () => {
      disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return <></>;
}

export function SyncViewer() {
  const sceneData = useBlenderStore((s) => s.sceneData);
  const hdrData = useBlenderStore((s) => s.hdrData);
  const hdrIntensity = useBlenderStore((s) => s.hdrIntensity);
  const texData = useBlenderStore((s) => s.texData);
  const geoBuffers = useBlenderStore((s) => s.geoBuffers);
  const lights = useBlenderStore((s) => s.lights);

  const scene = useThree((r) => r.scene);
  const gl = useThree((r) => r.gl);

  // ------------------------------------------------------------------
  // Apply HDR environment map + intensity (shared hook)
  // ------------------------------------------------------------------
  useEnvironmentMap({
    scene: scene!,
    renderer: gl,
    hdrPixels: hdrData?.pixels,
    intensity: hdrIntensity,
    background: false,
    fallbackColor: "#000000",
  });

  // ------------------------------------------------------------------
  // Sync meshes from Blender data (with InstancedMesh batching)
  // ------------------------------------------------------------------
  useMeshSync({
    scene: scene!,
    objects: sceneData.objects,
    resolveTextures: (obj: BlenderObject) => ({
      map: obj.texture
        ? getOrCreateTexture(obj.texture, texData, "color")
        : null,
      roughnessMap: obj.roughnessMap
        ? getOrCreateTexture(obj.roughnessMap, texData, "noncolor")
        : null,
      metalnessMap: obj.metalnessMap
        ? getOrCreateTexture(obj.metalnessMap, texData, "noncolor")
        : null,
      normalMap: obj.normalMap
        ? getOrCreateTexture(obj.normalMap, texData, "noncolor")
        : null,
      emissiveMap: obj.emissiveMap
        ? getOrCreateTexture(obj.emissiveMap, texData, "color")
        : null,
    }),
    computeCacheKey: (obj: BlenderObject, textures) => {
      const geoBuf = geoBuffers.get(obj.name);
      return computeMeshCacheKey(
        obj.name,
        obj.version,
        geoBuf?.version,
        textures.map,
        textures.roughnessMap,
        textures.metalnessMap,
        textures.normalMap,
        textures.emissiveMap,
      );
    },
    buildGeometryMaterial: (obj: BlenderObject, textures) => {
      const geoBuf = geoBuffers.get(obj.name);
      if (!geoBuf || geoBuf.version !== obj.version) return null;

      const geoName = (obj as any).geometry ?? obj.name;
      const cacheKey = computeMeshCacheKey(
        geoName,
        obj.version,
        geoBuf.version,
        textures.map,
        textures.roughnessMap,
        textures.metalnessMap,
        textures.normalMap,
        textures.emissiveMap,
      );

      let geoMat = _geoMaterialCache.get(cacheKey);
      if (!geoMat) {
        geoMat = buildGeometryFromBuffer({
          buf: geoBuf,
          color: obj.color,
          roughness: obj.roughness ?? 0.5,
          metalness: obj.metalness ?? 0.0,
          emissiveColor: obj.emissiveColor ?? [0, 0, 0],
          emissiveIntensity: obj.emissiveIntensity ?? 0.0,
          map: textures.map,
          roughnessMap: textures.roughnessMap,
          metalnessMap: textures.metalnessMap,
          normalMap: textures.normalMap,
          emissiveMap: textures.emissiveMap,
          transparent: obj.transparent,
          opacity: obj.opacity,
          alphaTest: obj.alphaTest,
          flatShading: obj.flatShading,
          doubleSided: obj.doubleSided,
          graph: obj.graph,
        }) as any;
        _geoMaterialCache.set(cacheKey, geoMat as any);
      }

      return geoMat as any;
    },
  });

  // ------------------------------------------------------------------
  // Sync empty objects (named transform nodes — no geometry)
  // ------------------------------------------------------------------
  useEmptySync({
    scene: scene!,
    objects: sceneData.objects,
  });

  // Blender energy (Watts) → Three.js intensity conversion.
  // Multiply by 4π to convert radiant flux to luminous intensity,
  // then divide by 25 to bring values into a practical range.
  const ENERGY_SCALE = 1 / 10;

  return (
    <group>
      {/* Wheel / pinch zoom — dollies the camera position so it survives
          CameraSync + NavMeshRig (runs at a later frame priority) */}
      {/* <ZoomControls /> */}

      <LoadObject3DAsync texData={texData} objects={sceneData.objects as []}></LoadObject3DAsync>

      {/* Lights from Blender — declarative via shared LightFromData */}
      {lights.map((light) => (
        <LightFromData
          key={light.name}
          light={light}
          intensityScale={ENERGY_SCALE}
        />
      ))}
    </group>
  );
}
