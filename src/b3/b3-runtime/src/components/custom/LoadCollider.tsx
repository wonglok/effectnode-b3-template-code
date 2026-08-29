import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Mesh,  RepeatWrapping, SRGBColorSpace, TextureLoader } from "three";
import { Fn, vec2, vec4, texture, uv, textureBicubic, reflector, time, vec3, float } from 'three/tsl';
import { MeshPhysicalNodeMaterial } from "three/webgpu";
//
// import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
//

export function LoadCollider ({ texData = new Map(), objects = [] }) {
    const scene = useThree((r) => r.scene);

    const done = useMemo(() =>{
        return new Map()
    }, [])

    const normalMapData = useMemo(() => {
        return texData.get("Chip005_4K-PNG_NormalGL.png")
    }, [texData])

    const roughnessMapData = useMemo(() => {
        return texData.get("Chip003_4K-PNG_Roughness.png")
    }, [texData])

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

                const animatedUV = uv().mul( 1 ).add( vec2( 0, time.mul( -0.01 ) ) );

				const normlTexture = texture( normalMap, animatedUV ).r.mul( 1.0 ).saturate();
				const roughnessTexture = texture( roughnessMap, animatedUV ).r.mul( 1.0 ).saturate();

				const floorMaterial = new MeshPhysicalNodeMaterial();

                floorMaterial.transparent = true;
				floorMaterial.metalnessNode = float(normlTexture);
				floorMaterial.roughnessNode = roughnessTexture;
                
				floorMaterial.colorNode = Fn( () => {
					const dirtyReflection = textureBicubic( reflection, normlTexture );

					return vec4( dirtyReflection.rgb, 0.95 );
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
    }, [objects, normalMapData, roughnessMapData]);

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