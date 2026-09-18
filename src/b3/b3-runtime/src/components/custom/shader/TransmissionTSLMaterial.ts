/**
 * `MeshTransmissionMaterial` — ported to **TSL** (three's node system) so it runs
 * on this project's `WebGPURenderer`, where the GLSL `onBeforeCompile` string
 * surgery it was written with no longer exists.
 *
 * Original GLSL by @N8Programs (https://gist.github.com/N8python/eb42d25c7cd00d12e965ac9cba544317),
 * itself grown from @ore_ukonpower's work and the next.junni.co.jp
 * `transparent.fs` beneath it. This is a port, not a rewrite: the refraction
 * maths is the same and only the seams it hangs off have changed.
 *
 * ## What changed, and why each change was necessary
 *
 * | Original (GLSL) | TSL port |
 * | --- | --- |
 * | `onBeforeCompile` + `#include <transmission_pars_fragment>` replace | Rebuilt as `Fn` nodes. three's own TSL refraction helpers are module-private, so the ones here are this file's copies of the same formulas |
 * | `#include <transmission_fragment>` replace, ending in `totalDiffuse = mix(...)` | `builder.context.backdrop` — the channel `PhysicalLightingModel` feeds its transmission colour through |
 * | `USE_SAMPLER` vs `buffer` `#define` | Resolved in JavaScript at build time: a supplied `buffer` is sampled directly, otherwise the live viewport texture is |
 * | `snoise` + `snoiseFractal` (hand-rolled simplex and a 4-octave fBm) | `mx_fractal_noise_float(p, 4)`, which is the same fBm |
 * | `random3` + `floatConstruct` bit-hashing, seeded from `gl_FragCoord` | TSL's `hash()` (PCG), seeded from `screenCoordinate` |
 * | `getVolumeTransmissionRay` / `getTransmissionSample` / `applyVolumeAttenuation` copied into the shader | Written against three's public TSL accessors |
 *
 * ## The one deliberate deviation from a literal transcription
 *
 * The original computes its Fresnel term **once per channel** — three times per
 * sample — but that term never sees the channel's IOR, so all three calls return
 * the same value. This port evaluates it once per sample and applies it to the
 * three channels from there. The result is identical; the saving is two Fresnel
 * evaluations out of three. It is the only intended difference, and it is in
 * `makeVolumetricRefraction`.
 *
 * ## The colour terms, and where this port and three disagree
 *
 * three's own TSL transmission hands its refraction two *blended* terms:
 * `diffuseContribution` (`diffuseColor.rgb * (1 - metalness)`) and
 * `specularColorBlended` (`mix(specularColor, diffuseColor.rgb, metalness)`),
 * each assigned by a material class under `materials/nodes/`.
 *
 * This port hands it `diffuseColor.rgb` and `specularColor` — the plain terms,
 * which is what the original's parameter list names. For any **dielectric** the
 * two spellings are the same expression: at `metalness = 0` both blends are
 * identities. A transmissive material is essentially always dielectric, so the
 * difference is theoretical — but it is not nothing above `metalness = 0`, where
 * this port reads brighter than three's built-in transmission would. Swap the
 * three arguments named `diffuseColor.rgb` and `specularColor` in
 * `makeVolumetricRefraction` for the blended forms if that case ever matters.
 *
 * ## Alpha
 *
 * The original returns `transmittedLight.a`-derived alpha from each sample. For
 * an **opaque** backdrop — which is the case this material exists for, and what
 * a glass object over a scene almost always has — that term works out to exactly
 * `1.0`: the sample's own alpha is 1, and the formula's `(1 - a) * factor` is
 * therefore 0. This port returns that `1.0` directly rather than carrying
 * per-sample alpha through the channel loop, so a material over a *transparent*
 * backdrop will differ in its alpha channel.
 *
 * ## Usage
 *
 * ```ts
 * const material = new TransmissionTSLMaterial({ thickness: 0.4, roughness: 0.05 })
 * mesh.material = material
 * ```
 *
 * Every knob the original exposed is a plain property here too, and each is
 * backed by a shader uniform, so it can be animated or bound to lil-gui after
 * construction with no rebuild. `samples` and `buffer` are the exceptions, and
 * both are documented where they are declared.
 */

