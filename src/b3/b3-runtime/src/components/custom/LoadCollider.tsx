import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Mesh,  RepeatWrapping, SRGBColorSpace, TextureLoader } from "three";
import { Fn, vec2 , mx_noise_float, vec4, texture, uv, textureBicubic, reflector, time, vec3, float, select, lessThan, abs, max, step, uniform, sin, color } from 'three/tsl';
import { MeshPhysicalNodeMaterial, Node } from "three/webgpu";
import { useGameGlobal } from "../../../../../components/useGameGlobal";
//
// import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
//
import {  positionWorld,  distance,  smoothstep, mod } from 'three/tsl';

// Define the TSL function taking a character position vector, speed, and max radius
const circlePulse: (a: Node<"vec3">, b : Node<"float">,c: Node<"float">) => Node<"float"> = Fn(([characterPos, speed, maxRadius]: any) => {
    // Calculate distance on the XZ plane (ground) from the character uniform
    const dist = distance(positionWorld.xz, characterPos.xz);
    
    // Create an expanding radius that loops using mod
    const radius = mod(time.mul(speed), maxRadius);
    
    // Calculate distance from the current ring edge
    const ringDist = abs(dist.sub(radius));
    
    // Sharpness/width of the pulse line (1.0 width with smooth edges)
    const intensity = smoothstep(1.0, 0.0, ringDist);
    
    // Fade out the pulse as it reaches maxRadius
    const fade = smoothstep(maxRadius, maxRadius.mul(0.6), radius);
    
    return intensity.mul(fade);
}) as any;

 const getHoneyComb: (p: Node<"float">, r: Node<"float">) => Node<"float"> = Fn(([pulse = float(1.0), thickness = float(0.125)]: any) => {
    const p = uv().mul(10.0);
    
    const r = vec2(1.0, 1.7320508); // vec2(1.0, sqrt(3))
    const h = r.mul(0.5);
    
    const a = p.mod(r).sub(h);
    const b = p.sub(h).mod(r).sub(h);
                
    
    const gv = select(lessThan(a.dot(a), b.dot(b)), a, b);
    
    const uvAbs = abs(gv);
    const hexDist = max(uvAbs.x, uvAbs.x.mul(0.5).add(uvAbs.y.mul(0.8660254)));
    
    const hexPattern = step(float(0.5).add(pulse.oneMinus().mul(thickness.mul(-1))), hexDist);

    return hexPattern;
});


const getNoiseValue = Fn(() => {
    // Scale UV coordinates to control noise frequency
    const uvScaled = uv().mul(1.0);
    
    // Animate the noise over time by adding time to the coordinates
    const animatedCoords = uvScaled.add(vec2(time.mul(0.75), time.mul(0.75)));
    
    // Sample the built-in MaterialX Perlin/Simplex noise node (returns a float)
    const noiseVal = mx_noise_float(animatedCoords);

    return noiseVal
});


