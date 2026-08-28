import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Mesh,  RepeatWrapping, SRGBColorSpace, Texture, TextureLoader } from "three";
import { Fn, vec2, vec4, texture, uv, textureBicubic, reflector, time, float, vec3 } from 'three/tsl';
import { MeshPhysicalNodeMaterial } from "three/webgpu";
import { getOrCreateTexture } from "../utils/meshBuilder";

export function LoadReflection ({ texData = new Map(), objects = [] }) {
    const scene = useThree((r) => r.scene);

    const done = useMemo(() =>{
        return new Map()
    }, [])

    useEffect(() => {
        let cleans: (() => void)[] = []
        let onClean = (v: () => void) => {
            cleans.push(v)
        }
        let run = async () =>{

            if (done.get("collider")) {
                return
            }            
            //
            let collider = await new Promise<Mesh>((resolve) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName("collider")
                    if(obj){
                        clearInterval(interval)
                        resolve(obj as Mesh)
                    }
                }, 1)
            });

            if(collider?.material){
                if (!collider.userData.oMaterial) {
                    collider.userData.oMaterial =  collider.material
                }

                const reflection = reflector( { resolutionScale: .5, bounces: false, generateMipmaps: true } ); // 0.5 is half of the rendering view
				reflection.target.rotateX( -Math.PI / 2 );
				scene.add( reflection.target );

                onClean(() =>{
                    reflection.dispose()
                })

                onClean(() =>{
                    reflection.target.removeFromParent()
                })

				const animatedUV = uv().mul( 2 ).add( vec2( time.mul( .1 ), 0 ) );

                const roughnessMap = await new TextureLoader().loadAsync(`/texture/perlin.png`)
                roughnessMap.repeat.set(0.2,0.2)
                roughnessMap.wrapS = RepeatWrapping;
                roughnessMap.wrapT = RepeatWrapping;
                roughnessMap.colorSpace = SRGBColorSpace;

                const roughness = texture( roughnessMap, animatedUV ).r.mul( 1.0 ).saturate();

                const materail = new MeshPhysicalNodeMaterial().copy(collider.userData.oMaterial as MeshPhysicalNodeMaterial)
                materail.transparent = true;
                materail.metalnessNode = float(1.0)
                materail.roughnessNode = roughness.r.mul( .2 );

                onClean(() => {
                    materail.dispose()
                })

                materail.colorNode = Fn( () => {
                    const dirtyReflection = textureBicubic( reflection, roughness.rrr.mul( 1.5 ) );
                    const opacity = 0.99;

                    return vec4( dirtyReflection.rgb, opacity );

                } )();

                collider.material = materail

                done.set('collider', true)
            }
        }


        run()
        return () =>{
            cleans.forEach((cl) =>{
                cl()
            })
        }
    }, [objects, texData]);

     useEffect(() => {
        let cleans: (() => void)[] = []
        let onClean = (v: () => void) => {
            cleans.push(v)
        }
        let run = async () =>{

            if (done.get("edge")) {
                return
            }            

            let edge = await new Promise<Mesh>((resolve) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName("edge")
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

//


// 