import { BackSide, Color, type ColorRepresentation, type Texture } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import * as TSLRuntime from 'three/tsl'
import {
    Fn,
    If,
    Loop,
    cameraPosition,
    cameraProjectionMatrix,
    cameraViewMatrix,
    cameraViewport,
    clamp,
    diffuseColor,
    exp,
    float,
    hash,
    length,
    log,
    log2,
    mix,
    modelWorldMatrix,
    mx_fractal_noise_float,
    normalWorld,
    normalize,
    positionWorld,
    refract,
    screenCoordinate,
    screenSize,
    texture,
    textureBicubicLevel,
    time,
    uniform,
    vec2,
    vec3,
    vec4,
    viewportMipTexture,
    viewportOpaqueMipTexture,
    // Material property nodes — the live values three's shading reads.
    attenuationColor as attenuationColorNode,
    attenuationDistance as attenuationDistanceNode,
    ior as iorNode,
    roughness as roughnessNode,
    specularF90,
    specularColor,
    thickness as thicknessNode,
    transmission as transmissionNode,
} from 'three/tsl'

/**
 * `EnvironmentBRDF` is present on the `three/tsl` runtime (verified by listing
 * its exports) but is **missing from its shipped typings**, along with
 * `diffuseContribution` and `specularColorBlended`. It is the split-sum specular
 * Fresnel — the term the original's `getIBLVolumeRefraction` scales the
 * refracted colour by.
 *
 * Taken through a cast rather than substituted with the cheaper Schlick
 * approximation, because the two genuinely differ: Schlick ignores roughness
 * entirely, so a rough transmissive surface would read with a hard bright rim
 * instead of the broad one the original produces.
 */
const EnvironmentBRDF: any = (TSLRuntime as any).EnvironmentBRDF

/** Refraction samples per fragment when the caller does not say otherwise. */
const DEFAULT_SAMPLES = 6

// ---------------------------------------------------------------------------
// Viewport sources
// ---------------------------------------------------------------------------
// The refraction samples the *backdrop*: what has already been drawn behind the
// surface. On WebGPU that is the viewport texture three maintains for exactly
// this purpose, and which of the pair to read depends on the face being shaded —
// a back-facing fragment must see the opaque pass, or it samples the surface it
// is the inside of.
//
// Module-level singletons, mirroring `PhysicalLightingModel`'s own, so every
// material shares one framebuffer texture per side. A fresh `viewportMipTexture()`
// per material would give each instance its own.
const viewportBackSideTexture = viewportMipTexture()
const viewportFrontSideTexture = viewportOpaqueMipTexture()

// TSL's `Fn` infers a shader function's arity from the **length** of its
// parameter tuple, and an unannotated destructure leaves it at zero — so every
// helper below annotates its params, with the tuple's length matching its
// argument count exactly. A shared `any`-typed tuple would declare the wrong
// arity and reject every call site, so these are per-arity aliases rather than
// one loose type.
//
// The elements are `any` because these helpers are called with a mix of scalar,
// vector and matrix nodes, and TSL's typed overloads resolve the wrong member
// for that mix (see `getVolumeTransmissionRay`). The nodes themselves are still
// the runtime's own — only their static types are erased here.
type Args5 = [any, any, any, any, any]
type Args10 = [any, any, any, any, any, any, any, any, any, any]
type Args13 = [any, any, any, any, any, any, any, any, any, any, any, any, any]

// ---------------------------------------------------------------------------
// The refraction chain
// ---------------------------------------------------------------------------
// The TSL rebuild of the shader chunk the original spliced in. Each is a pure
// function of its arguments, so they are built once and shared by every material
// from this file.

/**
 * How far a refracted ray travels through the volume before it exits, in world
 * units — the view vector refracted off the surface normal, scaled by the
 * material's thickness *and* by the model's own scale, because thickness is
 * authored in local space and the mesh may be scaled.
 */
const getVolumeTransmissionRay = Fn(([n, v, thickness, ior, modelMatrix]: Args5) => {
    // Direction of refracted light.
    //
    // `refract` is a union of typed overloads, and with these mixed node
    // types TypeScript resolves it to the vec2 member and then rejects the
    // vec2 that comes back. The cast is on the callee rather than the
    // arguments because the call itself is right — only the union cannot be
    // narrowed from the static types. `normalize(n)` needs no cast: it is
    // untyped *through* this call, which is exactly why the resolution went
    // wrong in the first place.
    const refractionVector = vec3((refract as any)(v.negate(), normalize(n), float(1.0).div(ior)))

    // Rotation-independent scaling of the model matrix.
    const modelScale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz))

    // The thickness is specified in local space.
    return normalize(refractionVector).mul(thickness.mul(modelScale))
})

