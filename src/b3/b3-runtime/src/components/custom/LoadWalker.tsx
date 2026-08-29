import { useThree } from "@react-three/fiber";
import { useEffect, useMemo } from "react";
import { Group, Mesh, Object3D, RepeatWrapping, SRGBColorSpace, TextureLoader } from "three";
import { float, Fn, texture, time, uv, vec2, vec3 } from 'three/tsl';
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from "three/webgpu";
import { BlenderObject } from "../types/blenderTypes";
// import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';


const texArrow = new TextureLoader().load(`/texture/arrows@1x.png`);
texArrow.generateMipmaps = false
texArrow.colorSpace= SRGBColorSpace
texArrow.wrapS = texArrow.wrapT = RepeatWrapping
const colorNode = texture(texArrow, uv().add(vec2(float(0.0).add(time.mul(-0.01)), float(0.25))));


export function LoadWalker ({ texData = new Map(), objects = [] }) {
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
            const name = 'guide'

            let info = objects.find((r: any)=>{
                return r.name === name
            }) as any;

            if (done.get(name) === info?.version && typeof done.get(name) !== 'undefined')  {
                return
            }             

            let found = await new Promise<Group>((resolve) => {
                let interval = setInterval(() => {
                    let obj = scene.getObjectByName(name)
                    if(obj){
                        clearInterval(interval)
                        resolve(obj as Group)
                    }
                }, 1)
            });

            if(found){
                found.traverse((it: Object3D | Mesh | any) => {
                    if(it && it?.material) {
                      
                        it.material = new MeshStandardNodeMaterial({
                            colorNode: colorNode
                        })
                    }
                })
                done.set(name, info?.version)
            }
        }


        run()
        return () =>{
            cleans.forEach((cl) =>{
                cl()
            })
        }
    }, [objects, texData]);

//
    return <>
    </>;
}

//


// 