import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { Mesh,  RepeatWrapping, SRGBColorSpace, TextureLoader } from "three";
import { Fn, vec2, vec4, texture, uv, textureBicubic, rangeFogFactor, reflector, time, float, vec3 } from 'three/tsl';
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";

export function LoadReflection ({  objects = [] }) {
    const scene = useThree((r) => r.scene);

    useEffect(() => {
        let cleans: (() => void)[] = []
        let onClean = (v: () => void) => {
            cleans.push(v)
        }
        let run = async () =>{
            //
            let collider = await new Promise<Mesh>((resolve, reject) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName("collider")
                    if(obj){
                        clearInterval(interval)
                        resolve(obj as Mesh)
                    }
                }, 1)
            });


            let edge = await new Promise<Mesh>((resolve, reject) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName("edge")
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
                    reflection.dispose()
                })

                onClean(() =>{
                    reflection.target.removeFromParent()
                })

				const animatedUV = uv().mul( 2 ).add( vec2( time.mul( .1 ), 0 ) );
				const textureLoader = new TextureLoader();

				const perlinMap = textureLoader.load( '/texture/perlin.png' );
				perlinMap.wrapS = RepeatWrapping;
				perlinMap.wrapT = RepeatWrapping;
				perlinMap.colorSpace = SRGBColorSpace;

				const roughness = texture( perlinMap, animatedUV ).r.mul( 1 ).saturate();

				const floorMaterial = new MeshPhysicalNodeMaterial().copy(collider.userData.oMaterial as MeshPhysicalNodeMaterial)
				floorMaterial.transparent = true;
				floorMaterial.metalnessNode = float(0.2)
                floorMaterial.roughnessNode = roughness.r.mul( .2 );

                onClean(() =>{
                    floorMaterial.dispose()
                })

                floorMaterial.colorNode = Fn( () => {

					const dirtyReflection = textureBicubic( reflection, roughness.rrr.mul( .9 ) );

					const opacity = rangeFogFactor( 1, 35 ).oneMinus();

					return vec4( dirtyReflection.rgb, opacity );

				} )();

                collider.material = floorMaterial


                const edgeMat = new MeshPhysicalNodeMaterial()
                    
                edgeMat.colorNode = Fn( () => {

                    return vec3(1.0,1.0,0.0)

				} )();
                edgeMat.emissiveNode = Fn( () => {

                    return vec3(1.0,1.0,0.0).mul(0.1)

				} )();

                edge.material = edgeMat

            }

        }
        run()
        return () =>{
            cleans.forEach(cl =>{
                cl()
            })
        }
    }, [objects, scene]);

    return <>
    </>;
}