/**
 * Scale roughness by IOR, so an IOR of 1 (air, no bending at all) gives no
 * microfacet blur and 1.5 gives the full amount. Without it, a near-air material
 * would still smear its samples as though light were bending inside it.
 */
const applyIorToRoughness = Fn(([roughness, ior]: [any, any]) =>
    roughness.mul(clamp(ior.mul(2.0).sub(2.0), float(0.0), float(1.0))),
)

/**
 * One sample of the backdrop at a screen coordinate.
 *
 * `useBuffer` is a **build-time** choice, mirroring the original's `USE_SAMPLER`
 * define: whether a texture was supplied cannot change while the shader runs, so
 * it selects a path here rather than branching in the shader.
 *
 * With a buffer the sample is taken directly — the original's plain
 * `texture2D(buffer, …)`. Without one it reads the viewport texture at a **mip
 * level chosen by roughness**: the GPU's own blur, which is where three's
 * built-in transmission gets its soft look, and what the bicubic tap
 * interpolates between.
 */
const getTransmissionSample = (useBuffer: boolean, back: boolean, buffer: Texture | null) =>
    Fn(([fragCoord, roughness, ior]: [any, any, any]) => {
        // A refracted ray that leaves the screen entirely would otherwise wrap to
        // the opposite edge and sample light from nowhere.
        const screenUv = clamp(
            fragCoord.mul(cameraViewport.zw).add(cameraViewport.xy).div(screenSize),
            vec2(0.0, 0.0),
            vec2(1.0, 1.0),
        )

        if (useBuffer && buffer) {
            return texture(buffer, screenUv).rgb
        }

        const vTexture = back ? viewportBackSideTexture : viewportFrontSideTexture

        // `viewportMipTexture()` returns a `TextureNode` at runtime, but three's
        // typings declare its return as a bare `Node`, which has no `sample`.
        // The method is there; the declaration is not.
        return textureBicubicLevel(
            (vTexture as any).sample(screenUv),
            log2(cameraViewport.z).mul(applyIorToRoughness(roughness, ior)),
        ).rgb
    })

/**
 * Beer's law: how much transmitted light survives the trip through the volume,
 * given the volume's colour and how far light travels before it is fully
 * absorbed.
 *
 * A distance of 0 reads as "no volume" rather than "infinitely dense" — this is
 * three's own test, and it matters because the default is `Infinity`, which
 * needs no special case: `-log(colour) / Infinity` is 0, so the transmittance
 * comes out as 1 and the light passes untinted. The original's `isinf` branch
 * was an optimisation of exactly that.
 */
const volumeAttenuation = Fn(([transmissionDistance, attenuationColor, attenuationDistance]: [any, any, any]) => {
    const transmittance = vec3(1.0).toVar()

    If(attenuationDistance.notEqual(0.0), () => {
        const attenuationCoefficient = log(attenuationColor).negate().div(attenuationDistance)
        transmittance.assign(exp(attenuationCoefficient.negate().mul(transmissionDistance)))
    })

    return transmittance
})

/**
 * One refracted channel: where the ray exits, what it reads there, and how the
 * volume absorbed it — the original's `getIBLVolumeRefraction` with the sample's
 * alpha and the Fresnel term left out. Those two are the same for every channel,
 * which is what lets the caller loop over IORs and evaluate each of them once —
 * see the module header.
 */
const refractionSample = Fn(
    ([
        n,
        v,
        roughness,
        diffuse,
        position,
        modelMatrix,
        viewMatrix,
        projMatrix,
        ior,
        thickness,
        attenuationColor,
        attenuationDistance,
        sample,
    ]: Args13) => {
        const transmissionRay = getVolumeTransmissionRay(n, v, thickness, ior, modelMatrix)
        const refractedRayExit = position.add(transmissionRay)

        // Project the refracted exit point into normalized device coordinates.
        // `y` is flipped because texture space starts at the opposite corner from
        // clip space — the original was written for WebGL and did not need this.
        const ndcPos = projMatrix.mul(viewMatrix.mul(vec4(refractedRayExit, 1.0)))
        const refractionCoords = vec2(ndcPos.xy.div(ndcPos.w)).toVar()
        refractionCoords.addAssign(1.0)
        refractionCoords.divAssign(2.0)
        refractionCoords.assign(vec2(refractionCoords.x, refractionCoords.y.oneMinus()))

        // What the ray reads, tinted by the volume it crossed and by the
        // surface's own diffuse colour.
        return vec3(
            sample(refractionCoords, roughness, ior).mul(
                volumeAttenuation(length(transmissionRay), attenuationColor, attenuationDistance),
            ),
        ).mul(diffuse)
    },
)

