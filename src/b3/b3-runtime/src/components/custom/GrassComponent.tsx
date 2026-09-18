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
//
// Blades are placed by sampling the *collider* mesh's surface, so the field
// follows the real terrain instead of an invented height field — and each blade
// is aligned to the sampled surface normal, so it grows out of a slope rather
// than standing plumb with the world and sinking into it.
//
// Where they land is then shaped by a world-space Perlin density field: the blade
// count is fixed and the noise decides how tightly they bunch, so the field reads
// as patches with thin ground between them instead of an even lawn. See
// `grassDensity`.
//
// Every blade is drawn, every frame: all `instances` are inside
// `geometry.instanceCount` and the field is bounded by the measured
// `boundingSphere` so three only frustum-culls the whole thing when it is
// genuinely off-screen.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import {
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    Matrix3,
    Mesh,
    NoColorSpace,
    PlaneGeometry,
    Quaternion,
    SRGBColorSpace,
    Sphere,
    TextureLoader,
    Vector3,
} from 'three'
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js'
import { MeshStandardNodeMaterial, Node } from 'three/webgpu'
import type { Texture } from 'three'
import { useThree } from '@react-three/fiber'
import type { BlenderObject } from '../types/blenderTypes'
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
// Terrain fallback
// ---------------------------------------------------------------------------
// Used only when no collider mesh exists yet (or `placement` is forced to
// 'terrain'). The reference calls the `simplex-noise` package, which is not a
// dependency here, so this is a deterministic value-noise fBm reusing the
// reference's three octaves, wavelengths and amplitudes. It is *not* the same
// function as simplex — only the same relief and character.

/**
 * 32-bit lattice hash, unsigned.
 *
 * The shared core of both noises below. They want different things out of it —
 * value noise a uniform float, Perlin a gradient index — but they mix the
 * lattice identically, and each caller passes its own seed, so the two fields
 * come out unrelated without either one knowing about the other.
 */
function hashBits(ix: number, iy: number, seed: number): number {
    let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1274126177)
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    h ^= h >>> 16
    return h >>> 0
}

/** Value-noise lattice sample → [-1, 1]. */
function hashLattice(ix: number, iy: number, seed: number): number {
    return (hashBits(ix, iy, seed) / 0xffffffff) * 2 - 1
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

/** Ground height at a world position. `amplitude` 0 flattens it. */
function terrainHeight(x: number, z: number, amplitude: number): number {
    if (amplitude === 0) return 0

    let y = 2 * valueNoise2D(x / 50, z / 50, 1)
    y += 4 * valueNoise2D(x / 100, z / 100, 2)
    y += 0.2 * valueNoise2D(x / 10, z / 10, 3)

    return y * amplitude
}

// ---------------------------------------------------------------------------
// Blade clumping
// ---------------------------------------------------------------------------
// Terrain height is *value* noise above; this is gradient (Perlin) noise, and the
// distinction is the point at this scale. Value noise interpolates the lattice,
// so its extremes sit on the lattice points themselves and its cells can read as
// a faint grid. Perlin is zero at every lattice point and peaks between them, so
// it has no preferred axes — patches scatter instead of striping.
//
// The field is anchored in **world** XZ, not in the field's own frame, so a patch
// is a fixed size in metres wherever the collider happens to sit and the pattern
// survives a collider re-sync unchanged.

/**
 * The eight gradient directions, unit length.
 *
 * Perlin's lattice dot product, tabulated: indexing this by the hash's low three
 * bits is what keeps `perlin2D` allocation-free. The diagonals are normalised to
 * `1/√2` rather than left as ±1 so every direction contributes equally — the
 * unnormalised `(±1, ±1)` corners are longer, and that bias is visible as a
 * preference for diagonal features.
 */
const SQRT1_2 = Math.SQRT1_2
const PERLIN_GRADIENTS = new Float32Array([
    1,
    0,
    -1,
    0,
    0,
    1,
    0,
    -1,
    SQRT1_2,
    SQRT1_2,
    -SQRT1_2,
    SQRT1_2,
    SQRT1_2,
    -SQRT1_2,
    -SQRT1_2,
    -SQRT1_2,
])

/** Perlin's fade `6t⁵ - 15t⁴ + 10t³` — zero first *and* second derivative at 0 and 1. */
function fade(t: number): number {
    return t * t * t * (t * (t * 6 - 15) + 10)
}

/** The GLSL three-argument smoothstep, clamped to `0..1` outside the edges. */
function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
}

