'use client'

import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { ContactShadows, OrbitControls, Stage } from '@react-three/drei'
import { Avatar, createMotionCatalog, makeDefaultManifest } from '../../b3/b3-runtime/src/components/AvatarSDK'
import { useAvatarStore } from './useAvatarStore'

/**
 * Standalone avatar preview for the avatar picker popup.
 *
 * Renders the *same* composed look the walking character uses — the live avatar
 * store's gender, body/head assets and their tuned body/head offsets — inside
 * its own small R3F canvas, playing one looping `/char/motion-2/fbx/stay` clip.
 *
 * Because the store is live-applied, picking a body/head/gender here updates both
 * this preview and the main walking character together. `headMode="seat"`
 * mirrors the NavMeshRig's `avatarConfigSnapshot()` so the popup look matches
 * the canvas avatar (not the SDK's default `'auto'` dual-drive).
 *
 * `motion` is preview-only state owned by the popup — it never writes back to
 * the store or the main character.
 */

/** The `/char/motion-2/fbx/stay` catalog the preview cycles through. */
const STAY_CLIPS = createMotionCatalog('/char/motion-2/fbx/stay')

export function AvatarPreviewCanvas({ motion }: { motion: string }) {
    const name = useAvatarStore((s) => s.name)
    const gender = useAvatarStore((s) => s.gender)
    const bodyUrl = useAvatarStore((s) => s.assets.body)
    const faceUrl = useAvatarStore((s) => s.assets.face)
    const headBone = useAvatarStore((s) => s.headBone)
    const body = useAvatarStore((s) => s.body)
    const head = useAvatarStore((s) => s.head)

    // Pause the turntable while the user drags the orbit camera.
    // const [interacting, setInteracting] = useState(false);

    // Rebuild the manifest whenever the look or its stored tune changes. The stay
    // clips always ride along so every motion chip can be previewed without a
    // library swap; the store's tuned body/head offsets are forwarded so a combo
    // that was hand-fitted in the dev sidebar previews at its fitted pose.
    const manifest = useMemo(
        () =>
            makeDefaultManifest({
                name,
                gender,
                assets: { body: bodyUrl, face: faceUrl },
                headBone,
                body,
                head,
                motion: {
                    clips: STAY_CLIPS.map((c) => ({ ...c })),
                    default: motion,
                    loop: true,
                    speed: 1,
                    playing: true,
                },
            }),
        [name, gender, bodyUrl, faceUrl, headBone, body, head, motion],
    )

    return (
        <Canvas shadows gl={{ antialias: true, preserveDrawingBuffer: true }} camera={{ fov: 32 }}>
            <color attach='background' args={['#bababa']} />

            <OrbitControls
                makeDefault
                minDistance={1.5}
                maxDistance={8}
                target={[0, 0.55, 0]}
                object-position={[0, 0.55, 2.5]}
                minPolarAngle={0.35}
                maxPolarAngle={Math.PI / 2 - 0.04}
            />

            {/* Key + fill + bounce so PBR /acne-free char materials read nicely. */}
            <hemisphereLight intensity={0.55} color='#eaf3ff' groundColor='#23272e' />
            <directionalLight position={[2.8, 4.4, 2.6]} intensity={2.2} castShadow />
            <directionalLight position={[-3.2, 2.6, -1.8]} intensity={0.65} color='#9fd2ff' />
            <ambientLight intensity={0.8}></ambientLight>

            <Avatar manifest={manifest} motion={motion} speed={1} headMode='seat' />

            {/* Soft fake shadow under the feet — the avatar root sits at y≈0. */}
            {/* <ContactShadows
                position={[0, 0.001, 0]}
                opacity={1.0}
                scale={7}
                blur={2.6}
                far={4}
                resolution={512}
                color='#000000'
            /> */}
        </Canvas>
    )
}

//

//

//