/**
 * The whole transmission term: the N-sample chromatic loop, returning what the
 * surface transmits.
 *
 * Per sample it jitters the shading normal by the surface roughness (a rough
 * surface reads the backdrop through a wider cone), spreads the channel IORs by
 * `chromaticAberration` (so the channels land in slightly different places), and
 * thickens the volume further along the sample — the "smear". The jitter is
 * seeded per fragment, so what it contributes is noise that averages out across
 * the samples rather than a repeating pattern.
 */
const makeVolumetricRefraction = (options: {
    samples: number
    useBuffer: boolean
    back: boolean
    buffer: Texture | null
    // The live knobs enter the graph as **uniform nodes**, not as their values:
    // a value read here would be baked in at build time, and dragging a slider
    // would do nothing until the shader was rebuilt. They are `any` because the
    // callers are node-typed and these are only ever used as node operands —
    // `ReturnType<typeof uniform>` erases the type parameter to `unknown` and
    // then has none of the node methods.
    chromaticAberration: any
    anisotropicBlur: any
    distortion: any
    distortionScale: any
    temporalDistortion: any
}) =>
    Fn(
        ([
            n,
            v,
            position,
            modelMatrix,
            viewMatrix,
            projMatrix,
            roughness,
            thickness,
            attenuationColor,
            attenuationDistance,
        ]: Args10) => {
            const {
                samples,
                useBuffer,
                back,
                buffer,
                chromaticAberration,
                anisotropicBlur,
                distortion,
                distortionScale,
                temporalDistortion,
            } = options

            const sampleBackdrop = getTransmissionSample(useBuffer, back, buffer)

            // The running seed, as in the original: a counter bumped once per
            // random value, so every jitter in a sample is a different draw.
            const seed = float(0.0).toVar()

            // Hashed with a per-fragment offset, so neighbouring pixels do not
            // share a jitter pattern. Screen coordinates are whole numbers, so
            // the seed stays inside the range a float holds exactly.
            const pixelSeed = screenCoordinate.x.add(screenCoordinate.y.mul(1024.0))

            const rand = () => {
                seed.addAssign(1.0)
                return hash(pixelSeed.add(seed))
            }

            // A rough surface smears its samples along the refraction direction,
            // so how much volume a sample crosses varies with roughness — the
            // blur a rough transmissive surface shows is thickness, not merely
            // sampling error.
            const thicknessSmear = thickness.mul(roughness.pow(0.33).max(anisotropicBlur))

            // Noise distortion: a slow fBm crawl applied to the normal, which
            // makes the refraction waver like heat haze. Skipped outright at 0 —
            // it is three noise evaluations per fragment, and the original only
            // spends them when asked.
            const distortionNormal = vec3(0.0).toVar()
            If(distortion.greaterThan(0.0), () => {
                const temporalOffset = vec3(time, time.negate(), time.negate()).mul(temporalDistortion)
                const scaled = position.mul(distortionScale)
                distortionNormal.assign(
                    distortion.mul(
                        vec3(
                            mx_fractal_noise_float(scaled.add(temporalOffset), 4),
                            mx_fractal_noise_float(scaled.zxy.sub(temporalOffset), 4),
                            mx_fractal_noise_float(scaled.yxz.add(temporalOffset), 4),
                        ),
                    ),
                )
            })

            const transmission = vec3(0.0).toVar()
            // Shared by every sample, so the taps tile the smear evenly instead
            // of clustering — the original's `randomCoords`.
            const randomCoords = rand()

            Loop({ start: 0, end: samples }, ({ i }: { i: any }) => {
                const sampleIndex = float(i)

                // The normal, jittered inside a cone whose width is the
                // roughness, plus whatever the distortion noise adds.
                const sampleNorm = normalize(
                    n.add(
                        roughness
                            .mul(roughness)
                            .mul(2.0)
                            .mul(normalize(vec3(rand().sub(0.5), rand().sub(0.5), rand().sub(0.5))))
                            .mul(rand().pow(0.33))
                            .add(distortionNormal),
                    ),
                )

                // Each sample looks through a slightly thicker volume than the
                // last, which is what turns N discrete taps into a continuous
                // smear rather than N copies of one image.
                const sampleThickness = thickness.add(thicknessSmear.mul(sampleIndex.add(randomCoords)).div(samples))
                const spread = sampleIndex.add(randomCoords).div(samples)

                // The split-sum specular Fresnel — how much of this direction
                // reflects off the surface rather than entering it. Taken on the
                // *jittered* normal, as in the original, so a rough surface's
                // Fresnel varies across its samples.
                //
                // The original evaluates this once per channel — three times per
                // sample — but it never sees the IOR, so all three calls compute
                // the same value. This port spends one evaluation here and
                // reuses it for the three channels below. That is the port's one
                // deliberate deviation; it cannot change the result, only the
                // cost.
                const F = vec3(
                    EnvironmentBRDF({
                        dotNV: sampleNorm.dot(v).clamp(),
                        specularColor,
                        specularF90,
                        roughness,
                    }),
                )

                // One refraction per channel, each at its own IOR. The blue end
                // is pushed twice as far as the red, as in the original: the eye
                // reads that asymmetry as a rainbow edge rather than as a
                // uniform blur.
                transmission.addAssign(
                    vec3(
                        refractionSample(
                            sampleNorm,
                            v,
                            roughness,
                            diffuseColor.rgb,
                            position,
                            modelMatrix,
                            viewMatrix,
                            projMatrix,
                            iorNode.mul(chromaticAberration.mul(spread).add(1.0)),
                            sampleThickness,
                            attenuationColor,
                            attenuationDistance,
                            sampleBackdrop,
                        ).x,
                        refractionSample(
                            sampleNorm,
                            v,
                            roughness,
                            diffuseColor.rgb,
                            position,
                            modelMatrix,
                            viewMatrix,
                            projMatrix,
                            iorNode,
                            sampleThickness,
                            attenuationColor,
                            attenuationDistance,
                            sampleBackdrop,
                        ).y,
                        refractionSample(
                            sampleNorm,
                            v,
                            roughness,
                            diffuseColor.rgb,
                            position,
                            modelMatrix,
                            viewMatrix,
                            projMatrix,
                            iorNode.mul(chromaticAberration.mul(2.0).mul(spread).add(1.0)),
                            sampleThickness,
                            attenuationColor,
                            attenuationDistance,
                            sampleBackdrop,
                        ).z,
                    ).mul(F.oneMinus()),
                )
            })

            transmission.divAssign(samples)

            return vec4(transmission, 1.0)
        },
    )

