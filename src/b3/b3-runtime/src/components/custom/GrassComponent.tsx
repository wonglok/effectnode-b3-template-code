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
// Drawing is radius-culled around the player. Every blade stays resident in the
// instance buffers; only the ones near the player sit inside
// `geometry.instanceCount`, and the rest cost nothing to draw. `grassCuller.ts`
// owns that rearrangement, and its header explains why it is done by permuting
// the buffers rather than by duplicating or filtering them.
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
import { MeshStandardNodeMaterial } from 'three/webgpu'
import type { Texture } from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { useGameGlobal } from '../../../../../components/useGameGlobal'
import type { BlenderObject } from '../types/blenderTypes'
import { createGrassCuller } from './grassCuller'
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

/** Ground height at a world position. `amplitude` 0 flattens it. */
function terrainHeight(x: number, z: number, amplitude: number): number {
    if (amplitude === 0) return 0

    let y = 2 * valueNoise2D(x / 50, z / 50, 1)
    y += 4 * valueNoise2D(x / 100, z / 100, 2)
    y += 0.2 * valueNoise2D(x / 10, z / 10, 3)

    return y * amplitude
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
function sampleColliderPlacement(collider: Mesh, instances: number): BladePlacement | null {
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
    const normalMatrix = new Matrix3()

    for (let i = 0; i < instances; i++) {
        sampler.sample(point, normal)

        point.applyMatrix4(collider.matrixWorld)
        normal.applyNormalMatrix(normalMatrix.getNormalMatrix(collider.matrixWorld))

        // Exported meshes routinely carry inverted winding, which would grow
        // every blade out of the *underside* of the terrain. Trust the side the
        // surface faces rather than the winding: anything pointing below the
        // horizon is flipped back up.
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
function sampleTerrainPlacement(instances: number, width: number, terrainAmplitude: number): BladePlacement {
    const positions = new Float32Array(instances * 3)
    const ups = new Float32Array(instances * 3)

    for (let i = 0; i < instances; i++) {
        const x = Math.random() * width - width / 2
        const z = Math.random() * width - width / 2

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
     * How far from the player blades are drawn, in world units.
     *
     * A blade beyond this is not in the draw at all. Nothing prunes it from the
     * buffers — it stays resident and simply falls outside `instanceCount` — so
     * this trades draw cost, not memory.
     */
    cullRadius?: number
    /**
     * Width of the band just inside `cullRadius` over which a blade shortens to
     * nothing, so the edge of the field is walked into rather than popped at.
     *
     * Also the ceiling on `updateDistance`: a blade has to be admitted while it
     * is still in this band, or it would be seen switching on at full height.
     */
    fadeWidth?: number
    /**
     * Query again only once the player has moved this far.
     *
     * Clamped to `fadeWidth` for the reason above. Raising it costs smoothness,
     * not correctness: the query is a BVH descent, so the throttle is about how
     * often the instance buffers are rewritten, not about the search.
     */
    updateDistance?: number
}

export function GrassComponent({
    objects = [],
    instances = 120000 * 12.5,
    placement = 'collider',
    width = 60,
    // The reference's blades are 0.12 x 1. These are 5x narrower and, since the
    // 1.5x height increase, 3.33x shorter — a finer lawn rather than its meadow.
    // Only the aspect differs from a uniform shrink, so the blades are noticeably
    // taller than they are wide.
    bladeWidth = 0.024,
    bladeHeight = 0.3,
    joints = 5,
    terrainAmplitude = 1,
    showGround = false,
    // sRGB equivalents of the reference's (0, 0.6, 0) / (0, 0.1, 0).
    tipColor = '#009900',
    bottomColor = '#001a00',
    groundColor = '#000f00',
    windSpeed = 0.25,
    windStrength = 0.15,
    cullRadius = 5,
    fadeWidth = 2,
    updateDistance = 1,
}: GrassComponentProps) {
    const scene = useThree((r) => r.scene)

    // The character rig's group, published by NavMeshRig once its navmesh is
    // built. Read live inside useFrame rather than subscribed to: it is a single
    // long-lived object whose *position* changes every frame, so a subscription
    // would re-render this component 60 times a second to learn nothing.
    const playerGroup = useGameGlobal((r) => r.playerGroup) as { position: Vector3 } | null

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
        const sampled = placement === 'collider' && collider ? sampleColliderPlacement(collider, instances) : null

        const bladePlacement = sampled ?? sampleTerrainPlacement(instances, width, terrainAmplitude)

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

        // Held by name rather than passed inline: the culler permutes these
        // arrays in place, and the per-frame upload has to name each one to
        // narrow its update range to the slots that actually moved.
        const gpuAttributes = {
            offset: new InstancedBufferAttribute(attributes.offsets, 3),
            rootDirection: new InstancedBufferAttribute(attributes.rootDirection, 4),
            orientation: new InstancedBufferAttribute(attributes.orientations, 4),
            stretch: new InstancedBufferAttribute(attributes.stretches, 1),
        }

        grassGeometry.setAttribute('offset', gpuAttributes.offset)
        grassGeometry.setAttribute('rootDirection', gpuAttributes.rootDirection)
        grassGeometry.setAttribute('orientation', gpuAttributes.orientation)
        grassGeometry.setAttribute('stretch', gpuAttributes.stretch)

        // Required, and not optional. InstancedBufferGeometry defaults this to
        // Infinity, and three's WebGPU path reads it *directly* as the draw's
        // instanceCount (RenderObject.getDrawParameters) — an instanced draw of
        // Infinity is a validation error, not a full draw.
        //
        // It is also the whole culling mechanism: the culler keeps the drawn
        // blades in a prefix of these buffers and this is narrowed to match, so
        // the blades outside it are never submitted.
        grassGeometry.instanceCount = instances

        // The geometry's own bounds cover a single blade at the origin, so three
        // would cull the entire field the moment the origin left the frustum.
        // Measured from the samples so it is right for either placement mode.
        //
        // Deliberately left spanning the whole field rather than narrowed to the
        // drawn prefix: the player is always inside the field, so this can never
        // cull anything the prefix would have drawn, whereas a stale or too-small
        // sphere here would blank the grass entirely.
        grassGeometry.boundingSphere = computeFieldBounds(attributes.offsets, bladeHeight)

        const culler = createGrassCuller(
            {
                offset: attributes.offsets,
                rootDirection: attributes.rootDirection,
                orientation: attributes.orientations,
                stretch: attributes.stretches,
            },
            { cullRadius, fadeWidth, updateDistance },
        )

        const { material, uniforms } = createGrassMaterial({
            map: bladeDiffuse,
            alphaMap: bladeAlpha,
            bladeHeight,
            tipColor,
            bottomColor,
            windSpeed,
            windStrength,
            cullRadius,
            fadeWidth,
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
            gpuAttributes,
            culler,
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
        cullRadius,
        fadeWidth,
        updateDistance,
    ])

    // -----------------------------------------------------------------------
    // Per-frame culling
    // -----------------------------------------------------------------------
    // `built` is captured by the closure and refreshed every render, so this
    // reads the culler of whatever field is current — including across a collider
    // re-sync, where the new culler starts with the whole field drawn and
    // compacts on its first update.
    useFrame(() => {
        // Before NavMeshRig publishes the player there is nothing to cull around,
        // and the field draws in full. That is the honest fallback — the culler
        // starts with every blade in the drawn prefix for the same reason.
        if (!playerGroup) return

        const { x, y, z } = playerGroup.position

        // Every frame, not only when the set changes. This is what moves the fade
        // out to meet the player, and it is also why a set that is a moment stale
        // is never seen: a blade dropped from the set is beyond `cullRadius` by
        // the time it goes, so the shader has already scaled it to nothing.
        built.uniforms.playerPosition.value.copy(playerGroup.position)

        if (!built.culler.update(x, y, z)) return

        built.grassGeometry.instanceCount = built.culler.visibleCount

        // Only the slots that moved are re-uploaded. The backend walks
        // `updateRanges` and clears it after the copy, so an empty range would
        // mean the whole buffer — which is the thing this avoids.
        const start = built.culler.dirtyStart
        const span = built.culler.dirtyEnd - start

        const ranges: Array<[InstancedBufferAttribute, number]> = [
            [built.gpuAttributes.offset, 3],
            [built.gpuAttributes.rootDirection, 4],
            [built.gpuAttributes.orientation, 4],
            [built.gpuAttributes.stretch, 1],
        ]

        for (const [attribute, itemSize] of ranges) {
            attribute.addUpdateRange(start * itemSize, span * itemSize)
            attribute.needsUpdate = true
        }
    })

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
