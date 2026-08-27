"use client";

import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import {
  pass,
  mrt,
  output,
  normalView,
  diffuseColor,
  velocity,
  vec4,
  sample,
  packNormalToRGB,
  unpackRGBToNormal,
  emissive,
} from "three/tsl";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSGIParams {
  /** Number of per-pixel hemisphere slices (1-4). Higher = better quality,
   *  higher cost. Default 2.
   *
   *  With temporal filtering (TRAA):
   *  - Low:  1 slice,  12 steps
   *  - Med:  2 slices,  8 steps
   *  - High: 3 slices, 16 steps
   *
   *  Without temporal filtering:
   *  - Low:  2 slices,  6 steps
   *  - Med:  3 slices,  8 steps
   *  - High: 4 slices, 12 steps */
  sliceCount?: number;
  /** Number of samples per slice side (1-32). Higher = better quality,
   *  higher cost. Default 8. */
  stepCount?: number;
  /** Power applied to AO to make it appear darker/lighter (0-4). Default 1. */
  aoIntensity?: number;
  /** Intensity of the indirect diffuse light (0-100). Default 10. */
  giIntensity?: number;
  /** Effective sampling radius in world space (1-25). Default 12. */
  radius?: number;
  /** Sample in screen space instead of world space — more detail up close.
   *  Default true. */
  useScreenSpaceSampling?: boolean;
  /** Sample distribution exponent (1-3). Higher = samples cluster near
   *  the shading point. Default 2. */
  expFactor?: number;
  /** Constant thickness of objects in world units. Allows light to pass
   *  behind surfaces past this value (0.01-10). Default 1. */
  thickness?: number;
  /** Increase thickness linearly over distance — avoids losing detail
   *  at range. Default false. */
  useLinearThickness?: boolean;
  /** How much light backface surfaces emit (0-1). Default 0. */
  backfaceLighting?: number;
  /** Enable TRAA temporal anti-aliasing. Drastically reduces noise at low
   *  sample counts, at the cost of typical TAA ghosting/instability.
   *  When enabled, SSGI's internal temporal sampling is also active.
   *  Default true. */
  useTemporalFiltering?: boolean;
}

interface SSGIRenderProps {
  params?: SSGIParams;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Screen Space Global Illumination (SSGI) render pipeline.
 *
 * Based on the official Three.js SSGI + TRAA example. Composes screen-space
 * ambient occlusion and indirect diffuse bounce lighting with temporal
 * anti-aliasing into the final frame.
 *
 * Pipeline:
 * 1. Scene pass with MRT: output, diffuseColor, packed-normals, velocity
 * 2. SSGI pass: samples color, depth, and unpacked normals → AO + GI
 * 3. Composite:  beauty × AO + diffuse × GI  (physically correct)
 * 4. TRAA: temporal reprojection anti-aliasing / denoising
 *
 * Requires WebGPU (`three/webgpu`) and the `rg11b10ufloat-renderable`
 * GPU feature.
 *
 * Usage:
 * ```tsx
 * <CanvasGPU>
 *   <SSGIRender params={{ sliceCount: 2, stepCount: 8, giIntensity: 15 }} />
 *   <SyncViewer />
 * </CanvasGPU>
 * ```
 */
export function SSGIRender({ params }: SSGIRenderProps) {
  const gl = useThree((s) => s.gl) as THREE.WebGPURenderer | any;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera;

  const pipelineRef = useRef<THREE.RenderPipeline | null>(null);
  const ssgiRef = useRef<any>(null);
  const needsSetup = useRef(true);

  // Refs for pipeline switching (temporal filtering on/off)
  const traaPassRef = useRef<any>(null);
  const compositePassRef = useRef<any>(null);

  // ------------------------------------------------------------------
  // Build SSGI + TRAA pipeline once
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!needsSetup.current) return;
    needsSetup.current = false;

    const scenePass = pass(scene, camera);