/** The gradient at lattice point (ix, iy), dotted with the offset (dx, dy) from it. */
function gradientDot(ix: number, iy: number, dx: number, dy: number, seed: number): number {
    const g = (hashBits(ix, iy, seed) & 7) * 2
    return PERLIN_GRADIENTS[g] * dx + PERLIN_GRADIENTS[g + 1] * dy
}

/**
 * 2D Perlin noise → roughly [-0.707, 0.707].
 *
 * The bound is `√2/2`, not 1: each corner gradient contributes at most its own
 * length across the half-cell it owns. `grassDensity` uses that bound rather than
 * guessing at one.
 */
function perlin2D(x: number, y: number, seed: number): number {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const dx = x - ix
    const dy = y - iy

    const ux = fade(dx)
    const uy = fade(dy)

    const n00 = gradientDot(ix, iy, dx, dy, seed)
    const n10 = gradientDot(ix + 1, iy, dx - 1, dy, seed)
    const n01 = gradientDot(ix, iy + 1, dx, dy - 1, seed)
    const n11 = gradientDot(ix + 1, iy + 1, dx - 1, dy - 1, seed)

    const top = n00 + (n10 - n00) * ux
    const bottom = n01 + (n11 - n01) * ux

    return top + (bottom - top) * uy
}

/**
 * Octaves in the fBm.
 *
 * Three is where the field stops being a set of blobs and starts reading as
 * ground: the second octave breaks up the patch outlines, the third roughs their
 * edges. A fourth adds detail at 1/16 of `clumpScale` — under a metre at the
 * default — which the blades themselves are already finer than.
 */
const CLUMP_OCTAVES = 3

/** Deliberately unrelated to the terrain seeds (1, 2, 3) — see `hashBits`. */
const CLUMP_SEED = 101

/**
 * A patch is thinned to this, never emptied.
 *
 * Load-bearing: the placement loops *reject* candidates until one passes, so a
 * region of genuine zero would spin until its attempt budget ran out. Measured
 * over a 300x300 unit field, this floor is reached by about a tenth of the ground
 * and puts 17% of the area under a quarter of the mean density — patchy, but with
 * ground cover still standing in the thin parts rather than bare earth.
 */
const MIN_BLADE_DENSITY = 0.05

/**
 * How many candidates a single blade may burn before the last one is taken
 * regardless.
 *
 * At `MIN_BLADE_DENSITY` this is reached by ~4% of the blades in the barest
 * patches; those land uniformly instead of clumped, which softens the very
 * barest ground rather than ever hanging the sampler.
 */
const MAX_SAMPLE_ATTEMPTS = 64

/**
 * Half-width of the ramp that turns the fBm into a density, measured on the
 * normalised field: below `0.5 - this` is bare ground, above `0.5 + this` is full
 * density.
 *
 * This is the knob that makes the difference between a mottle and actual patches,
 * and its size is not arbitrary. Normalising the fBm against Perlin's
 * *theoretical* bound is not enough on its own, because that bound assumes every
 * octave aligns adversarially — which a sum with halving amplitudes never does.
 * Measured over 300x300 units this field spans only about 0.26 to 0.74, so a ramp
 * drawn across the whole range would barely bite. Drawing it inside the span, at
 * 0.35 to 0.65, puts roughly a tenth of the ground at genuinely bare and a tenth
 * at full density, with the rest graded between.
 */
const CLUMP_CONTRAST = 0.15

/**
 * Blade density at a world XZ position, in `0..1` — the clumping field.
 *
 * Octave 0 is centred on `clumpScale` and each octave doubles the frequency, so
 * the octaves land at 1/2, 1/4, ... of it. Their amplitudes halve at the same
 * rate, which keeps the detail a modulation *of* the patches rather than a field
 * competing with them.
 */
