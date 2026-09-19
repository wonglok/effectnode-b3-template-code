import { useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useMemo } from 'react'
import { DoubleSide, Mesh, Object3D, RepeatWrapping, SRGBColorSpace, Texture, TextureLoader, Vector3 } from 'three'
import {
    Fn,
    vec2,
    mx_noise_float,
    vec4,
    texture,
    uv,
    time,
    vec3,
    float,
    select,
    lessThan,
    abs,
    max,
    step,
    uniform,
    color,
    add,
} from 'three/tsl'
import { MeshPhysicalNodeMaterial, Node } from 'three/webgpu'
import gsap from 'gsap'
import { useGameGlobal } from '../../../../../components/useGameGlobal'
import { FORCE_FIELD_SWEEP_SECONDS, forceFieldEase } from '../../../../../components/forceField'
// import { getOrCreateTexture } from '../utils/meshBuilder'
import { useNavRigStore } from '../stores/navRigStore'
// The ring shockwave lives in its own module — the grass uses the same one.
import { circlePulse } from './circlePulse'

export const getHoneyComb: (p: Node<'float'>, r: Node<'float'>, s: Node<'float'>) => Node<'float'> = Fn(
    ([pulse = float(1.0), thickness = float(0.125), scale = float(10.0)]: any) => {
        const p = uv().mul(scale)

        const r = vec2(1.0, 1.7320508) // vec2(1.0, sqrt(3))
        const h = r.mul(0.5)

        const a = p.mod(r).sub(h)
        const b = p.sub(h).mod(r).sub(h)

        const gv = select(lessThan(a.dot(a), b.dot(b)), a, b)

        const uvAbs = abs(gv)
        const hexDist = max(uvAbs.x, uvAbs.x.mul(0.5).add(uvAbs.y.mul(0.8660254)))

        const hexPattern = step(float(0.5).add(pulse.oneMinus().mul(thickness.mul(-1))), hexDist)

        return hexPattern
    },
)

const getNoiseValue = Fn(([scale = float(1), speed = float(0.75)]: [scale: Node<'float'>, speed: Node<'float'>]) => {
    // Scale UV coordinates to control noise frequency
    const uvScaled = uv().mul(scale)

    // Animate the noise over time by adding time to the coordinates
    const animatedCoords = uvScaled.add(vec2(time.mul(speed), time.mul(speed)))

    // Sample the built-in MaterialX Perlin/Simplex noise node (returns a float)
    const noiseVal = mx_noise_float(animatedCoords)

    return noiseVal
})

// const loader = new TextureLoader()
// const colorMap: Texture = loader.load(`/texture/grass/Grass007_4K-JPG_Color.jpg`, (d) => {
//     d.repeat.set(1, 1)
//     d.needsUpdate = true
//     d.colorSpace = SRGBColorSpace
//     d.wrapS = d.wrapT = RepeatWrapping
// })
// const roughnessMap: Texture = loader.load(`/texture/grass/Grass007_4K-JPG_Roughness.jpg`, (d) => {
//     d.repeat.set(1, 1)
//     d.needsUpdate = true
//     d.wrapS = d.wrapT = RepeatWrapping
// })
// const normalMap: Texture = loader.load(`/texture/grass/Grass007_4K-JPG_NormalGL.jpg`, (d) => {
//     d.repeat.set(1, 1)
//     d.needsUpdate = true
//     d.wrapS = d.wrapT = RepeatWrapping
// })

