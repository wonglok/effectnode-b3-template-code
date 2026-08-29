import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Mesh,  RepeatWrapping, SRGBColorSpace, TextureLoader } from "three";
import { Fn, vec2, vec4, texture, uv, textureBicubic, reflector, time, vec3, rangeFogFactor } from 'three/tsl';
import { MeshPhysicalNodeMaterial } from "three/webgpu";
// import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';

export function LoadCollider ({ texData = new Map(), objects = [] }) {
    const scene = useThree((r) => r.scene);

    const done = useMemo(() =>{
        return new Map()
    }, [])

    useEffect(() => {
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

            // console.log()
            let collider = await new Promise<Mesh>((resolve) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName(name)
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
				reflection.target.rotateX( - Math.PI / 2 );
				scene.add( reflection.target );
                onClean(() =>{
                    reflection.target.removeFromParent()
                })

                const textureLoader = new TextureLoader();
                const perlinMap = textureLoader.load( '/texture/perlin.png' );
				perlinMap.wrapS = RepeatWrapping;
				perlinMap.wrapT = RepeatWrapping;
				perlinMap.colorSpace = SRGBColorSpace;


                const animatedUV = uv().mul( 2 ).add( vec2( time.mul( .1 ), 0 ) );
				const roughness = texture( perlinMap, animatedUV ).r.mul( 2 ).saturate();

				const floorMaterial = new MeshPhysicalNodeMaterial();
                floorMaterial.copy(collider.userData.oMaterial)

                floorMaterial.transparent = true;
				floorMaterial.metalness = 0.5;
				floorMaterial.roughnessNode = roughness.mul( 1.0 );
				floorMaterial.colorNode = Fn( () => {

					// blur reflection using textureBicubic()
					const dirtyReflection = textureBicubic( reflection, roughness.mul( 1.9 ) );

					// falloff opacity by distance like an opacity-fog
					const opacity = rangeFogFactor( 3, 25 ).oneMinus();

					return vec4( dirtyReflection.rgb, opacity );

				} )();

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
    }, [objects, texData]);

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

//


// 