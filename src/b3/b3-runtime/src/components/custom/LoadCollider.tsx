import { createPortal, extend, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { Mesh, MeshBasicMaterial, NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture, Vector3 } from 'three'
import {
    Fn,
    vec2,
    mx_noise_float,
    vec4,
    texture,
    uv,
    textureBicubic,
    reflector,
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
} from 'three/tsl'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, Node } from 'three/webgpu'
import gsap from 'gsap'
import { useGameGlobal } from '../../../../../components/useGameGlobal'
// import { useNavRigStore } from '../stores/navRigStore'
//
// import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
//
import { positionWorld, distance, smoothstep } from 'three/tsl'
import { getOrCreateTexture } from '../utils/meshBuilder'
import { useNavRigStore } from '../stores/navRigStore'

extend({
    MeshStandardNodeMaterial,
})

// MeshStandardNodeMaterial lives in the three/webgpu namespace, which R3F's
// JSX element map (built from `three`) doesn't include — so declare the element
// type. Base props reuse the plain meshStandardMaterial element; node props
// (emissiveNode/colorNode/…) ride on the standard material's type set.
declare module '@react-three/fiber' {
    interface ThreeElements {
        meshStandardNodeMaterial: ThreeElements['meshStandardMaterial']
    }
}

const circlePulse: (
    characterPos: Node<'vec3'>,
    maxRadius: Node<'float'>,
    thickness: Node<'float'>,
    progress: Node<'float'>,
) => Node<'float'> = Fn(([characterPos, maxRadius, thickness = float(1), progress = float(0)]: any) => {
    // Ground-plane distance from the character (XZ — the ring lives on the floor)
    const dist = distance(positionWorld.xz, characterPos.xz)

    // Ring edge travels outwards from the character (progress 0) to maxRadius (1)
    const radius = maxRadius.mul(progress)

    // How far this fragment is from the ring edge
    const ringDist = abs(dist.sub(radius))

    // The pulse is a band `thickness` world-units wide on each side of the ring
    // edge, with smooth (not hard) edges. thickness = 1.0 reproduces the old look.
    const band = smoothstep(thickness, 0.0, ringDist)

    // Envelope, expressed on progress ([0,1]) so it's invariant to maxRadius:
    // fade in over the first 8% of the sweep (so progress 0 does not park a
    // bright dot under the character) and fade out over the last 10% so the
    // one-shot sweep ends cleanly instead of clipping mid-travel.
    const fadeIn = smoothstep(0.0, 0.08, progress)
    const fadeOut = float(1.0).sub(smoothstep(0.9, 1.0, progress))

    return band.mul(fadeIn).mul(fadeOut)
}) as any

