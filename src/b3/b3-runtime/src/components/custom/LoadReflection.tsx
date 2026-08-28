import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { Mesh,  RepeatWrapping, SRGBColorSpace, TextureLoader } from "three";
import { Fn, vec2, vec4, texture, uv, textureBicubic, rangeFogFactor, reflector, time } from 'three/tsl';
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
            let object3D = await new Promise<Mesh>((resolve, reject) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName("collider")
                    if(obj){
                        clearInterval(interval)
                        resolve(obj as Mesh)
                    }
                }, 100)
            })

            if(object3D?.material){


                const reflection = reflector( { resolutionScale: .5, bounces: false, generateMipmaps: true } ); // 0.5 is half of the rendering view
				reflection.target.rotateX( - Math.PI / 2 );
				scene.add( reflection.target );

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

				const floorMaterial = new MeshPhysicalNodeMaterial().copy(object3D.material as MeshPhysicalNodeMaterial)
				floorMaterial.transparent = true;
				floorMaterial.colorNode = Fn( () => {

					// blur reflection using textureBicubic()
					const dirtyReflection = textureBicubic( reflection, roughness.mul( .9 ) );

					// falloff opacity by distance like an opacity-fog
					const opacity = rangeFogFactor( 7, 25 ).oneMinus();

					return vec4( dirtyReflection.rgb, opacity );

				} )();

                object3D.material = floorMaterial

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