    // MRT: output, diffuseColor, packed normals, velocity
    scenePass.setMRT(
      mrt({
        output,
        diffuseColor,
        normal: packNormalToRGB(normalView),
        velocity,
        emissive,
      }),
    );

    // Bandwidth optimization: use byte textures where precision allows
    const diffuseTexture = scenePass.getTexture("diffuseColor");
    diffuseTexture.type = THREE.UnsignedByteType;

    const normalTexture = scenePass.getTexture("normal");
    normalTexture.type = THREE.UnsignedByteType;

    // Extract pass texture nodes
    const scenePassColor = scenePass.getTextureNode("output");
    const scenePassDiffuse = scenePass.getTextureNode("diffuseColor");
    const scenePassDepth = scenePass.getTextureNode("depth");
    const scenePassNormal = scenePass.getTextureNode("normal");
    const scenePassVelocity = scenePass.getTextureNode("velocity");
    const scenePassEmissive = scenePass.getTextureNode("emissive");

    // Unpack normals for SSGI consumption
    const sceneNormal = sample((uv) => {
      return unpackRGBToNormal(scenePassNormal.sample(uv));
    });

    // SSGI effect
    const giPass = ssgi(scenePassColor, scenePassDepth, sceneNormal, camera);

    // Apply initial params
    if (params) {
      applyParams(giPass, params);
    }

    ssgiRef.current = giPass;

    // Compose final frame:
    //   beauty.rgb × AO  +  diffuse.rgb × GI
    // AO darkens the lit color; GI bounce is modulated by the surface's
    // albedo (diffuseColor) so colored walls reflect colored light.
    const ao = giPass.getAONode();
    const gi = giPass.getGINode();

    const bloomColor = vec4(
      bloom(scenePassColor.rgba.add(scenePassEmissive.rgba), 0.25, 1, 0.85),
    );

    const compositePass = vec4(
      scenePassColor.rgb.mul(ao.r).add(scenePassDiffuse.rgb.mul(gi.rgb)),
      scenePassColor.a,
    );

    // TRAA temporal anti-aliasing / denoising
    const traaPass = traa(
      compositePass.rgba.add(vec4(bloomColor.rgb, 0.0)),
      scenePassDepth,
      scenePassVelocity,
      camera,
    );

    compositePassRef.current = compositePass;
    traaPassRef.current = traaPass.rgba;

    // Build pipeline
    const postProcessing = new THREE.RenderPipeline(gl);
    pipelineRef.current = postProcessing;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------
  // Apply live param updates & switch output each frame
  // ------------------------------------------------------------------
  useFrame(() => {
    const node = ssgiRef.current;
    const pipeline = pipelineRef.current;
    if (!node || !pipeline) return;

    if (params) {
      applyParams(node, params);
    }

    // Choose output: TRAA (temporal) or raw composite
    const useTemporal = node.useTemporalFiltering;
    pipeline.outputNode = useTemporal
      ? vec4(traaPassRef.current.rgba)
      : vec4(compositePassRef.current.rgba);

    pipeline.render();
  }, 1);

  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function applyParams(node: any, p: SSGIParams): void {
  if (p.sliceCount != null) node.sliceCount.value = p.sliceCount;
  if (p.stepCount != null) node.stepCount.value = p.stepCount;
  if (p.aoIntensity != null) node.aoIntensity.value = p.aoIntensity;
  if (p.giIntensity != null) node.giIntensity.value = p.giIntensity;
  if (p.radius != null) node.radius.value = p.radius;
  if (p.useScreenSpaceSampling != null)
    node.useScreenSpaceSampling.value = p.useScreenSpaceSampling;
  if (p.expFactor != null) node.expFactor.value = p.expFactor;
  if (p.thickness != null) node.thickness.value = p.thickness;
  if (p.useLinearThickness != null)
    node.useLinearThickness.value = p.useLinearThickness;
  if (p.backfaceLighting != null)
    node.backfaceLighting.value = p.backfaceLighting;
  if (p.useTemporalFiltering != null)
    node.useTemporalFiltering = p.useTemporalFiltering;
}
