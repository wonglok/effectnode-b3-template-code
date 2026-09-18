import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import { useGameGlobal } from '../../../../../components/useGameGlobal'
import { createCloth, type ClothOptions } from './shader/cloth'

// ---------------------------------------------------------------------------
// GPU cloth
// ---------------------------------------------------------------------------
// Mounts the verlet cloth from `shader/cloth.ts` and drives it from the frame
// loop. The cloth itself is a plain object — it neither knows about React nor
// adds itself to a scene — so this component's whole job is: build it once,
// place it, step it, dispose it.
//
// It hangs *relative to the player's start* rather than at a fixed world point.
// That is the same anchor the welcome sign uses, and for the same reason: the
// scene's scale and origin come from Blender, so a hard-coded position is a
// position in someone else's coordinate system. The start is only known once
// NavMeshRig has placed the player, so until then the cloth sits at
// `fallback` — and since a position is a transform rather than a constructor
// argument, the arrival of the real anchor moves the cloth instead of rebuilding
// it (which would reset the simulation).

/**
 * Where the cloth hangs, as an offset from the player's start: to the right of
 * it, slightly behind, and **2.0 m up**.
 *
 * The height is not free — it is the other half of `DEFAULT_PLAYER_OFFSET`, and
 * the two have to be read together. The sheet is authored around the group's
 * origin with its pinned edge at local +0.5, so everything it can touch is
 * *below* that; the tracked point's height in cloth space is
 * `playerOffset.y - offset.y`. At 2.0 - 2.0 that is 0 — the middle of the
 * hanging sheet. Raise the cloth and the sphere falls out of the bottom of it;
 * lower it and the sphere ends up above the pins, where the cloth will never
 * reach, however close the player stands.
 */
const DEFAULT_OFFSET: [number, number, number] = [2.5, 1.0, -1.5]

/** Used until the player's start resolves — and if it never does, in a viewer
 *  that mounts no NavMeshRig, in which case this is where the cloth lives. */
const DEFAULT_FALLBACK: [number, number, number] = [2.5, 1.0, -1.5]

/**
 * Where the player is, for the sphere to chase.
 *
 * Read through `getState` inside a callback rather than through the hook: the
 * cloth samples this once per frame, and subscribing the component to a value
 * that changes every frame would re-render React sixty times a second for a
 * number only the shader ever reads. This is the same expression `NavMeshRig`
 * hands the crowd and the crates.
 *
 * `playerGroup` is null until NavMeshRig has built the player, which is also
 * when `startPosition` arrives — so the cloth has no target and no anchor for
 * the same stretch of time, and both land together.
 *
 * Module-level so its identity is stable: a fresh closure each render would be
 * a changed prop to the cloth below, and rebuild the simulation.
 */
const playerPosition = () => useGameGlobal.getState().playerGroup?.position ?? null

/**
 * Which point on the player the sphere tracks: two metres up, at their chest.
 *
 * The group's own placement is not enough to guarantee contact on its own. The
 * cloth is authored around the group's origin, pinned half a metre above it, and
 * the group hangs 1.2 m over the start — so a sphere at the player's *feet*
 * would sit about 1.5 m below the pinned edge, almost certainly under the hem.
 * The chest is where the sheet actually is.
 */
const DEFAULT_PLAYER_OFFSET: [number, number, number] = [0, 1, 0]

export interface ClothComponentProps extends Omit<ClothOptions, 'renderer' | 'position'> {
    /** Offset from the player's start, in world units. */
    offset?: [number, number, number]
    /** Where to hang it until that start is known. */
    fallback?: [number, number, number]
}

export function ClothComponent({
    offset = DEFAULT_OFFSET,
    fallback = DEFAULT_FALLBACK,
    // The rest are the cloth's own options, destructured so that the memo below
    // can depend on the values rather than on an object that is new every
    // render — passing the props object itself would rebuild the cloth, and
    // every storage buffer it owns, on every frame React rendered this.
    width,
    height,
    segmentsX,
    segmentsY,
    sphereRadius,
    wireframe,
    stepsPerSecond,
    sphereFollowSpeed,
    // Defaulted rather than required, so the app's player is what the sphere
    // chases unless a caller deliberately points it somewhere else.
    getPlayerPosition = playerPosition,
    playerOffset = DEFAULT_PLAYER_OFFSET,
    material,
}: ClothComponentProps) {
    const renderer = useThree((r) => r.gl)
    const startPosition = useGameGlobal((r) => r.startPosition)

    // Taken apart into primitives for the dependency list. The arrays are
    // literals by default, so the arrays themselves are new each render while
    // their contents are not.
    const [offsetX, offsetY, offsetZ] = offset
    const [fallbackX, fallbackY, fallbackZ] = fallback

    const cloth = useMemo(
        () =>
            createCloth({
                // `gl` from R3F's store is the WebGPURenderer this scene draws
                // with — `CanvasGPU`'s `gl` factory returns it — which is the one
                // the compute passes must be dispatched on. R3F declares
                // `RootState['gl']` as the WebGL renderer regardless of what the
                // factory returned, so the cast has to go through `unknown`: the
                // two types share no members, and the value is right.
                renderer: renderer as unknown as ClothOptions['renderer'],
                position: [fallbackX, fallbackY, fallbackZ],
                width,
                height,
                segmentsX,
                segmentsY,
                sphereRadius,
                wireframe,
                stepsPerSecond,
                sphereFollowSpeed,
                getPlayerPosition,
                playerOffset,
                material,
            }),
        [
            renderer,
            fallbackX,
            fallbackY,
            fallbackZ,
            width,
            height,
            segmentsX,
            segmentsY,
            sphereRadius,
            wireframe,
            stepsPerSecond,
            sphereFollowSpeed,
            getPlayerPosition,
            // An array literal by default, like `offset` above: the contents are
            // what the cloth reads, and they are primitives.
            playerOffset?.[0],
            playerOffset?.[1],
            playerOffset?.[2],
            // Must be a stable object. A caller that builds its transmission
            // params inline would rebuild the cloth — and lose the simulation
            // state — on every render.
            material,
        ],
    )

    // Placement is a transform, so the anchor arriving later is a move rather
    // than a rebuild: the cloth keeps whatever the sim has already done.
    useEffect(() => {
        if (startPosition) {
            cloth.object3D.position.set(startPosition.x + offsetX, startPosition.y + offsetY, startPosition.z + offsetZ)
        } else {
            cloth.object3D.position.set(fallbackX, fallbackY, fallbackZ)
        }
    }, [cloth, startPosition, offsetX, offsetY, offsetZ, fallbackX, fallbackY, fallbackZ])

    useEffect(() => () => cloth.dispose(), [cloth])

    // `delta` is seconds since the last frame. The cloth turns it into whole
    // fixed steps itself, so a hitch here shows up as fewer steps rather than as
    // a stretched one.
    useFrame((_state, delta) => {
        cloth.update(delta)
    })

    return <primitive object={cloth.object3D} />
}
