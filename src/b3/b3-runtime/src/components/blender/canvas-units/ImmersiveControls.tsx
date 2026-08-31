import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Object3D, Spherical } from "three";

export function ImmersiveControls ({ player = new Object3D() }) {
    const camera = useThree((r) => {
        return r.camera
    });

    console.log(camera);

    const spherical = useMemo(() => {
        return new Spherical(10, 0, 0) 
    }, [])
    const orbit = useMemo(() => {
        return new Object3D() 
    }, [])

    const polarAngle = useRef(30)
    const azAngle = useRef(0)
    
     // ------------------------------------------------------------------
    // Input
    // ------------------------------------------------------------------
    const input = useMemo(() =>{

        return {
            forward: false,
            back: false,
            left: false,
            right: false,
            sprint: false,
        };
    },[])

    useEffect(() =>{
        
    }, [])


    useEffect(() =>{

        const handleKeyDown = (event: KeyboardEvent) => {
            switch (event.key) {
                case "ArrowUp":
                // case "KeyW":
                input.forward = true;
                break;
                case "ArrowDown":
                // case "KeyS":
                input.back = true;
                break;
                case "ArrowLeft":
                // case "KeyA":
                input.left = true;
                break;
                case "ArrowRight":
                // case "KeyD":
                input.right = true;
                break;
                // case "ShiftLeft":
                // case "ShiftRight":
                // input.sprint = true;
                // break;
            }
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            switch (event.key) {
                case "ArrowUp":
                // case "KeyW":
                input.forward = false;
                break;
                case "ArrowDown":
                // case "KeyS":
                input.back = false;
                break;
                case "ArrowLeft":
                // case "KeyA":
                input.left = false;
                break;
                case "ArrowRight":
                // case "KeyD":
                input.right = false;
                break;
                // case "ShiftLeft":
                // case "ShiftRight":
                // input.sprint = false;
                // break;
            }
        };

        const handleWheel = (event: WheelEvent) => {
            spherical.radius +=  event.deltaY / 75

            if (spherical.radius <= 4) {
                spherical.radius += event.deltaY / 75 * -1
            }
            if (spherical.radius >= 150) {
                spherical.radius += event.deltaY / 75 * -1
            }
        };
        window.addEventListener("wheel", handleWheel);
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);

        return () => {
            window.removeEventListener("wheel", handleWheel);
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        }
    }, [])

    useFrame((_,dt) => {
        //

        console.log(input)
        if (input.back) {
            polarAngle.current += dt * 33.33
        }   
        if (input.forward) {
            polarAngle.current += dt * -33.33
        }
        if (input.left) {
            azAngle.current += dt * 33.33
        }   
        if (input.right) {
            azAngle.current += dt * -33.33
        }
        
        camera.position.copy(player.position)
        spherical.makeSafe()
        spherical.set(spherical.radius,Math.PI / 180 * polarAngle.current, Math.PI / 180 * azAngle.current)
        orbit.position.setFromSpherical(spherical)
        camera.position.add(orbit.position)
        camera.lookAt(
            player.position.x,player.position.y + 1.2,player.position.z
        )

        //
    })


    return <>
        {/*  */}


        <group>
            {/*  */}

            

            {/*  */}
        </group>
        {/*  */}
    </>
}