const getHoneyComb: (p: Node<'float'>, r: Node<'float'>) => Node<'float'> = Fn(
    ([pulse = float(1.0), thickness = float(0.125)]: any) => {
        const p = uv().mul(10.0)

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

export function LoadCollider({ texData = new Map(), objects = [] }) {
    const scene = useThree((r) => r.scene)

    const playerGroup = useGameGlobal((r) => r.playerGroup)

    const tasks: any = useMemo(() => {
        return {}
    }, [])

    useFrame((_, dt) => {
        Object.values(tasks).map((tsk: any) => {
            if (typeof tsk === 'function') {
                tsk(_, dt)
            }
        })
    })
    const roughnessMap: Texture = useMemo(() => {
        return getOrCreateTexture('Chip003_4K-PNG_Roughness.png', texData) as Texture
    }, [texData, texData.size, objects])

    const loops: { tasks: any[] } = useMemo(() => {
        return { tasks: [] }
    }, [])

    useFrame((_, dt) => {
        loops.tasks.forEach((t: any) => t(_, dt))
    })

    const collider = scene.getObjectByName('collider') as Mesh<any, MeshPhysicalNodeMaterial>

    const reflection = useMemo(() => {
        return reflector({
            depth: false,
            samples: 1,
            resolutionScale: 1,
            bounces: false,
            generateMipmaps: true,
        })
    }, [])

    useEffect(() => {
        // 0.5 is half of the rendering view

        reflection.target.rotateX(-Math.PI / 2)

        scene.add(reflection.target)
        return () => {
            reflection.target.removeFromParent()
            reflection.dispose()
        }
    }, [])

    useFrame(() => {
        if (playerGroup) {
            reflection?.target?.position?.copy(playerGroup?.position)
        }
    })

    const roughnessTexture = useMemo(() => {
        let roughnessTexture = texture(roughnessMap, uv())
        return roughnessTexture
    }, [roughnessMap])

    // const accumulate = uniform(1, 'float')
    const placeOfPlayer = useMemo(() => {
        return new Vector3()
    }, [])

    useFrame(() => {
        if (playerGroup) {
            placeOfPlayer.copy(playerGroup.position)
        }
    })

    const uPlayerPosition = useMemo(() => {
        return uniform(placeOfPlayer, 'vec3')
    }, [])

    const uPulseProgress = useMemo(() => {
        return uniform(0.0, 'float')
    }, [])

    const pulseMotion = useMemo(() => {
        return circlePulse(uPlayerPosition, float(7.7), uPulseProgress.oneMinus(), uPulseProgress)
    }, [])

    const honeyCombThinBase = useMemo(() => {
        return getHoneyComb(float(0.0), float(0.015)) as Node<'float'>
    }, [])

    const colorNode = useMemo(() => {
        return Fn(() => {
            //

            const reflectionNode = textureBicubic(reflection, pulseMotion.mul(roughnessTexture.r.oneMinus())).rgb

            const honeyCombPulse = getHoneyComb(pulseMotion, float(0.025)) as Node<'float'>

            const noiseUV = getNoiseValue(float(1.5), float(0.35)) as Node<'float'>

            const honeyCombBase = getHoneyComb(float(0.0), float(0.005)) as Node<'float'>

            return vec4(
                //
                reflectionNode.rgb.add(
                    //
                    honeyCombThinBase
                        .mul(
                            //
                            noiseUV.mul(1.5),
                        )
                        .mul(
                            //
                            color('#ffff00'),
                        ),
                ),
                float(
                    //
                    honeyCombPulse.mul(1.5),
                )
                    .mul(float(pulseMotion))
                    .oneMinus()
                    .add(
                        //
                        honeyCombBase.mul(
                            //
                            noiseUV.mul(2),
                        ),
                    ),
            )
        })()
    }, [])

    const emissiveNode = useMemo(() => {
        return Fn(() => {
            const honeyCombPulse = getHoneyComb(pulseMotion, float(0.015)) as Node<'float'>

            return vec4(
                vec3(
                    //
                    color('#ff7b00').rgb,
                    //
                )
                    .mul(honeyCombThinBase)
                    .mul(honeyCombPulse.oneMinus())
                    .mul(pulseMotion),
                float(1.0),
            )
        })()
    }, [])

    const roughnessNode = useMemo(() => {
        return Fn(() => {
            return roughnessTexture.r.oneMinus()
        })()
    }, [roughnessTexture, roughnessTexture.needsUpdate])

    const metalnessNode = useMemo(() => {
        return Fn(() => {
            return roughnessTexture.r
        })()
    }, [roughnessTexture, roughnessTexture.needsUpdate])

    useEffect(() => {
        const PULSE_DURATION = 1.0 // seconds for the ring to reach maxRadius
        const playPulse = () => {
            console.log('[LoadCollider] pulse triggered') // TEMP debug — remove once visible
            gsap.killTweensOf(uPulseProgress)
            uPulseProgress.value = 0
            gsap.to(uPulseProgress, {
                value: 1,
                duration: PULSE_DURATION,
                ease: 'sine.inOut', // slow out of the centre and into the edge
                onComplete: () => {
                    uPulseProgress.value = 0
                },
            })
        }
        playPulse()

        return () => {
            gsap.killTweensOf(uPulseProgress)
        }
    }, [])

    //

    return (
        <>
            {collider &&
                roughnessMap &&
                createPortal(
                    <meshStandardNodeMaterial
                        //
                        transparent
                        colorNode={colorNode}
                        emissiveNode={emissiveNode}
                        roughnessNode={roughnessNode}
                        metalnessNode={metalnessNode}
                    ></meshStandardNodeMaterial>,
                    collider,
                )}
        </>
    )
}