function grassDensity(x: number, z: number, clumpScale: number, clumpStrength: number): number {
    let sum = 0
    let total = 0
    let frequency = 1 / clumpScale
    let amplitude = 1

    for (let octave = 0; octave < CLUMP_OCTAVES; octave++) {
        sum += amplitude * perlin2D(x * frequency, z * frequency, CLUMP_SEED + octave)
        total += amplitude
        frequency *= 2
        amplitude *= 0.5
    }

    // `sum / total` is a weighted mean of values each bounded by 0.707, so it is
    // bounded by 0.707 too — the SQRT1_2 maps that onto [-1, 1] exactly, it is not
    // a fudge factor. It is a loose bound in practice, which is what the ramp
    // above is for.
    const normalized = (sum / total) * SQRT1_2 + 0.5
    const contrast = smoothstep(0.5 - CLUMP_CONTRAST, 0.5 + CLUMP_CONTRAST, normalized)

    // Blended from "accept everything" to the field, rather than from the floor
    // upwards. Both spellings agree at full strength, but this one makes the knob
    // honest at the other end: `clumpStrength: 0` is a density of exactly 1, so
    // the neutral setting rejects nothing instead of burning ~20 attempts a blade
    // to arrive at the same uniform scatter.
    return 1 - clumpStrength * (1 - MIN_BLADE_DENSITY) * (1 - contrast)
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/**
 * Where the blades stand and which way the surface under them faces — the only
 * two things the sampler has to produce; the rest is per-blade randomness.
 *
 * Both arrays are world space, and unit for the ups.
 */
interface BladePlacement {
    /** World-space blade roots, xyz per instance. Becomes the `offset` attribute. */
    positions: Float32Array
    /** World-space unit surface normals, xyz per instance. */
    ups: Float32Array
}

const WORLD_UP = new Vector3(0, 1, 0)
const AXIS_X = new Vector3(1, 0, 0)
const AXIS_Z = new Vector3(0, 0, 1)

/** Growth-direction tilt range, in radians — the reference's min/max. */
const TILT_RANGE = 0.25

/**
 * Sample `instances` points off the collider mesh's surface.
 *
 * Returns null when the mesh cannot be sampled (no geometry, no normals, or an
 * InstancedMesh), so the caller can fall back rather than place every blade at
 * the origin.
 *
 * `MeshSurfaceSampler` works in the mesh's **local** space — it reads the
 * geometry attributes directly and never touches `matrixWorld` — so both the
 * point and the normal are transformed out here.
 */
function sampleColliderPlacement(
    collider: Mesh,
    instances: number,
    clumpScale: number,
    clumpStrength: number,
): BladePlacement | null {
    const geometry = collider.geometry

    // Without a normal attribute `sample()` silently leaves the target normal
    // untouched, which would align every blade to whatever the last one got.
    if (!geometry?.attributes?.position || !geometry.attributes.normal) return null

    // An InstancedMesh would need each instance's matrix applied, and sampling
    // the shared geometry would stamp the same shape over the whole field. The
    // collider is a plain Mesh (useMeshSync only batches *identical* geometry,
    // and terrain is unique), so treat anything else as unsupported.
    if ((collider as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) return null

    const sampler = new MeshSurfaceSampler(collider).build()

    // The mesh may have been created this frame, so its world matrix is not
    // guaranteed to be current yet.
    collider.updateWorldMatrix(true, false)

    const positions = new Float32Array(instances * 3)
    const ups = new Float32Array(instances * 3)

    const point = new Vector3()
    const normal = new Vector3()

    // Hoisted: `getNormalMatrix` inverts a 3x3, and the collider's world matrix is
    // fixed for the whole sample (`updateWorldMatrix` ran above). It used to be
    // recomputed per blade; with rejection sampling below there are now more draws
    // than blades, so it is worth computing once.
    const normalMatrix = new Matrix3().getNormalMatrix(collider.matrixWorld)

    for (let i = 0; i < instances; i++) {
        // Rejection sampling — see `grassDensity`. The blade *count* is what stays
        // constant; the noise decides how densely they land, so the field thins to
        // near-bare ground in some places and bunches in others without a single
        // change to what is drawn.
        //
        // Drawn and transformed before the test because the test reads the world
        // position, and taken as-is once the budget runs out rather than looping.
        let attempts = 0
        for (;;) {
            sampler.sample(point, normal)

            point.applyMatrix4(collider.matrixWorld)
            normal.applyNormalMatrix(normalMatrix)

            attempts++
            if (attempts >= MAX_SAMPLE_ATTEMPTS) break
            if (Math.random() < grassDensity(point.x, point.z, clumpScale, clumpStrength)) break
        }

        // Exported meshes routinely carry inverted winding, which would grow
        // every blade out of the *underside* of the terrain. Trust the side the
        // surface faces rather than the winding: anything pointing below the
        // horizon is flipped back up.
        //
        // After the accept test rather than inside it: the test only reads the
        // position, so flipping and normalising a candidate that is about to be
        // thrown away is pure waste.
        if (normal.y < 0) normal.negate()
        normal.normalize()

        positions[i * 3] = point.x
        positions[i * 3 + 1] = point.y
        positions[i * 3 + 2] = point.z

        ups[i * 3] = normal.x
        ups[i * 3 + 1] = normal.y
        ups[i * 3 + 2] = normal.z
    }

    return { positions, ups }
}

/** Scatter blades over the fBm height field, all standing plumb. */
function sampleTerrainPlacement(
    instances: number,
    width: number,
    terrainAmplitude: number,
    clumpScale: number,
    clumpStrength: number,
): BladePlacement {
    const positions = new Float32Array(instances * 3)
    const ups = new Float32Array(instances * 3)

    for (let i = 0; i < instances; i++) {
        // Rejection sampling as in `sampleColliderPlacement`, with a fresh square
        // draw instead of a fresh surface sample. The draw comes first so that a
        // blade always has a position to fall back on: if the attempt budget is
        // already spent, that first draw is the one that is kept.
        let x = 0
        let z = 0
        let attempts = 0

        for (;;) {
            x = Math.random() * width - width / 2
            z = Math.random() * width - width / 2

            attempts++
            if (attempts >= MAX_SAMPLE_ATTEMPTS) break
            if (Math.random() < grassDensity(x, z, clumpScale, clumpStrength)) break
        }

        positions[i * 3] = x
        positions[i * 3 + 1] = terrainHeight(x, z, terrainAmplitude)
        positions[i * 3 + 2] = z

        ups[i * 3] = 0
        ups[i * 3 + 1] = 1
        ups[i * 3 + 2] = 0
    }

    return { positions, ups }
}

/**
 * Bounding sphere covering every blade root, padded for the blades themselves.
 *
 * It has to be measured from the samples rather than assumed from `width`: with
 * collider placement the field spans the collider, which bears no relation to the
 * configured width, and three culls against this sphere — a too-small one makes
 * the entire field vanish as soon as the camera leaves a small box around the
 * origin.
 */
function computeFieldBounds(offsets: Float32Array, bladeHeight: number): Sphere {
    const count = offsets.length / 3
    if (count === 0) return new Sphere(new Vector3(), bladeHeight)

    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity

    for (let i = 0; i < count; i++) {
        const x = offsets[i * 3]
        const y = offsets[i * 3 + 1]
        const z = offsets[i * 3 + 2]

        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (z < minZ) minZ = z
        if (z > maxZ) maxZ = z
    }

    const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2)

    // Half-diagonal of the root cloud, plus room for the blades above it: the
    // tall minority reach ~1.9x their height, and the gust leans them further.
    const radius = center.distanceTo(new Vector3(maxX, maxY, maxZ)) + bladeHeight * 2.5

    return new Sphere(center, radius)
}

// ---------------------------------------------------------------------------
// Per-instance attributes
// ---------------------------------------------------------------------------

interface GrassAttributes {
    offsets: Float32Array
    rootDirection: Float32Array
    orientations: Float32Array
    stretches: Float32Array
}

/**
 * Turn a placement into the per-blade attributes the vertex shader consumes.
 *
 * The quaternion composition follows the reference's `getAttributeData` — root
 * heading, then a tilt about X, then one about Z — with one addition: the whole
 * blade frame is first rotated so its local +Y points along the sampled surface
 * normal. That is what makes grass grow out of a slope rather than through it.
 *
 * The reference builds its quaternions by hand out of Vector4s (its
 * `multiplyQuaternions` is the Hamilton product q1·q2, in that order), which
 * THREE.Quaternion computes identically.
 */
function buildGrassAttributes(placement: BladePlacement): GrassAttributes {
    // Reused as the `offset` attribute directly — it is already xyz-per-instance.
    const offsets = placement.positions
    const instances = offsets.length / 3

    const rootDirection = new Float32Array(instances * 4)
    const orientations = new Float32Array(instances * 4)
    const stretches = new Float32Array(instances)

    // Scratch, reused across every blade. Allocating per instance is 100k+
    // objects at a typical instance count.
    const align = new Quaternion()
    const heading = new Quaternion()
    const unbent = new Quaternion()
    const tilt = new Quaternion()
    const up = new Vector3()

    for (let i = 0; i < instances; i++) {
        up.set(placement.ups[i * 3], placement.ups[i * 3 + 1], placement.ups[i * 3 + 2])

        // Rotates the blade's local +Y onto the surface normal. Identity when the
        // surface is flat, which is the reference's case.
        align.setFromUnitVectors(WORLD_UP, up)

        // The blade's root heading — a yaw *about its own axis*, i.e. about the
        // surface normal once `align` has been applied.
        const rootAngle = Math.PI - Math.random() * (Math.PI * 2)

        // Heading only: the endpoint `slerp` starts from. Pre-multiplying by
        // `align` puts it in world space (quaternions compose right-to-left
        // against a vector, so this is "align first, then yaw in its frame").
        unbent.setFromAxisAngle(WORLD_UP, rootAngle).premultiply(align)
        rootDirection[i * 4] = unbent.x
        rootDirection[i * 4 + 1] = unbent.y
        rootDirection[i * 4 + 2] = unbent.z
        rootDirection[i * 4 + 3] = unbent.w

        // The same frame with the growth tilts on top — where the tip ends up.
        heading.setFromAxisAngle(WORLD_UP, rootAngle).premultiply(align)
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

    return { offsets, rootDirection, orientations, stretches }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface GrassComponentProps {
    /** Blender objects, used only to notice when the collider is re-synced. */
    objects?: BlenderObject[]
    /**
     * Number of blades.
     *
     * 120k over the default 60-unit field is ~33 blades per unit². The reference
     * uses 50000 over 100 units (5 per unit²), so this is a finer, denser lawn
     * rather than the reference's taller meadow.
     */
    instances?: number
    /** Where to put the blades. 'collider' falls back to 'terrain' if absent. */
    placement?: 'collider' | 'terrain'
    /** Edge length of the square field — terrain placement and the ground only. */
    width?: number
    bladeWidth?: number
    bladeHeight?: number
    /** Vertical segments per blade — how smoothly a blade can bend. */
    joints?: number
    /** Relief multiplier for the terrain fallback. 0 flattens it. */
    terrainAmplitude?: number
    /**
     * Draw the displaced fBm ground plane.
     *
     * Off by default: when blades are placed on the collider, that mesh *is* the
     * ground, and a second surface underneath it would z-fight and poke through.
     * Only meaningful with terrain placement.
     */
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
    /**
     * Size of the largest clump, in world units — the wavelength of the noise
     * that decides where the field is dense and where it thins out.
     *
     * Smaller gives many small patches, larger a few broad ones. Patches are
     * anchored in world space, so this is a real size in metres, not a fraction
     * of whatever the collider happens to span.
     */
    clumpScale?: number
    /**
     * How hard the clumping pushes the density around: `0` is a uniform scatter,
     * `1` is patches separated by near-bare ground.
     *
     * Redistribution only — the blade count is the same either way, so draw cost
     * does not move with this.
     */
    clumpStrength?: number
}

export function GrassComponent({
    objects = [],
    instances = 100000 * 3,
    placement = 'collider',
    width = 60,
    // The reference's blades are 0.12 x 1. These are 5x narrower and, since the
    // 1.5x height increase, 3.33x shorter — a finer lawn rather than its meadow.
    // Only the aspect differs from a uniform shrink, so the blades are noticeably
    // taller than they are wide.
    bladeWidth = 0.0524,
    bladeHeight = 0.5,
    joints = 5,
    terrainAmplitude = 1,
    showGround = false,
    // sRGB equivalents of the reference's (0, 0.6, 0) / (0, 0.1, 0).
    tipColor = '#009900',
    bottomColor = '#001a00',
    groundColor = '#000f00',
    windSpeed = 0.35,
    windStrength = 0.15,
    // ~8 m patches: wide enough to read as clumping at the scale the camera moves
    // over the field, small enough that the field as a whole still looks planted
    // rather than split into two halves.
    clumpScale = 8,
    clumpStrength = 1,
}: GrassComponentProps) {
    const scene = useThree((r) => r.scene)

    const [collider, setCollider] = useState<Mesh | null>(null)

    // Blender's version tag for the collider — a bump means the geometry was
    // reshaped, so the samples have to be regenerated. Same contract as
    // LoadCollider's `colliderVersion`.
    const colliderVersion = useMemo(() => {
        const found = objects.find((o) => o?.name === 'collider') as { version?: string } | undefined
        return found?.version ?? null
    }, [objects])

    // The collider is created by useMeshSync, which runs after this component
    // first renders (and only once Blender has pushed a scene), so it has to be
    // waited for rather than looked up once.
    useEffect(() => {
        if (placement !== 'collider') return

        const found = scene.getObjectByName('collider') as Mesh | null
        if (found) {
            setCollider(found)
            return
        }

        let raf = 0
        const tick = () => {
            const mesh = scene.getObjectByName('collider') as Mesh | null
            if (mesh) setCollider(mesh)
            else raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)

        return () => cancelAnimationFrame(raf)
    }, [scene, placement, colliderVersion])

    const built = useMemo(() => {
        // --- Blade template ---
        // One blade: a single column of `joints` quads, anchored at its root so
        // the shader's per-vertex rotation pivots about the base.
        const bladeTemplate = new PlaneGeometry(bladeWidth, bladeHeight, 1, joints)
        bladeTemplate.translate(0, bladeHeight / 2, 0)

        // --- Placement ---
        // Falls back to the fBm field when the collider is missing or unusable
        // (no normals, instanced), so the field is visible while a scene syncs
        // rather than silently empty. It is rebuilt — visibly — once the real
        // surface arrives.
        const sampled =
            placement === 'collider' && collider
                ? sampleColliderPlacement(collider, instances, clumpScale, clumpStrength)
                : null

        const bladePlacement =
            sampled ?? sampleTerrainPlacement(instances, width, terrainAmplitude, clumpScale, clumpStrength)

        const attributes = buildGrassAttributes(bladePlacement)

        // --- Instanced geometry ---
        const grassGeometry = new InstancedBufferGeometry()

        // The blade's shape is shared by every instance; only the per-instance
        // attributes below differ. These three attributes are borrowed from the
        // template (as the reference does), so the template must not be disposed
        // independently — its buffers are this geometry's buffers.
        grassGeometry.index = bladeTemplate.index
        grassGeometry.setAttribute('position', bladeTemplate.attributes.position)
        grassGeometry.setAttribute('uv', bladeTemplate.attributes.uv)

        grassGeometry.setAttribute('offset', new InstancedBufferAttribute(attributes.offsets, 3))
        grassGeometry.setAttribute('rootDirection', new InstancedBufferAttribute(attributes.rootDirection, 4))
        grassGeometry.setAttribute('orientation', new InstancedBufferAttribute(attributes.orientations, 4))
        grassGeometry.setAttribute('stretch', new InstancedBufferAttribute(attributes.stretches, 1))

        // Required, and not optional. InstancedBufferGeometry defaults this to
        // Infinity, and three's WebGPU path reads it *directly* as the draw's
        // instanceCount (RenderObject.getDrawParameters) — an instanced draw of
        // Infinity is a validation error, not a full draw.
        grassGeometry.instanceCount = instances

        // The geometry's own bounds cover a single blade at the origin, so three
        // would cull the entire field the moment the origin left the frustum.
        // Measured from the samples so it is right for either placement mode.
        grassGeometry.boundingSphere = computeFieldBounds(attributes.offsets, bladeHeight)

        const { material, uniforms } = createGrassMaterial({
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

        // --- Optional fBm ground (terrain placement only) ---
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

        return {
            grassMesh,
            grassGeometry,
            material,
            uniforms,
            groundMesh,
            groundMaterial,
        }
    }, [
        collider,
        colliderVersion,
        instances,
        placement,
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
        clumpScale,
        clumpStrength,
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
        <>
            <primitive object={built.grassMesh} />
            {built.groundMesh ? <primitive object={built.groundMesh} /> : null}
        </>
    )
}