export function LoadCollider ({ texData = new Map(), objects = [] }) {
    const scene = useThree((r) => r.scene);

    const done = useMemo(() =>{
        return new Map()
    }, [])

    const playerGroup = useGameGlobal((r)=>r.playerGroup)

    const normalMapData = useMemo(() => {
        return texData.get("Chip005_4K-PNG_NormalGL.png")
    }, [texData])

    const roughnessMapData = useMemo(() => {
        return texData.get("Chip003_4K-PNG_Roughness.png")
    }, [texData])

    useEffect(() => {
        if (!playerGroup) {
            return
        }
        let cleans: (() => void)[] = []
        let onClean = (v: () => void) => {
            cleans.push(v)
        }
        let run = async () => {
            const name = 'collider'
            let colliderInfo = objects.find((r: any)=>{
                return r.name === name
            }) as any || {version: '0'};

            let sig = `${colliderInfo?.version}${JSON.stringify([objects])}`
            if (done.get(name) === sig) {
                return
            }            

            let collider = await new Promise<Mesh>((resolve) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName(name)
                    if(obj){
                        clearInterval(interval)
                        resolve(obj as Mesh)
                    }
                }, 1)
            });

            if(collider?.material && normalMapData && roughnessMapData){
                if (!collider.userData.oMaterial) {
                    collider.userData.oMaterial =  collider.material
                }
                const reflection = reflector( { resolutionScale: .5, bounces: false, generateMipmaps: true } ); // 0.5 is half of the rendering view
				reflection.target.rotateX( - Math.PI / 2 );
				scene.add( reflection.target );
                onClean(() =>{
                    reflection.target.removeFromParent()
                })

                const textureLoader = new TextureLoader();

                const normalMap = textureLoader.load(
                    URL.createObjectURL(new Blob([normalMapData.bytes], {type: normalMapData.mime})) 
                );
				normalMap.wrapS = RepeatWrapping;
				normalMap.wrapT = RepeatWrapping;
				normalMap.colorSpace = SRGBColorSpace;

                const roughnessMap = textureLoader.load(
                    URL.createObjectURL(new Blob([roughnessMapData.bytes], {type: roughnessMapData.mime})) 
                );
				roughnessMap.wrapS = RepeatWrapping;
				roughnessMap.wrapT = RepeatWrapping;
				roughnessMap.colorSpace = SRGBColorSpace;

                const animatedUV = uv().mul( 1 ).add( vec2( 0, time.mul( 0.0 ) ) );

				// const normlTexture = texture( normalMap, animatedUV )
				const roughnessTexture = texture( roughnessMap, animatedUV ).r.mul( 1.0 ).saturate();

				const floorMaterial = new MeshPhysicalNodeMaterial();
                // floorMaterial.normalNode = normlTexture.negate();
                floorMaterial.transparent = true;
				floorMaterial.metalnessNode = float(roughnessTexture).oneMinus();
				floorMaterial.roughnessNode = roughnessTexture;

				floorMaterial.colorNode = Fn( () => {
					const dirtyReflection = textureBicubic( reflection, roughnessTexture );

                    const uPlayerPosition = uniform(playerGroup.position, 'vec3');

                    const pulseMotion = circlePulse(uPlayerPosition, float(5.0), float(10.0));

                    const honeyCombPulse = getHoneyComb(pulseMotion, float(0.1)) as Node<"float">;

                    const noiseUV = getNoiseValue() as Node<"float">;

                    const honeyCombBase = getHoneyComb(float(0.0), float(0.015)) as Node<"float">;

                    const honeyCombThinBase = getHoneyComb(float(0.0), float(0.005)) as Node<"float">;

					return vec4(dirtyReflection.rgb.add(honeyCombThinBase.mul(noiseUV.mul(0.5)).mul(color('#f8ffae'))), float(honeyCombPulse).mul(float(pulseMotion)).oneMinus().add(honeyCombBase.mul(noiseUV.mul(2))) );
				} )();

                floorMaterial.transparent = true

                collider.material = floorMaterial
                
                done.set(name,  `${colliderInfo?.version}${JSON.stringify([objects])}`)
            }
        }

        run()
        return () =>{
            cleans.forEach((cl) =>{
                cl()
            })
        }
    }, [playerGroup, objects, normalMapData, roughnessMapData]);

    useEffect(() => {
        let cleans: (() => void)[] = []
        let onClean = (v: () => void) => {
            cleans.push(v)
        }
        let run = async () =>{
            const name = 'edge'

            let colliderInfo = objects.find((r: any)=>{
                return r.name === name
            }) as any;

            if (done.get(name) === colliderInfo?.version) {
                return
            }             

            let edge = await new Promise<Mesh>((resolve) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName(name)
                    if(obj){
                        clearInterval(interval)
                        resolve(obj as Mesh)
                    }
                }, 1)
            });

            if(edge){
                const edgeMat = new MeshPhysicalNodeMaterial()
                edgeMat.emissiveNode = Fn( () => {
                    return vec3(1.0,1.0,0.0).mul(0.15)
                } )();

                onClean(() =>{
                    edgeMat.dispose()
                })
                
                edge.material = edgeMat
                done.set(name, colliderInfo?.version)
            }
        }


        run()
        return () =>{
            cleans.forEach((cl) =>{
                cl()
            })
        }
    }, [objects, texData]);

    return <>
    </>;
}

