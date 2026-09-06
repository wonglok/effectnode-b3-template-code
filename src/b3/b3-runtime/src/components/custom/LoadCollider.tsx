import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { MathUtils, Mesh, RepeatWrapping, SRGBColorSpace, Vector3 } from 'three'
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
import { MeshPhysicalNodeMaterial, Node } from 'three/webgpu'
import { useGameGlobal } from '../../../../../components/useGameGlobal'
//
// import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
//
import { positionWorld, distance, smoothstep, mod } from 'three/tsl'
import { getOrCreateTexture } from '../utils/meshBuilder'

// Define the TSL function taking a character position vector, speed, and max radius
const circlePulse: (time: Node<'float'>, a: Node<'vec3'>, b: Node<'float'>, c: Node<'float'>) => Node<'float'> = Fn(
    ([time, characterPos, speed, maxRadius]: any) => {
        // Calculate distance on the XZ plane (ground) from the character uniform
        const dist = distance(positionWorld.xz, characterPos.xz)

        // Create an expanding radius that loops using mod
        const radius = mod(time.mul(speed), maxRadius)

        // Calculate distance from the current ring edge
        const ringDist = abs(dist.sub(radius))

        // Sharpness/width of the pulse line (1.0 width with smooth edges)
        const intensity = smoothstep(1.0, 0.0, ringDist)

        // Fade out the pulse as it reaches maxRadius
        const fade = smoothstep(maxRadius, maxRadius.mul(0.25), radius)

        return intensity.mul(fade)
    },
) as any

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

    const done = useMemo(() => {
        return new Map()
    }, [])

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
    const roughnessMap = useMemo(() => {
        return getOrCreateTexture('Chip003_4K-PNG_Roughness.png', texData, 'noncolor')
    }, [texData, texData.size, texData.values()])

    const reflection = useMemo(() => {
        const reflection = reflector({ resolutionScale: 1.0, bounces: true, generateMipmaps: true }) // 0.5 is half of the rendering view
        reflection.target.rotateX(-Math.PI / 2)

        return reflection
    }, [])

    const loops: any[] = useMemo(() => {
        return []
    }, [])
    useEffect(() => {
        return () => {
            loops.splice(0, loops.length)
        }
    }, [])

    useFrame((_, dt) => {
        if (playerGroup) {
            reflection?.target?.position?.copy(playerGroup?.position)
        }
        loops.forEach((t: any) => t(_, dt))
    })

    let onLoop = (v: any) => {
        loops.push(v)
    }

    useEffect(() => {
        if (!playerGroup) {
            return
        }

        if (!roughnessMap) {
            return
        }

        let cleans: (() => void)[] = []
        let onClean = (v: () => void) => {
            cleans.push(v)
        }

        let run = async () => {
            const name = 'collider'
            let colliderInfo = objects.find((r: any) => {
                return r.name === name
            }) as any

            let getSig = () => `${JSON.stringify(colliderInfo?.version)}${JSON.stringify([objects, roughnessMap.uuid])}`

            let sig = getSig()

            if (done.get(name) === sig) {
                return
            }
            scene.add(reflection.target)
            onClean(() => {
                reflection.target.removeFromParent()
            })

            let collider = await new Promise<Mesh>((resolve) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName(name)
                    if (obj) {
                        clearInterval(interval)
                        resolve(obj as Mesh)
                    }
                }, 1)
            })

            if (collider && roughnessMap) {
                if (!collider.userData.oMaterial) {
                    collider.userData.oMaterial = collider.material
                }

                roughnessMap.wrapS = RepeatWrapping
                roughnessMap.wrapT = RepeatWrapping
                roughnessMap.colorSpace = SRGBColorSpace

                const roughnessTexture = texture(roughnessMap, uv())

                const floorMaterial = new MeshPhysicalNodeMaterial()
                floorMaterial.metalnessNode = roughnessTexture.r.oneMinus()
                floorMaterial.roughnessNode = roughnessTexture.r

                floorMaterial.transparent = true

                const accumulate = uniform(1, 'float')
                const placeOfPlayer = new Vector3()
                onLoop(() => {
                    placeOfPlayer.copy(playerGroup.position)
                })

                const uPlayerPosition = uniform(placeOfPlayer, 'vec3')
                const pulseMotion = circlePulse(accumulate.add(time), uPlayerPosition, float(2.5), float(7.0))
                const honeyCombThinBase = getHoneyComb(float(0.0), float(0.015)) as Node<'float'>

                floorMaterial.emissiveNode = Fn(() => {
                    const honeyCombPulse = getHoneyComb(pulseMotion, float(0.015)) as Node<'float'>

                    return vec4(
                        vec3(
                            //
                            color('#ffff00').rgb,
                        )
                            .mul(honeyCombThinBase)
                            .mul(honeyCombPulse.oneMinus()),
                        float(10.0),
                    )
                })()

                floorMaterial.colorNode = Fn(() => {
                    //

                    const reflectionNode = textureBicubic(
                        reflection,
                        pulseMotion.mul(roughnessTexture.r.oneMinus()),
                    ).rgb

                    const honeyCombPulse = getHoneyComb(pulseMotion, float(0.025)) as Node<'float'>

                    const noiseUV = getNoiseValue(float(1.5), float(0.35)) as Node<'float'>

                    const honeyCombBase = getHoneyComb(float(0.0), float(0.005)) as Node<'float'>

                    done.set(name, `${colliderInfo?.version}${JSON.stringify([objects])}`)

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

                floorMaterial.transparent = true

                done.set(name, getSig())

                collider.material = floorMaterial
            }
        }

        run()
        return () => {
            cleans.forEach((cl) => {
                cl()
            })
        }
    }, [playerGroup, objects, roughnessMap])

    return <></>
}
