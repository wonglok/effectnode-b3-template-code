// ---------------------------------------------------------------------------
// TSL grass-blade material — a node-material port of three's `grass-shader` example
// ---------------------------------------------------------------------------
// Reference: https://github.com/pmndrs/examples/tree/main/examples/grass-shader
// (MIT, Poimandres) — itself a rewrite of al-ro's codepen, after Eddie Lee's
// "Realistic real-time grass rendering" (2010).
//
// The reference is a raw GLSL ShaderMaterial. This is the same shader as TSL
// nodes, so it runs on the project's WebGPURenderer instead of the WebGL path.
// Two things had to change on the way over, both noted inline:
//
//   * `snoise` (Ashima/Stefan Gustavson GLSL noise) becomes `mx_noise_float`,
//     the MaterialX Perlin node — which `LoadCollider` already uses here.
//   * `select` is used for the branches GLSL expresses with `if`, because TSL
//     has no divergence-free statement form worth using for a per-vertex branch.
//
// The deformation is driven entirely by per-instance geometry attributes that
// `GrassComponent` generates on the CPU — see `buildGrassAttributes` there.
// ---------------------------------------------------------------------------

import { Color, DoubleSide, MeshBasicNodeMaterial, SRGBColorSpace } from 'three/webgpu'
import type { Node, Texture } from 'three/webgpu'
import {
    Fn,
    abs,
    acos,
    attribute,
    cos,
    cross,
    dot,
    float,
    max,
    mix,
    mx_noise_float,
    normalize,
    positionLocal,
    saturate,
    select,
    sin,
    texture,
    time,
    uniform,
    uv,
    vec2,
    vec3,
    vec4,
} from 'three/tsl'

// ---------------------------------------------------------------------------
// Geometry attribute readers
// ---------------------------------------------------------------------------
// `attribute(name, nodeType)` loses its node type in the @types/three
// declaration — it collapses to `Node<string>`, which nothing downstream
// accepts, and these feed straight into `vec4(...)` joins. The runtime node is
// exactly what `nodeType` says, so these restore the type without changing it.
//
// (The repo pins @types/three 0.185.4 against three 0.186.0, so this is a
// typing gap rather than a mismatch in behaviour.)

const vec3Attribute = (name: string) => attribute(name, 'vec3') as unknown as Node<'vec3'>
const vec4Attribute = (name: string) => attribute(name, 'vec4') as unknown as Node<'vec4'>
const floatAttribute = (name: string) => attribute(name, 'float') as unknown as Node<'float'>

// ---------------------------------------------------------------------------
// Quaternion helpers
// ---------------------------------------------------------------------------

/**
 * Rotate `v` by unit quaternion `q`.
 *
 * `v + 2·(q.xyz × (q.xyz × v + q.w·v))` — the standard identity (and the same
 * one the reference uses; it is cheaper than building a matrix per vertex).
 */
const rotateByQuaternion = Fn(([v, q]: [Node<'vec3'>, Node<'vec4'>]) => {
    return cross(q.xyz, cross(q.xyz, v).add(q.w.mul(v)))
        .mul(2)
        .add(v)
})

/**
 * Shortest-path spherical interpolation between two unit quaternions.
 *
 * A faithful port of the reference's `slerp`, including its two guards, which
 * matter here because this runs per vertex over the whole field:
 *
 *  - `q` and `-q` describe the same rotation, so a negative dot product is
 *    flipped first. Without that, half the field interpolates the long way round
 *    and the blades visibly spin as they bend.
 *  - Near-parallel inputs degenerate the `sin θ₀` denominator (both to zero), so
 *    `sin θ₀` is floored and the near-parallel case falls back to a lerp.
 *
 * Both branches of the final `select` are evaluated — it compiles to a ternary,
 * not a branch — which is why the guard is a `max` on the denominator rather
 * than a division the shader can skip.
 */
const slerp = Fn(([v0, v1, t]: [Node<'vec4'>, Node<'vec4'>, Node<'float'>]) => {
    const DOT_THRESHOLD = 0.9995

    const rawDot = dot(v0, v1)
    const target = select(rawDot.lessThan(0), v1.negate(), v1)
    const d = abs(rawDot)

    // `d` is `abs(dot)` of two unit quaternions, so it lands in [0, 1] already —
    // `saturate` just absorbs the float error that can push it a hair past 1,
    // where `acos` would return NaN and take the whole blade with it.
    const theta0 = acos(saturate(d))
    const theta = theta0.mul(t)
    const s1 = sin(theta).div(max(sin(theta0), 1e-5))
    const s0 = cos(theta).sub(d.mul(s1))
    const spherical = v0.mul(s0).add(target.mul(s1))

    const linear = v0.add(target.sub(v0).mul(t))

    return normalize(select(d.greaterThan(DOT_THRESHOLD), linear, spherical))
})

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

export interface GrassMaterialOptions {
    /** Blade albedo (sRGB). */
    map: Texture
    /** Blade silhouette, sampled on `.r` as the cutout. Data, not colour. */
    alphaMap: Texture
    /** Blade length in world units — the reference's `bladeHeight`. */
    bladeHeight: number
    /** Colour at the blade tip, as an sRGB hex string. */
    tipColor: string
    /** Colour at the blade root, as an sRGB hex string. */
    bottomColor: string
    /** How far the gust field advances per second (reference: elapsed / 4). */
    windSpeed: number
    /** Peak bend, in radians, of the per-blade gust. */
    windStrength: number
}

export interface GrassMaterial {
    material: MeshBasicNodeMaterial
    /** Live-tweakable values — mutate `.value` to re-tune without a rebuild. */
    uniforms: {
        bladeHeight: { value: number }
        windSpeed: { value: number }
        windStrength: { value: number }
    }
}

