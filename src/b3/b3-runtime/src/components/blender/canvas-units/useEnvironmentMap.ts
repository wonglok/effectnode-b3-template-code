"use client";

import { useEffect } from "react";
import * as THREE from "three/webgpu";
import { HDRLoader } from "three/examples/jsm/Addons.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UseEnvironmentMapOptions {
  /** Target scene. */
  scene: THREE.Scene;
  /** WebGPU renderer (used to build the PMREM). */
  renderer: THREE.WebGPURenderer | any;
  /** Raw HDR pixel data (float32 or Radiance RGBE). Pass null/undefined
   *  or an empty buffer to clear the environment and use the fallback. */
  hdrPixels: ArrayBuffer | null | undefined;
  /** Environment intensity. Default 1.0. */
  intensity?: number;
  /** Set the HDR texture as `scene.background`. Default true. */
  background?: boolean;
  /** Fallback background colour when no HDR data is available. */
  fallbackColor?: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Builds a PMREM environment map from raw HDR pixel data and applies it to
 * the scene (environment + background + intensity).
 *
 * Shared between {@link SyncViewer} (live Blender HDR) and
 * {@link ProductionViewer} (static zip-export HDR).
 */
export function useEnvironmentMap({
  scene,
  renderer,
  hdrPixels,
  intensity = 1.0,
  background = true,
  fallbackColor = "#f4f4f4",
}: UseEnvironmentMapOptions) {
  useEffect(() => {
    if (!renderer || !scene) return;

    if (!hdrPixels || hdrPixels.byteLength === 0) {
      // No HDR data — clear environment, use flat fallback background
      scene.environment = null;
      scene.background = new THREE.Color(fallbackColor);
      return;
    }

    const hdrLoader = new HDRLoader();
    const texture = hdrLoader.createDataTexture(hdrPixels);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.needsUpdate = true;

    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    pmremGenerator.compileEquirectangularShader();
    const envMap = pmremGenerator.fromEquirectangular(texture).texture;

    scene.environment = envMap;

    if (background) {
      scene.background = texture;
    }

    texture.dispose();
    pmremGenerator.dispose();
  }, [hdrPixels, scene, renderer, background, fallbackColor]);

  // ------------------------------------------------------------------
  // Apply environment intensity (updated independently — cheap,
  // no PMREM rebuild needed)
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!scene) return;
    scene.environmentIntensity = intensity;
  }, [intensity, scene]);
}