// ---------------------------------------------------------------------------
// Material
// ---------------------------------------------------------------------------

export interface TransmissionTSLParams {
    /**
     * Refraction samples averaged per pixel. **Baked into the shader** — a loop
     * bound cannot be a uniform — so changing it needs a new material.
     *
     * The original's 6 is kept. Cost is linear: this material takes `samples`
     * refraction samples per fragment where three's built-in transmission takes
     * one, so on a large surface drop it to 3 or 4 if frame time matters more
     * than the banding.
     */
    samples?: number
    /** How far the red and blue channels' IORs are pushed apart, as a fraction —
     *  the colour fringeing on the refracted image. 0 refracts cleanly. */
    chromaticAberration?: number
    /** How much of the refracted backdrop replaces the surface's own shading.
     *  This is the material's `transmission` property; 1 is fully glassy. */
    transmission?: number
    /** Surface roughness. Defaults to **0** rather than `MeshPhysicalMaterial`'s
     *  1, which reads as opaque on a transmissive material. */
    roughness?: number
    /** Volume thickness in the mesh's own local units — how far the refracted
     *  ray travels inside the surface before it exits to sample the backdrop. At
     *  0 the chromatic aberration disappears, because all three channels exit at
     *  the same point. */
    thickness?: number
    /** Beer's-law attenuation distance. `Infinity` transmits untinted. */
    attenuationDistance?: number
    /** The colour the volume tints transmitted light towards. */
    attenuationColor?: ColorRepresentation
    /** Minimum roughness blur on the sample spread, independent of the surface's
     *  own roughness — keeps the refraction from pinching to a point. */
    anisotropicBlur?: number
    /** Strength of the procedural noise distortion on the refraction normal.
     *  0 skips the noise entirely. */
    distortion?: number
    /** Spatial frequency of that noise. Larger is finer. */
    distortionScale?: number
    /** How fast the distortion crawls. 0 freezes it. */
    temporalDistortion?: number
    /**
     * Sample this texture as the refraction source instead of the live viewport
     * — the original's `buffer`. Baked in at build time (like the original's
     * `USE_SAMPLER` define): assigning a different one later needs
     * `material.needsUpdate = true`.
     */
    buffer?: Texture | null
    /** Index of refraction. 1.0 is air (no bending), 1.5 is glass. */
    ior?: number
}