/**
 * Build the blade material.
 *
 * Deliberately `MeshBasicNodeMaterial`: the reference is unlit — it shades the
 * blade with its texture plus a tip/root colour ramp, and nothing else. Adding
 * scene lighting would change the look rather than reproduce it.
 */
export function createGrassMaterial(options: GrassMaterialOptions): GrassMaterial {
    const { map, alphaMap, tipColor, bottomColor } = options

    // Per-instance attributes generated in GrassComponent.buildGrassAttributes.
    // `attribute()` picks up the InstancedBufferAttribute by name; three's WebGPU
    // backend reads `isInstancedBufferAttribute` to set the vertex step mode.
    //
    // `rootDirection` is the blade's "unbent" endpoint — root heading only, no
    // tilt. The reference reconstructs it in-shader as `vec4(0, sin, 0, cos)`,
    // a pure Y rotation, because its blades only ever stand plumb with the world.
    // Here blades are aligned to a sampled surface normal, so the endpoint is no
    // longer a Y rotation and has to arrive as a full quaternion.
    const offset = vec3Attribute('offset')
    const orientation = vec4Attribute('orientation')
    const stretch = floatAttribute('stretch')
    const rootDirection = vec4Attribute('rootDirection')

    const bladeHeight = uniform(options.bladeHeight)
    const windSpeed = uniform(options.windSpeed)
    const windStrength = uniform(options.windStrength)

    // Colours arrive as sRGB hex and are converted exactly once. The reference
    // builds them with `new THREE.Color(r, g, b).convertSRGBToLinear()`, but a
    // Color constructed from raw components is *already* in the working
    // (linear) space, so that call decodes twice and darkens the ramp. The hex
    // values below are the  sRGB equivalents of the reference's components, so
    // this reproduces its intended colours rather than its double-decode.
    const tipRgb = new Color().setStyle(tipColor, SRGBColorSpace)
    const bottomRgb = new Color().setStyle(bottomColor, SRGBColorSpace)

    const material = new MeshBasicNodeMaterial()

    // ---- Vertex -----------------------------------------------------------

    // How far up the blade this vertex sits, 0 at the root → 1 at the tip.
    //
    // The reference computes this in the vertex shader and passes it down as a
    // varying, then reads it in the fragment shader. It is not needed as a
    // varying: the blade is a PlaneGeometry whose UV runs 0..1 over exactly the
    // span that `position.y / bladeHeight` covers, so the fragment can derive it
    // from `uv().y` directly and the value interpolates identically.
    const rootToTip = positionLocal.y.div(bladeHeight)

    // A blade is *born* pointing straight out of the surface, rotated about that
    // surface normal by its random root angle. As you move up the blade, `slerp`
    // walks that direction towards the blade's authored (tilted) orientation —
    // which is what produces a smooth arc rather than a hinge at the root.
    const direction = slerp(rootDirection, orientation, rootToTip)

    // Per-blade height variation. The reference does not scale the whole blade
    // uniformly — it only stretches the Y component, which is why taller blades
    // are also slightly thinner in silhouette.
    const stretched = vec3(
        positionLocal.x,
        positionLocal.y.add(positionLocal.y.mul(stretch)),
        positionLocal.z,
    )

    const bent = rotateByQuaternion(stretched, direction)

    // Wind. Sampling a noise field at (time, blade position) rather than giving
    // every blade the same phase is what makes gusts travel across the field
    // instead of the whole meadow pivoting in lockstep. The /50 on the offset is
    // the reference's — it sets the gust wavelength at ~50 world units.
    const clock = time.mul(windSpeed)
    const gust = float(1).sub(mx_noise_float(vec2(clock.sub(offset.x.div(50)), clock.sub(offset.z.div(50)))))
    const halfAngle = gust.mul(windStrength)

    // Rotating about the YZ plane (x = sin, y = 0, z = -sin) leans the blade
    // along one axis, so the field sways rather than spinning.
    const windQuaternion = normalize(vec4(sin(halfAngle), float(0), sin(halfAngle).negate(), cos(halfAngle)))

    // The framework applies modelViewMatrix and projection on top of this, so
    // returning the world-local offset position is the whole job.
    material.positionNode = Fn(() => {
        return offset.add(rotateByQuaternion(bent, windQuaternion))
    })()

    // ---- Fragment ---------------------------------------------------------

    // The reference's two successive mixes, weight for weight. The net effect is
    // a root→tip ramp: `bottomColor` dominates the base, the albedo the tip.
    const albedo = texture(map, uv())
    const fragmentRootToTip = uv().y
    const tinted = mix(vec3(tipRgb.r, tipRgb.g, tipRgb.b), albedo.rgb, fragmentRootToTip)
    const bladeColor = mix(vec3(bottomRgb.r, bottomRgb.g, bottomRgb.b), tinted, fragmentRootToTip)

    material.colorNode = bladeColor

    // The cutout, kept as `alphaTest` rather than as an inline discard so three's
    // own alpha-test handling applies — it honours `alphaToCoverage` when it is
    // on, giving the blade edges a fwidth-based soft edge that the reference's
    // hard `if (alpha < 0.15) discard` does not.
    material.opacityNode = texture(alphaMap, uv()).r
    material.alphaTest = 0.15

    material.side = DoubleSide

    return {
        material,
        uniforms: {
            bladeHeight: bladeHeight as unknown as { value: number },
            windSpeed: windSpeed as unknown as { value: number },
            windStrength: windStrength as unknown as { value: number },
        },
    }
}
