import { useEffect, useMemo } from 'react'
import {
    DataTexture,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    NoColorSpace,
    PlaneGeometry,
    RepeatWrapping,
    Vector2,
} from 'three'
import { WaterMesh } from 'three/examples/jsm/objects/Water2Mesh.js'
import type { BlenderObject } from '../types/blenderTypes'
import { useFrame, useThree } from '@react-three/fiber'

// ---------------------------------------------------------------------------
// Water surface for the synced Blender scene.
//
// WaterMesh (the WebGPU/node-material sibling of the classic Water2) blends a
// screen-space refraction with a planar reflection, distorting both by two
// normal maps that scroll past each other. Both maps are mandatory — it calls
// texture() on them at construction — so instead of shipping image assets we
// synthesise two seamless, tileable normal maps here as DataTextures.
// ---------------------------------------------------------------------------

type Wave = { fx: number; fy: number; amp: number; phase: number }

/**
 * Bake the normal map of a sum-of-sinusoids height field. Derivatives are
 * analytic, so the result is exactly the normal of the ripple surface and the
 * whole texture tiles seamlessly (every wave completes a whole number of
 * periods across the 0..1 UV range).
 */
function rippleNormalTexture(size: number, waves: Wave[], strength = 0.06): DataTexture {
    const data = new Uint8Array(size * size * 4)

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const u = x / size
            const v = y / size

            // dHeight/du and dHeight/dv of  Σ amp·sin(2π(fx·u + fy·v) + phase)
            let dhdu = 0
            let dhdv = 0
            for (const w of waves) {
                const slope = w.amp * Math.PI * 2 * Math.cos(Math.PI * 2 * (w.fx * u + w.fy * v) + w.phase)
                dhdu += slope * w.fx
                dhdv += slope * w.fy
            }

            // Standard tangent-space normal: R = x, G = y(up), B = z(out).
            const nx = -dhdu * strength
            const ny = -dhdv * strength
            const len = Math.hypot(nx, ny, 1)

            const i = (y * size + x) * 4
            data[i] = ((nx / len) * 0.5 + 0.5) * 255
            data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255
            data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255
            data[i + 3] = 255
        }
    }

    const tex = new DataTexture(data, size, size)
    tex.wrapS = tex.wrapT = RepeatWrapping
    tex.magFilter = LinearFilter
    // DataTexture defaults generateMipmaps to false — without this the
    // mipmapped min filter below samples levels that were never built and the
    // water goes black at distance.
    tex.generateMipmaps = true
    tex.minFilter = LinearMipmapLinearFilter
    // Raw normal components — no sRGB decode wanted.
    tex.colorSpace = NoColorSpace
    tex.needsUpdate = true
    return tex
}

// Two decorrelated ripples so the cross-fade between them reads as motion
// rather than as a texture swap. Integer frequencies keep both maps tileable.
const WAVES_A: Wave[] = [
    { fx: 3, fy: 1, amp: 0.9, phase: 0.0 },
    { fx: -2, fy: 4, amp: 0.7, phase: 1.7 },
    { fx: 5, fy: -3, amp: 0.5, phase: 3.1 },
    { fx: 8, fy: 6, amp: 0.3, phase: 4.6 },
    { fx: 1, fy: 9, amp: 0.22, phase: 2.4 },
]

const WAVES_B: Wave[] = [
    { fx: 2, fy: -3, amp: 0.85, phase: 5.2 },
    { fx: -4, fy: 3, amp: 0.65, phase: 0.9 },
    { fx: 6, fy: 2, amp: 0.45, phase: 2.8 },
    { fx: -7, fy: -5, amp: 0.3, phase: 1.1 },
    { fx: 9, fy: -1, amp: 0.2, phase: 3.9 },
]

/** Module-level so its identity is stable — an inline default array would be a
 *  new object every render and rebuild the whole water mesh with it. */
const DEFAULT_FLOW_DIRECTION: [number, number] = [1, 0.35]

export function SceneWaterObject({
    objects = [],
    /** Extent of the water quad in world units (square). */
    size = 60,
    /** Height above the collider floor — a hair up avoids z-fighting. */
    height = 0.01,
    color = '#a2cddf',
    /** Base flow direction when no flow map is supplied. */
    flowDirection = DEFAULT_FLOW_DIRECTION,
    flowSpeed = 0.035,
    reflectivity = 0.06,
    /** UV tiling of the normal maps across the plane. */
    scale = 0.1,
    name = 'water',
}: {
    objects?: BlenderObject[]
    size?: number
    height?: number
    color?: string
    flowDirection?: [number, number]
    flowSpeed?: number
    reflectivity?: number
    scale?: number
    name: string
}) {
    const scene = useThree((r) => r.scene)

    const waterMesh = useMemo(() => {
        return scene.getObjectByName(name) as Mesh | null
    }, [scene, name, objects])

    const { geometry, water, textures, out } = useMemo(() => {
        // Nothing displaces the surface — the ripple is entirely in the normal
        // map — so a single quad is enough.
        const geometry = waterMesh?.geometry || new PlaneGeometry(0.000001, 0.000001, 1, 1)
        // geometry.rotateX(-Math.PI / 2)

        const normalMap0 = rippleNormalTexture(256, WAVES_A)
        const normalMap1 = rippleNormalTexture(256, WAVES_B)

        const water = new WaterMesh(geometry, {
            color,
            normalMap0,
            normalMap1,
            flowDirection: new Vector2(flowDirection[0], flowDirection[1]).normalize(),
            flowSpeed,
            reflectivity,
            scale,
        })
        water.name = 'scene-water'
        // water.position.y = height

        if (waterMesh) {
            waterMesh.visible = false
        }


        return { geometry, water, textures: [normalMap0, normalMap1], out: <primitive object={water}></primitive> }
    }, [
        size,
        height,
        color,
        flowDirection[0],
        flowDirection[1],
        flowSpeed,
        reflectivity,
        scale,
        waterMesh?.uuid,
        JSON.stringify(objects),
    ])

    useFrame(() => {
        waterMesh?.getWorldPosition(water.position)
        waterMesh?.getWorldScale(water.scale)
        waterMesh?.getWorldQuaternion(water.quaternion)
    })

    useEffect(() => {
        return () => {
            geometry.dispose()
            water.material.dispose()
            textures.forEach((t) => t.dispose())
        }
    }, [geometry, water, textures])

    return <>{out}</>
}