/**
 * A `MeshPhysicalNodeMaterial` whose transmission is the multi-sample chromatic
 * refraction above rather than three's single-tap one.
 *
 * It extends the standard physical material rather than rebuilding a lighting
 * model: every other term — diffuse, specular, IBL, clearcoat, sheen,
 * iridescence, anisotropy — is inherited and therefore stays in step with
 * three's shading as the engine moves, and only the backdrop the transmission
 * hands the compositor is replaced.
 */
export class TransmissionTSLMaterial extends MeshPhysicalNodeMaterial {
    /** Refraction samples per fragment. Baked in at build time — see the
     *  parameter's docs. Reassigning needs `needsUpdate = true`, and `copy()`
     *  carries it so a `clone()` keeps the source's count rather than the
     *  default. */
    samples: number

    /** Refraction source, or null for the live viewport. Needs `needsUpdate`
     *  after being reassigned — see the parameter's docs. */
    buffer: Texture | null

    // The knobs three has no property slot for. Each is a uniform the shader
    // reads; the matching accessor below is what callers actually touch, so a
    // value written after construction takes effect on the next frame with no
    // rebuild — the original's `Object.defineProperty` behaviour, which lil-gui
    // and any animation depend on.
    //
    // **The leading underscore is load-bearing.** `NodeMaterial.copy` walks
    // every own property of a clone and assigns each from the source, skipping
    // only names matching `/^(?:is[A-Z]|_)/` (`materials/nodes/NodeMaterial.js`).
    // A field named `uniforms` would therefore be *replaced by the source's own
    // object* on `clone()`, and the clone would share one set of uniform nodes
    // with its source: moving the clone's slider would move the original's
    // glass. The underscore is three's convention for "internal, do not copy",
    // and it is what keeps a clone's knobs its own.
    //
    // The values are `any` because `uniform()` is generic over its argument and
    // `ReturnType<typeof uniform>` collapses that to `UniformNode<unknown>` —
    // whose `.value` is `unknown` and which then cannot be assigned back to a
    // number. The nodes themselves are ordinary float uniforms.
    private readonly _uniforms: Record<
        'distortion' | 'distortionScale' | 'temporalDistortion' | 'chromaticAberration' | 'anisotropicBlur',
        any
    >

    constructor(params: TransmissionTSLParams = {}) {
        super()

        this.samples = Math.max(1, Math.floor(params.samples ?? DEFAULT_SAMPLES))
        this.buffer = params.buffer ?? null

        // Everything three has a slot for is written to the material itself, so
        // tone mapping, `RenderList` and the renderer's transmission pass all
        // see an ordinarily-transmissive material. Only the terms three has no
        // property for live in `uniforms`.
        this.transmission = params.transmission ?? 1
        this.roughness = params.roughness ?? 0
        this.thickness = params.thickness ?? 0
        this.ior = params.ior ?? 1.5
        this.attenuationDistance = params.attenuationDistance ?? Infinity
        this.attenuationColor = new Color(params.attenuationColor ?? 'white')

        this._uniforms = {
            distortion: uniform(params.distortion ?? 0.0),
            distortionScale: uniform(params.distortionScale ?? 0.5),
            temporalDistortion: uniform(params.temporalDistortion ?? 0.0),
            chromaticAberration: uniform(params.chromaticAberration ?? 0.05),
            anisotropicBlur: uniform(params.anisotropicBlur ?? 0.1),
        }
    }

    /** Strength of the noise distortion on the refraction normal. Live. */
    get distortion(): number {
        return this._uniforms.distortion.value as number
    }
    set distortion(value: number) {
        this._uniforms.distortion.value = value
    }

    /** Spatial frequency of the distortion noise. Live. */
    get distortionScale(): number {
        return this._uniforms.distortionScale.value as number
    }
    set distortionScale(value: number) {
        this._uniforms.distortionScale.value = value
    }

