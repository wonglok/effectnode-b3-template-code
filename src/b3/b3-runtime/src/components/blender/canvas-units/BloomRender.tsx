'use client'

import { useEffect, useRef } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import * as THREE from 'three/webgpu'
import { pass, mrt, output, emissive, vec4 } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { trackPipeline } from '../../../../../../effectnode-intelligence/src/clients/store/useRuntimePerf'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BloomParams {
    /** Bloom intensity (0-5). Default 2.5. */
    strength?: number
    /** Bloom blur radius (0-1). Default 0.5. */
    radius?: number
    /** Luminance high-pass threshold for the bloom source (0-1). Default 0.
     *  Higher values restrict the glow to only the brightest emissive pixels. */
    threshold?: number
}

interface BloomRenderProps {
    params?: BloomParams
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Selective emissive bloom render pipeline.
 *
 * Ported from the official Three.js "webgpu - bloom emissive" example. Renders
 * the scene into two MRT targets — full color (`output`) and a dedicated
 * `emissive` channel — then blurs only the emissive channel and adds the glow
 * back on top of the scene color.
 *
 * The emissive target carries the scene's output alpha and is alpha-composited
 * with `NormalBlending`, so the glow respects each surface's coverage instead
 * of overwriting it at full opacity. Tone mapping and color-space conversion
 * are applied automatically by the renderer at the pipeline output, so the
 * bloom is added in linear HDR (before toning).
 *
 * Requires WebGPU (`three/webgpu`).
 *
 * Usage:
 * ```tsx
 * <CanvasGPU>
 *   <BloomRender params={{ strength: 2.5, radius: 0.5 }} />
 *   <SyncViewer />
 * </CanvasGPU>
 * ```
 */
export function BloomRender({ params }: BloomRenderProps) {
    const gl = useThree((s) => s.gl) as THREE.WebGPURenderer | any
    const scene = useThree((s) => s.scene)
    const camera = useThree((s) => s.camera)

    const pipelineRef = useRef<THREE.RenderPipeline | null>(null)
    const bloomRef = useRef<any>(null)
    const needsSetup = useRef(true)

    // ------------------------------------------------------------------
    // Build bloom pipeline once
    // ------------------------------------------------------------------
    useEffect(() => {
        if (!needsSetup.current) return
        needsSetup.current = false

        const scenePass = pass(scene, camera)

        // MRT: output color + a dedicated emissive channel for selective bloom.
        // Emissive is combined with the scene's output alpha (vec4(emissive,
        // output.a)) and alpha-composited with NormalBlending — matching the
        // official example.
        const mrtNode = mrt({
            output: output,
            emissive: vec4(emissive, output.a),
        })
        mrtNode.setBlendMode('emissive', new THREE.BlendMode(THREE.NormalBlending))
        scenePass.setMRT(mrtNode)

        // Bandwidth optimization: the emissive channel feeds a blur, so it doesn't
        // need fp16 precision — an unsigned byte target is enough.
        const emissiveTexture = scenePass.getTexture('emissive')
        if (emissiveTexture) emissiveTexture.type = THREE.UnsignedByteType

        // Extract the MRT passes
        const outputPass = scenePass.getTextureNode('output')
        const emissivePass = scenePass.getTextureNode('emissive')

        // Bloom from the emissive channel (defaults mirror the example)
        const bloomNode = bloom(
            vec4(emissivePass.rgb.mul(emissivePass.a), emissivePass.a),
            //
            params?.strength ?? 2.5,
            params?.radius ?? 0.5,
            params?.threshold ?? 0.0,
        )
        bloomRef.current = bloomNode

        // Combine: scene color + emissive bloom glow (alpha preserved)
        const postProcessing = new THREE.RenderPipeline(gl)
        postProcessing.outputNode = vec4(outputPass.rgb.add(bloomNode.rgb), outputPass.a)
        pipelineRef.current = postProcessing
        trackPipeline('bloom', postProcessing)
    }, []) // eslint-disable-line react-hooks/exhaustive-deps

    // ------------------------------------------------------------------
    // Apply live param updates each frame
    // ------------------------------------------------------------------
    useFrame(() => {
        const node = bloomRef.current
        if (node && params) {
            if (params.strength != null) node.strength.value = params.strength
            if (params.radius != null) node.radius.value = params.radius
            if (params.threshold != null) node.threshold.value = params.threshold
        }
        pipelineRef.current?.render()
    }, 10)

    return null
}
