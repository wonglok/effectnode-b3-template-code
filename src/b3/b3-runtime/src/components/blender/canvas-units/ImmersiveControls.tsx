import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { Object3D, Vector3 } from "three";

// Zoom orbit radius limits (world units from the player). 0.5 lets the camera
// get very close to the character.
const MIN_ZOOM_DISTANCE = 0.5;
const MAX_ZOOM_DISTANCE = 250;
// The camera orbits / looks at a focus point this high above the player's feet —
// roughly the character's centre, so zooming in keeps the body framed.
const CAMERA_TARGET_Y = 0.85;

export function ImmersiveControls ({ player = new Object3D() }) {
    const camera = useThree((r) => {
        return r.camera
    });
    const gl = useThree((r) => {
        return r.gl
    });

    console.log(camera);

    const spherical = useMemo(() => {
        return player.userData.spherical
    }, [player])
    
    const orbit = useMemo(() => {
        return new Object3D()
    }, [])
    // Reused focus point the camera orbits around and looks at each frame.
    const focus = useMemo(() => new Vector3(), [])

    const polarAngle = useRef(30)
    const azAngle = useRef(0)

    // --- Joystick (nipplejs) -------------------------------------------
    // Normalized joystick deflection (-1..1 per axis), read every frame.
    const joystick = useRef({ x: 0, y: 0 })
    // Rotation speed in degrees per second at full joystick deflection.
    const joystickSpeed = 90

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

    // useEffect(() =>{
    //     // HTML joystick (nipplejs) anchored to the bottom-left corner of the
    //     // screen. Its X/Y deflection drives theta/phi rotation of the camera.
    //     const zone = document.createElement("div");
    //     zone.style.position = "fixed";
    //     zone.style.bottom = "0px";
    //     zone.style.left = "100px";
    //     zone.style.width = "128px";
    //     zone.style.height = "128px";
    //     zone.style.zIndex = "9999";
    //     zone.style.touchAction = "none";
    //     zone.style.userSelect = "none";
    //     document.body.appendChild(zone);

    //     const manager = nipplejs.create({
    //         zone,
    //         mode: "static",
    //         position: { top: "4px", left: "4px" },
    //         size: 150,
    //         color: {
    //             front: "rgba(255,255,255,0.6)",
    //             back: "rgba(255,255,255,0.15)",
    //         },
    //         restJoystick: true,
    //         threshold: 0.1,
    //         fadeTime: 120,
    //     });

    //     const handleMove = (evt: {
    //         data: { vector: { x: number; y: number } }
    //     }) => {
    //         joystick.current.x = evt.data.vector.x / 2.5;
    //         joystick.current.y = evt.data.vector.y / 2.5;
    //     };

    //     const handleEnd = () => {
    //         joystick.current.x = 0;
    //         joystick.current.y = 0;
    //     };

    //     manager.on("move", handleMove);
    //     manager.on("end", handleEnd);

    //     return () => {
    //         manager.off("move", handleMove);
    //         manager.off("end", handleEnd);
    //         manager.destroy();
    //         zone.remove();
    //     };
    // }, [])

    useEffect(() =>{
        // Mobile multi-touch: two fingers or more orbits the camera — horizontal
        // centroid movement increases theta (azAngle), vertical increases phi
        // (polarAngle). The two-finger pinch also dollies the orbit radius in/out
        // (spreading fingers pulls the camera in, pinching pushes it out).
        // Handlers live on the canvas, so the joystick zone stays exclusive to
        // rotation input.
        const el = gl.domElement;
        const pinchDist = (t: TouchList) => {
            const a = t[0];
            const b = t[1];
            return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        };
        const centroid = (t: TouchList) => {
            let x = 0;
            let y = 0;
            for (let i = 0; i < t.length; i++) {
                x += t[i].clientX;
                y += t[i].clientY;
            }
            return { x: x / t.length, y: y / t.length };
        };

        let lastPinchDist: number | null = null;
        let lastCentroid: { x: number; y: number } | null = null;

        const onTouchStart = (e: TouchEvent) => {
            e.preventDefault()
            if (e.touches.length >= 2) {
                lastPinchDist = pinchDist(e.touches);
                lastCentroid = centroid(e.touches);
            }
        };
        const onTouchMove = (e: TouchEvent) => {
            e.preventDefault()
            e.stopImmediatePropagation()
            if (e.touches.length < 2) return;

            const c = centroid(e.touches);
            if (lastCentroid) {
                // Horizontal drag orbits theta, vertical drag tilts phi.
                // Screen Y grows downward, so a positive dy raises phi (camera
                // moves down, view tilts up) — matches the arrow-key mapping.
                azAngle.current += (c.x - lastCentroid.x) * -0.25;
                polarAngle.current += (c.y - lastCentroid.y) * -0.25;
            }
            lastCentroid = c;

            // Two-finger pinch dollies the orbit radius.
            const d = pinchDist(e.touches);
            if (lastPinchDist != null) {
                // Spreading fingers (positive delta) pulls the camera in.
                spherical.radius -= (d - lastPinchDist) * 0.03;
                spherical.radius = Math.min(
                    MAX_ZOOM_DISTANCE,
                    Math.max(MIN_ZOOM_DISTANCE, spherical.radius),
                );
            }
            lastPinchDist = d;
        };
        const onTouchEnd = () => {
            lastPinchDist = null;
            lastCentroid = null;
        };

        el.addEventListener("touchstart", onTouchStart, { passive: true });
        el.addEventListener("touchmove", onTouchMove, { passive: false });
        el.addEventListener("touchend", onTouchEnd);
        el.addEventListener("touchcancel", onTouchEnd);

        return () => {
            el.removeEventListener("touchstart", onTouchStart);
            el.removeEventListener("touchmove", onTouchMove);
            el.removeEventListener("touchend", onTouchEnd);
            el.removeEventListener("touchcancel", onTouchEnd);
        };
    }, [gl, spherical])


    useEffect(() =>{
        const el = gl.domElement
        
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
            // event.stopPropagation()
            // event.stopImmediatePropagation()
            spherical.radius +=  event.deltaY / 75

            if (spherical.radius <= MIN_ZOOM_DISTANCE) {
                spherical.radius += event.deltaY / 75 * -1
            }
            if (spherical.radius >= MAX_ZOOM_DISTANCE) {
                spherical.radius += event.deltaY / 75 * -1
            }
        };
        el.addEventListener("wheel", handleWheel);
        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);

        return () => {
            el.removeEventListener("wheel", handleWheel);
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
        }
    }, [])

    useFrame((_,dt) => {
        //

        // console.log(input)
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
        // Joystick: X axis orbits theta (azAngle), Y axis tilts phi (polarAngle).
        // nipplejs reports up as +1 on the Y axis, so the signs here make the
        // joystick match the arrow-key mapping above (up/right reduce the angles).
        polarAngle.current += dt * -joystickSpeed * joystick.current.y
        azAngle.current += dt * joystickSpeed * joystick.current.x

        // Keep polar angle within safe bounds so the camera never flips poles.
        polarAngle.current = Math.min(179, Math.max(0.001, polarAngle.current))

        // Orbit + look target = the player's position, raised to the character's
        // centre (player.y + CAMERA_TARGET_Y), so zoom is centred on the body.
        focus.copy(player.position)
        focus.y = player.position.y + CAMERA_TARGET_Y

        camera.position.copy(focus)
        spherical.makeSafe()
        spherical.set(spherical.radius, Math.PI / 180 * polarAngle.current, Math.PI / 180 * azAngle.current)
        orbit.position.setFromSpherical(spherical)
        camera.position.add(orbit.position)
        camera.lookAt(focus)

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