// ---------------------------------------------------------------------------
// Grass — a TSL port of three's `grass-shader` example
// ---------------------------------------------------------------------------
// Reference: https://github.com/pmndrs/examples/tree/main/examples/grass-shader
// (MIT, Poimandres). The shader half lives in ./grassTSLMaterial; this file is
// the other half — the CPU-side per-instance data, the geometry, and the ground.
//
// One blade is a 1×`joints`-segment PlaneGeometry, drawn `instances` times as an
// InstancedBufferGeometry. Everything that makes a blade look like a blade —
// where it stands, which way it leans, how tall it is, which way it was already
// growing — is a per-instance attribute the vertex shader consumes. Nothing is
// animated on the CPU: the wind is a noise field sampled in the shader.
// ---------------------------------------------------------------------------

import { useEffect, useMemo } from 'react'
import {
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    Mesh,
    NoColorSpace,
    PlaneGeometry,
    Quaternion,
    SRGBColorSpace,
    Sphere,
    TextureLoader,
    Vector3,
} from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Texture } from 'three'
import { createGrassMaterial } from './grassTSLMaterial'

// ---------------------------------------------------------------------------
// Blade textures
// ---------------------------------------------------------------------------
// Module-level, like LoadCollider's maps: loaded once for the app's lifetime and
// deliberately never disposed, so a viewer remount does not take the grass with
// it. `loader.load(url, onLoad)` is used rather than useLoader because
// ProductionScene has a `noSuspense` path — a suspending child would throw there.

const loader = new TextureLoader()

/** Blade albedo — a colour map, so it decodes from sRGB. */
const bladeDiffuse: Texture = loader.load('/texture/grass/blade_diffuse.jpg', (d) => {
    d.colorSpace = SRGBColorSpace
    d.needsUpdate = true
})

/**
 * Blade silhouette, sampled on `.r`.
 *
 * Explicitly `NoColorSpace`: this is coverage data, not colour. Left as sRGB the
 * sampler would gamma-decode it and shift every edge in the `alphaTest` cutout.
 */
const bladeAlpha: Texture = loader.load('/texture/grass/blade_alpha.jpg', (d) => {
    d.colorSpace = NoColorSpace
    d.needsUpdate = true
})

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------
// The reference calls the `simplex-noise` package, which is not a dependency of
// this project. This is a deterministic value-noise fBm instead, reusing the
// reference's three octaves, wavelengths and amplitudes so the terrain has the
// same scale and character. It is *not* the same function — simplex has no
// axis-aligned lattice and a different amplitude distribution — so the hills
// will not match the example exactly, only in relief.
//
// The same function positions the blades and displaces the ground, which is what
// keeps the blades sitting on the surface rather than hovering or sinking.

/** 32-bit lattice hash → [-1, 1]. */
function hashLattice(ix: number, iy: number, seed: number): number {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    h ^= h >>> 16
    return ((h >>> 0) / 0xffffffff) * 2 - 1
}

/** Value noise, smoothstep-interpolated across the lattice. */
function valueNoise2D(x: number, y: number, seed: number): number {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy

    // Smoothstep the interpolants: a plain linear blend shows the lattice as
    // diamond creases across a hillside this size.
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)

    const n00 = hashLattice(ix, iy, seed)
    const n10 = hashLattice(ix + 1, iy, seed)
    const n01 = hashLattice(ix, iy + 1, seed)
    const n11 = hashLattice(ix + 1, iy + 1, seed)

    return (n00 + (n10 - n00) * sx) * (1 - sy) + (n01 + (n11 - n01) * sx) * sy
}

/**
 * Ground height at a world position.
 *
 * `amplitude` scales the whole relief, and 0 flattens it — that is the switch
 * for laying this grass over ground the scene already provides.
 */
function terrainHeight(x: number, z: number, amplitude: number): number {
    if (amplitude === 0) return 0

    let y = 2 * valueNoise2D(x / 50, z / 50, 1)
    y += 4 * valueNoise2D(x / 100, z / 100, 2)
    y += 0.2 * valueNoise2D(x / 10, z / 10, 3)

    return y * amplitude
}

// ---------------------------------------------------------------------------
// Per-instance attributes
// ---------------------------------------------------------------------------

interface GrassAttributes {
    offsets: Float32Array
    orientations: Float32Array
    stretches: Float32Array
    halfRootAngleSin: Float32Array
    halfRootAngleCos: Float32Array
}

const AXIS_X = new Vector3(1, 0, 0)
const AXIS_Y = new Vector3(0, 1, 0)
const AXIS_Z = new Vector3(0, 0, 1)

