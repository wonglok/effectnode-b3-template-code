import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Mesh } from "three";
import { Fn, vec3 } from 'three/tsl';
import { MeshPhysicalNodeMaterial } from "three/webgpu";
// import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';

export function LoadEdge ({ texData = new Map(), objects = [] }) {
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