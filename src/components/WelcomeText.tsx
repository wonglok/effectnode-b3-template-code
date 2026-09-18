import { Suspense, useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Center, Text3D } from '@react-three/drei'
import * as THREE from 'three'
// The scene's own material family: a node material, like LoadCollider's floor.
// A plain built-in `meshStandardMaterial` would be the only one in a scene
// rendered through a node-material MRT graph — and the selective bloom reads
// the material's *emissive* output, which `emissiveNode` is what actually
// writes (see BloomRender).
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { color } from 'three/tsl'
import { useGameGlobal } from './useGameGlobal'

// ---------------------------------------------------------------------------
// Welcome sign
// ---------------------------------------------------------------------------
// A greeting standing over the spot the player is placed at, so the scene
// announces itself before the player has walked anywhere.
//
// Anchoring: the start is *not* a constant. NavMeshRig.placePlayer prefers a
// named birthplace marker in the scene, then a computed start, then the
// collider box centre, and only falls back to (0, 2, 0) — and it re-runs when
// Blender re-syncs. So the sign reads the placement the rig resolved
// (`useGameGlobal.startPosition`) instead of guessing coordinates, and moves
// with it if the scene is re-placed.

/** The greeting itself. */
const SIGN_TEXT = 'Welcome'

/** Glyph height, world units — the sign's cap height, roughly. */
const SIGN_SIZE = 1.2

/** Clearance from the ground to the *top* of the sign, world units. A fixed
 *  height above the player's head rather than a height of the sign, so the
 *  clearance does not change with the text or the font. */
const SIGN_HEIGHT = 4.5

/** Extrusion depth of the letters. */
const SIGN_DEPTH = 0.35

/** The jump ring's cyan, so the sign reads as part of the same world. */
const SIGN_COLOR = '#00E5FF'

/** The letters' own colour, under the glow — dark, so the emissive is what the
 *  eye reads and the sign looks lit rather than painted. */
const SIGN_BODY_COLOR = '#0a3b45'

/** Served from `public/` rather than imported: the typeface is 884 KB of glyph
 *  outlines, and drei's `useFont` fetches and parses a URL the same way it
 *  parses a raw object — so the bytes stay out of the bundle and off the
 *  critical path. */
const SIGN_FONT = '/fonts/Inter_Medium_Regular.json'

/**
 * The sign, or nothing until the player has been placed. Suspense is local as
 * well as inherited: the font suspends on first load, and this keeps the
 * component safe to mount under a parent that does not provide a boundary.
 */
export function WelcomeText() {
    const startPosition = useGameGlobal((r) => r.startPosition)

    if (!startPosition) return null

    return (
        <Suspense fallback={null}>
            <WelcomeSign startPosition={startPosition} />
        </Suspense>
    )
}

function WelcomeSign({ startPosition }: { startPosition: THREE.Vector3 }) {
    const group = useRef<THREE.Group>(null)

    // Built once and disposed on unmount: a neon sign — a dark body under a
    // bright emissive, the same construction as the floor's ring. `emissiveNode`
    // is the emissive the bloom's MRT channel reads, and BloomRender runs on its
    // defaults here (threshold 0), so plain cyan already clears the high-pass;
    // the 1.6 is for a bright sign rather than a white-hot one.
    const material = useMemo(() => {
        const mat = new MeshStandardNodeMaterial()
        mat.color = new THREE.Color(SIGN_BODY_COLOR)
        mat.emissiveNode = color(SIGN_COLOR).mul(1.6)
        mat.roughness = 0.35
        mat.metalness = 0.2
        return mat
    }, [])

    useEffect(() => () => material.dispose(), [material])

    // Face the camera, yaw only. The extruded letters are flat and the camera
    // orbits the player, so without this the sign is edge-on — and would read
    // backwards — from half the orbit. Yaw only, because aiming the *whole*
    // rotation at a camera that sits ~15 units above the sign would tip the
    // letters flat onto their backs.
    useFrame(({ camera }) => {
        const g = group.current
        if (!g) return
        g.rotation.y = Math.atan2(camera.position.x - g.position.x, camera.position.z - g.position.z)
    })

    return (
        <group ref={group} position={[startPosition.x, startPosition.y + SIGN_HEIGHT, startPosition.z]}>
            {/* `top` puts the group's origin at the cap line, so SIGN_HEIGHT is
                headroom above the ground rather than the sign's own height;
                `front` puts it on the letters' face, so the sign does not sink
                into the ground as the depth grows. */}
            <Center front top>
                <Text3D
                    font={SIGN_FONT}
                    size={SIGN_SIZE}
                    height={SIGN_DEPTH}
                    bevelEnabled
                    bevelSize={0.01}
                    bevelThickness={0.01}
                    bevelSegments={10}
                    // 24 segments per curve, not the example's 128: at this size
                    // the faceting on an 'o' is under a centimetre, and the sign
                    // is read from ~18 units away.
                    curveSegments={24}
                    letterSpacing={-0.02}
                >
                    {SIGN_TEXT}
                    <primitive object={material} attach='material' />
                </Text3D>
            </Center>
        </group>
    )
}
