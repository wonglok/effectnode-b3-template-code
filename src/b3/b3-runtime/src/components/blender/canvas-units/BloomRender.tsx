"use client";

import { useEffect, useRef } from "react";
import { useThree, useFrame } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import { pass, mrt, output, emissive, vec4, float } from "three/tsl";
import { bloom } from "three/addons/tsl/display/BloomNode.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BloomParams {
  /** Bloom intensity (0-5). Default 2.5. */
  strength?: number;
  /** Bloom blur radius (0-1). Default 0.5. */
  radius?: number;
}

interface BloomRenderProps {
  params?: BloomParams;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BloomRender({ params }: BloomRenderProps) {
  const gl = useThree((s) => s.gl) as THREE.WebGPURenderer | any;
  const scene = useThree((s) => s.scene);
  const camera = useThree((s) => s.camera);

  const pipelineRef = useRef<THREE.RenderPipeline | null>(null);
  const bloomRef = useRef<any>(null);
  const needsSetup = useRef(true);

  // ------------------------------------------------------------------
  // Build bloom pipeline once
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!needsSetup.current) return;
    needsSetup.current = false;

    const scenePass = pass(scene, camera);

    // MRT: output color + emissive (RGB from material, alpha from output)
    const mrtNode = mrt({
      output: output,
      emissive: vec4(emissive, output.a),
    });
    mrtNode.setBlendMode("emissive", new THREE.BlendMode(THREE.NormalBlending));
    scenePass.setMRT(mrtNode);

    // Optimize emissive texture bandwidth
    const emissiveTexture = scenePass.getTexture("emissive");
    emissiveTexture.type = THREE.UnsignedByteType;

    // Extract passes
    const outputPass = scenePass.getTextureNode();
    const emissivePass = scenePass.getTextureNode("emissive");

    // Bloom from the emissive channel
    const bloomNode = bloom(
      emissivePass,
      params?.strength ?? 2.5,
      params?.radius ?? 0.5,
      0.0,
    );
    bloomRef.current = bloomNode;

    // Combine: scene color + bloom glow
    const postProcessing = new THREE.RenderPipeline(gl);
    postProcessing.outputNode = outputPass.add(bloomNode);
    pipelineRef.current = postProcessing;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ------------------------------------------------------------------
  // Apply live param updates each frame
  // ------------------------------------------------------------------
  useFrame(() => {
    if (bloomRef.current && params) {
      if (params.strength != null)
        bloomRef.current.strength.value = params.strength;
      if (params.radius != null) bloomRef.current.radius.value = params.radius;
    }
    pipelineRef.current?.render();
  }, 1);

  return null;
}