/** Growth-direction tilt range, in radians — the reference's min/max. */
const TILT_RANGE = 0.25

/**
 * Generate the per-blade data the vertex shader consumes.
 *
 * A faithful port of the reference's `getAttributeData`, with one substitution:
 * it builds its quaternions by hand out of Vector4s (its `multiplyQuaternions`
 * is the Hamilton product q1·q2, in that order), which THREE.Quaternion.multiply
 * computes identically. That removes the arithmetic without changing a rotation.
 */
function buildGrassAttributes(instances: number, width: number, terrainAmplitude: number): GrassAttributes {
    const offsets = new Float32Array(instances * 3)
    const orientations = new Float32Array(instances * 4)
    const stretches = new Float32Array(instances)
    const halfRootAngleSin = new Float32Array(instances)
    const halfRootAngleCos = new Float32Array(instances)

    // Two scratch quaternions, reused across every blade. Allocating a pair per
    // instance is 60k objects at a typical instance count.
    const heading = new Quaternion()
    const tilt = new Quaternion()

    for (let i = 0; i < instances; i++) {
        const x = Math.random() * width - width / 2
        const z = Math.random() * width - width / 2

        offsets[i * 3] = x
        offsets[i * 3 + 1] = terrainHeight(x, z, terrainAmplitude)
        offsets[i * 3 + 2] = z

        // The blade's root heading, as a rotation about Y.
        const rootAngle = Math.PI - Math.random() * (Math.PI * 2)

        // Stored as a half-angle sin/cos pair rather than the angle itself — this
        // is the form the shader's slerp needs as its "unbent" endpoint.
        halfRootAngleSin[i] = Math.sin(0.5 * rootAngle)
        halfRootAngleCos[i] = Math.cos(0.5 * rootAngle)

        // Root heading, then a tilt about X, then one about Z. Composed in this
        // order to match the reference.
        heading.setFromAxisAngle(AXIS_Y, rootAngle)
        heading.multiply(tilt.setFromAxisAngle(AXIS_X, (Math.random() * 2 - 1) * TILT_RANGE))
        heading.multiply(tilt.setFromAxisAngle(AXIS_Z, (Math.random() * 2 - 1) * TILT_RANGE))

        orientations[i * 4] = heading.x
        orientations[i * 4 + 1] = heading.y
        orientations[i * 4 + 2] = heading.z
        orientations[i * 4 + 3] = heading.w

        // A third of the blades are extra tall. The reference's split, kept as-is:
        // the taller minority is what breaks the canopy up.
        stretches[i] = i < instances / 3 ? Math.random() * 1.8 : Math.random()
    }

    return { offsets, orientations, stretches, halfRootAngleSin, halfRootAngleCos }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface GrassComponentProps {
    /** Number of blades. The reference uses 50000 over a 100-unit field. */
    instances?: number
    /** Edge length of the square field, in world units. */
    width?: number
    bladeWidth?: number
    bladeHeight?: number
    /** Vertical segments per blade — how smoothly a blade can bend. */
    joints?: number
    /** Relief multiplier for the terrain. 0 flattens it (see `showGround`). */
    terrainAmplitude?: number
    /** Draw the displaced ground plane under the grass. */
    showGround?: boolean
    /** sRGB hex, applied at the blade tip. */
    tipColor?: string
    /** sRGB hex, applied at the blade root. */
    bottomColor?: string
    groundColor?: string
    /** Gust travel speed. Higher is faster. */
    windSpeed?: number
    /** Peak gust bend, in radians. */
    windStrength?: number
    position?: [number, number, number]
}

// Module-level so their identity is stable — inline defaults are a new object
// (or a new array for `position`) every render and would rebuild the field.
const DEFAULT_POSITION: [number, number, number] = [0, 0, 0]

export function GrassComponent({
    instances = 30000,
    width = 60,
    bladeWidth = 0.12,
    bladeHeight = 1,
    joints = 5,
    terrainAmplitude = 1,
    showGround = true,
    // sRGB equivalents of the reference's (0, 0.6, 0) / (0, 0.1, 0).
    tipColor = '#009900',
    bottomColor = '#001a00',
    groundColor = '#000f00',
    windSpeed = 0.25,
    windStrength = 0.15,
    position = DEFAULT_POSITION,
}: GrassComponentProps) {
    const built = useMemo(() => {
        // --- Blade template ---
        // One blade: a single column of `joints` quads, anchored at its root so
        // the shader's per-vertex rotation pivots about the base.
        const bladeTemplate = new PlaneGeometry(bladeWidth, bladeHeight, 1, joints)
        bladeTemplate.translate(0, bladeHeight / 2, 0)

        // --- Instanced geometry ---
        const grassGeometry = new InstancedBufferGeometry()

        // The blade's shape is shared by every instance; only the per-instance
        // attributes below differ. These three attributes are borrowed from the
        // template (as the reference does), so the template must not be disposed
        // independently — its buffers are this geometry's buffers.
        grassGeometry.index = bladeTemplate.index
        grassGeometry.setAttribute('position', bladeTemplate.attributes.position)
        grassGeometry.setAttribute('uv', bladeTemplate.attributes.uv)

        const attributes = buildGrassAttributes(instances, width, terrainAmplitude)

        grassGeometry.setAttribute('offset', new InstancedBufferAttribute(attributes.offsets, 3))
        grassGeometry.setAttribute('orientation', new InstancedBufferAttribute(attributes.orientations, 4))
        grassGeometry.setAttribute('stretch', new InstancedBufferAttribute(attributes.stretches, 1))
        grassGeometry.setAttribute('halfRootAngleSin', new InstancedBufferAttribute(attributes.halfRootAngleSin, 1))
        grassGeometry.setAttribute('halfRootAngleCos', new InstancedBufferAttribute(attributes.halfRootAngleCos, 1))

        // Required, and not optional. InstancedBufferGeometry defaults this to
        // Infinity, and three's WebGPU path reads it *directly* as the draw's
        // instanceCount (RenderObject.getDrawParameters) — an instanced draw of
        // Infinity is a validation error, not a full draw.
        grassGeometry.instanceCount = instances

        // The geometry's own bounds cover a single blade at the origin, so three
        // would cull the entire field the moment the origin left the frustum.
        // One sphere over the whole field is cheap and correct; the reference
        // sets the same one.
        grassGeometry.boundingSphere = new Sphere(new Vector3(), (Math.SQRT2 * width) / 2)

        const { material } = createGrassMaterial({
            map: bladeDiffuse,
            alphaMap: bladeAlpha,
            bladeHeight,
            tipColor,
            bottomColor,
            windSpeed,
            windStrength,
        })

        const grassMesh = new Mesh(grassGeometry, material)
        grassMesh.name = 'grass'
        // The reference leaves shadows off the field too: casting from 300k
        // vertices would double this geometry's vertex cost for a shadow that a
        // 1-unit blade barely resolves.
        grassMesh.castShadow = false
        grassMesh.receiveShadow = false

        // --- Ground ---
        let groundMesh: Mesh | null = null
        let groundMaterial: MeshStandardNodeMaterial | null = null

        if (showGround) {
            const groundGeometry = new PlaneGeometry(width, width, 32, 32)
            // Lay the plane flat. The reference orients it with
            // `geometry.lookAt(0,1,0)`; a -90° rotation about X is the same
            // result stated directly.
            groundGeometry.rotateX(-Math.PI / 2)

            const groundPositions = groundGeometry.attributes.position
            for (let i = 0; i < groundPositions.count; i++) {
                groundPositions.setY(
                    i,
                    terrainHeight(groundPositions.getX(i), groundPositions.getZ(i), terrainAmplitude),
                )
            }
            groundPositions.needsUpdate = true
            // Normals must be recomputed *after* the displacement, or the lit
            // ground shades as if it were still flat.
            groundGeometry.computeVertexNormals()

            groundMaterial = new MeshStandardNodeMaterial()
            groundMaterial.color.set(groundColor)

            groundMesh = new Mesh(groundGeometry, groundMaterial)
            groundMesh.name = 'grass-ground'
            groundMesh.receiveShadow = true
        }

        return { grassMesh, material, groundMesh, groundMaterial }
    }, [
        instances,
        width,
        bladeWidth,
        bladeHeight,
        joints,
        terrainAmplitude,
        showGround,
        tipColor,
        bottomColor,
        groundColor,
        windSpeed,
        windStrength,
    ])

    useEffect(() => {
        return () => {
            // The blade template is intentionally absent here: its index and
            // position/uv buffers are shared with grassGeometry above, so
            // disposing it would free buffers still in use.
            built.grassMesh.geometry.dispose()
            built.material.dispose()
            built.groundMesh?.geometry.dispose()
            built.groundMaterial?.dispose()
            // bladeDiffuse / bladeAlpha are module-level and shared across
            // remounts, so they are deliberately left alone.
        }
    }, [built])

    return (
        <group position={position}>
            <primitive object={built.grassMesh} />
            {built.groundMesh ? <primitive object={built.groundMesh} /> : null}
        </group>
    )
}