export function LoadCollider({ texData = new Map(), objects = [] }) {
    const scene = useThree((r) => r.scene)

    const playerGroup = useGameGlobal((r) => r.playerGroup)

    // const roughnessMap: Texture | null = useMemo(() => {
    //     return getOrCreateTexture('Onyx015_4K-JPG_Roughness.jpg', texData, 'noncolor')
    // }, [texData, texData.size])

    // const normalMap: Texture | null = useMemo(() => {
    //     return getOrCreateTexture('Onyx015_4K-JPG_NormalGL.jpg', texData, 'noncolor')
    // }, [texData, texData.size])

    // Blender version of the 'collider' object. A stable primitive so the attach
    // effect below only re-runs when Blender actually changes the collider —
    // not on every unrelated objects-array push.
    // const colliderVersion = useMemo(() => {
    //     const found = (objects as any[]).find((r: any) => r?.name === 'collider')
    //     return found ? (found.version as string) : null
    // }, [objects])

    // Stable uniforms — mutated every frame / tweened by gsap. The shader nodes
    // in `attach` below capture these same object instances, so animating them
    // (placeOfPlayer via useFrame, uPulseProgress via gsap) drives the shader.
    const placeOfPlayer = useMemo(() => {
        return new Object3D()
    }, [])

    const uPlayerPosition = useMemo(() => {
        return uniform(placeOfPlayer.position, 'vec3')
    }, [])

    const uPulseProgress = useMemo(() => {
        return uniform(0.0, 'float')
    }, [])

    // How far the ring's edge travels. A uniform rather than a constant because
    // the ring *is* the jump's force field, and the field's radius is a live
    // tunable: built once here, kept in step with the store by the frame loop
    // below, so the ring can never claim a reach the field does not have.
    const uFieldRadius = useMemo(() => {
        return uniform(5.0, 'float')
    }, [])

    useFrame(() => {
        // Read live rather than captured in the memo above: the ring's reach is a
        // runtime tunable, and the ring *is* the force field's edge, so it has to
        // pick up a new radius on the same frame the field does.
        uFieldRadius.value = useNavRigStore.getState().settings.forceFieldRadius
        // The pulse is centred on the player, so this is what the shader's
        // `uPlayerPosition` points at — see `circlePulse`.
        if (playerGroup) {
            placeOfPlayer.position.copy(playerGroup.position)
        }
    })

    //

    // Seconds for the ring to reach maxRadius — and, because this is the same
    // second the force field spends sweeping out to the same radius, also how
    // long the jump's wave lasts. One constant for both, so the ring you watch
    // is the wave that pushes; a local copy here is how the two would drift.
    const PULSE_DURATION = FORCE_FIELD_SWEEP_SECONDS
    const playPulse = useCallback(() => {
        console.log('[LoadCollider] pulse triggered') // TEMP debug — remove once visible
        gsap.killTweensOf(uPulseProgress)
        uPulseProgress.value = 0
        gsap.to(uPulseProgress, {
            value: 1,
            duration: PULSE_DURATION,
            // The force field's own curve, by reference — the ring *is* the
            // field's edge, and the wave that shoves the crowd is timed off this
            // same progress. `LoadCollider` used to pass the string `'quat.out'`,
            // which gsap cannot parse: it silently fell back to its default
            // (`power1.out`), so the ring has been rendering on a curve nobody
            // wrote and the field's sweep had to guess at it. This pins the curve
            // down and gives both sides one copy of it.
            ease: forceFieldEase,
            onComplete: () => {
                uPulseProgress.value = 0
            },
        })
    }, [])

    useEffect(() => {
        playPulse()
        return () => {}
    }, [])

    const jumpRequest = useNavRigStore((r) => r.jumpRequest)

    useEffect(() => {
        playPulse()
    }, [jumpRequest?.nonce])

    // useFrame(() => {
    //     scene?.traverse((it: any) => {
    //         // console.log(it)
    //         if (it?.name.includes('collider')) {
    //             it.visible = false
    //         }
    //     })
    // })

    useEffect(() => {
        // const rm = roughnessMap
        // if (!rm) return
        // if (!colliderVersion) return
        // if (!normalMap) {
        //     return
        // }

        let cancelled = false
        let raf = 0
        let cleanup: (() => void)[] = []

        // The 'collider' mesh is created asynchronously by useMeshSync (inside
        // its own useEffect, after this component first renders), so a render-time
        // getObjectByName is always null on mount. Wait for the mesh imperatively —
        // the same pattern LoadEdge and the original LoadCollider use — then build
        // the floor material and assign it directly.
        const attach = (collider: Mesh) => {
            if (!collider.userData.oMaterial) {
                collider.userData.oMaterial = collider.material
            }

            const texScale = 35.0 * 10.0

            // Band widened from 1.0 and the emissive lifted from 5.0 below: the
            // ring is the jump's force field, and it should read as one.
            const pulseMotion = circlePulse(uPlayerPosition, uFieldRadius, float(1.6), uPulseProgress)
            const honeyCombThinBase = getHoneyComb(float(0.0), float(0.02), float(texScale)) as Node<'float'>
            // const noisePattern = getNoiseValue(float(0.05), float(0.25)) as Node<'float'>

            //
            // const normalVec4 = texture(normalMap, uv().mul(texScale))
            // const roughnessVec4 = texture(rm, uv().mul(texScale))
            // const colorValue = texture(colorMap, uv().mul(texScale))

            const mat = new MeshPhysicalNodeMaterial({ userData: { applied: true } })
            // mat.roughnessNode = roughnessVec4.r.oneMinus()
            // mat.metalnessNode = roughnessVec4.r
            // mat.normalNode = normalVec4.rgb.normalize().mul(1.0)
            mat.transparent = true

            mat.emissiveNode = Fn(() => {
                return vec4(
                    vec3(
                        //
                        color('#00E5FF').mul(1.0).rgb,
                        //
                    )
                        .mul(pulseMotion)
                        .mul(honeyCombThinBase)
                        .pow(3)
                        // After the pow, so this scales the band's brightness
                        // without widening it — the ring keeps its hard edge.
                        .mul(9.0),
                    1.0,
                )
            })()

            mat.colorNode = Fn(() => {
                return vec4(
                    //
                    add(
                        //
                        vec3(0.0),
                        // colorValue.rgb,
                        0.0,
                    ),
                    1.0,
                )
            })()

            mat.transparent = true
            mat.side = DoubleSide

            // mat.backdropNode = honeyCombPulse

            collider.receiveShadow = true
            collider.material = mat

            cleanup.push(() => {
                mat.dispose()
                const original = collider.userData.oMaterial
                if (original) {
                    collider.material = original as any
                }
                delete collider.userData.oMaterial
            })
        }

        const tick = () => {
            if (cancelled) return
            const collider = scene.getObjectByName('collider') as Mesh | null
            if (collider) {
                attach(collider)
            } else {
                raf = requestAnimationFrame(tick)
            }
        }

        // When this re-runs (mount, or Blender bumped the collider version) the
        // mesh has usually already been created by useMeshSync in an earlier
        // commit, so attach immediately. Only poll while creation is pending.
        const existing = scene.getObjectByName('collider') as Mesh | null
        if (existing) {
            attach(existing)
        } else {
            raf = requestAnimationFrame(tick)
        }

        return () => {
            cancelled = true
            cancelAnimationFrame(raf)
            cleanup.forEach((fn) => fn())
        }
    }, [scene, placeOfPlayer])

    return <></>
}