    /** How fast the distortion noise crawls. Live. */
    get temporalDistortion(): number {
        return this._uniforms.temporalDistortion.value as number
    }
    set temporalDistortion(value: number) {
        this._uniforms.temporalDistortion.value = value
    }

    /** How far the channel IORs are pushed apart. Live. */
    get chromaticAberration(): number {
        return this._uniforms.chromaticAberration.value as number
    }
    set chromaticAberration(value: number) {
        this._uniforms.chromaticAberration.value = value
    }

    /** Minimum roughness blur on the sample spread. Live. */
    get anisotropicBlur(): number {
        return this._uniforms.anisotropicBlur.value as number
    }
    set anisotropicBlur(value: number) {
        this._uniforms.anisotropicBlur.value = value
    }

    /**
     * Hand the lighting model this refraction in place of its own transmission.
     *
     * The base class returns a `PhysicalLightingModel` configured from this
     * material's own flags. Its transmission block is switched off — every other
     * term and every other flag (clearcoat, sheen, iridescence, anisotropy) is
     * left exactly as the material configured it — and the backdrop is written
     * here instead. The `diffuseColor.a` line at the end is the one thing the
     * base block did that still has to happen, so it is done here with this
     * refraction's alpha.
     *
     * `PhysicalLightingModel` is not exported from `three/webgpu`, so this wraps
     * the instance the base returned rather than subclassing it. That has an
     * advantage beyond being possible: the flags are read off the material by
     * three itself, so they cannot drift from it.
     *
     * The graph is built here rather than in the constructor so that the
     * build-time inputs — the buffer, the face — are read when the shader is
     * actually assembled. That is what makes a `buffer` reassignment take effect
     * on `needsUpdate`.
     */
    setupLightingModel() {
        const model = super.setupLightingModel() as any

        // Take the transmission block over; nothing else in the model reads it.
        model.transmission = false

        const refraction = makeVolumetricRefraction({
            samples: this.samples,
            useBuffer: this.buffer !== null,
            back: this.side === BackSide,
            buffer: this.buffer,
            chromaticAberration: this._uniforms.chromaticAberration,
            anisotropicBlur: this._uniforms.anisotropicBlur,
            distortion: this._uniforms.distortion,
            distortionScale: this._uniforms.distortionScale,
            temporalDistortion: this._uniforms.temporalDistortion,
        })

        const start = model.start.bind(model)

        model.start = (builder: any) => {
            start(builder)

            const context = builder.context

            context.backdrop = refraction(
                normalWorld,
                cameraPosition.sub(positionWorld).normalize(),
                positionWorld,
                modelWorldMatrix,
                cameraViewMatrix,
                cameraProjectionMatrix,
                roughnessNode,
                thicknessNode,
                attenuationColorNode,
                attenuationDistanceNode,
            )
            context.backdropAlpha = transmissionNode

            // As less light is transmitted the fragment should read as more
            // opaque — the base model's own approximation, so a transmission of
            // 0 leaves the surface completely solid.
            diffuseColor.a.mulAssign(mix(1.0, context.backdrop.a, transmissionNode))
        }

        return model
    }

    /**
     * `clone()` builds a bare instance and copies onto it, so anything this
     * class sets outside an ordinary property has to be carried here by hand.
     *
     * `super.copy` handles the three properties it knows about — `samples` and
     * `buffer` among them — but the knobs live in `_uniforms`, which it skips
     * (see the field's docs), so they are read through the accessors above and
     * written back as plain numbers. That write goes into **this** clone's
     * uniforms, which its own constructor made, leaving the source's untouched.
     *
     * `samples` and `buffer` are assigned explicitly even though `super.copy`
     * also carries them: both are baked in at build time rather than set as
     * material state, and a clone that silently fell back to `DEFAULT_SAMPLES`
     * would refract visibly differently from the material it was cloned from.
     * Naming them here is what keeps that from being an accident of three's
     * copy loop.
     */
    override copy(source: any) {
        super.copy(source)

        if (source instanceof TransmissionTSLMaterial) {
            this.samples = source.samples
            this.buffer = source.buffer
            this.distortion = source.distortion
            this.distortionScale = source.distortionScale
            this.temporalDistortion = source.temporalDistortion
            this.chromaticAberration = source.chromaticAberration
            this.anisotropicBlur = source.anisotropicBlur
        }

        return this
    }
}
