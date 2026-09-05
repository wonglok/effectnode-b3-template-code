/**
 * `<Avatar>` — the reusable React Three Fiber component for the avatar SDK.
 *
 * Composes a rigged body GLB with a face/head GLB and plays Mixamo FBX (or
 * baked GLB) clips on the shared mixamorig skeleton. The composition mode is
 * detected from the head asset:
 *
 * - **Rigged head** (has its own skinned mesh — the EffectNode "hd-male-*"
 *   exports): the head shares the body's rig and coordinate space, so it is
 *   placed co-located at the avatar origin and its *own* skeleton is driven by
 *   the same clip as the body (two mixers, one time source). The head therefore
 *   deforms in exact sync with the body. Head-insertion offsets become a small
 *   nudge on top, in the body head-bone's live frame (`mode: 'offset'`).
 *
 * - **Static head** (no skeleton): glued onto the body's head bone as one rigid
 *   piece (`mode: 'mount'`), following the bone's animation.
 *
 * Fully prop-driven (no dependency on the demo store); needs `React.Suspense`
 * around it because the GLB loaders suspend. A `manifest` is required at
 * runtime (see `avatarProps.ts`).
 *
 * This file is deliberately the *orchestrator*: pure helpers live in
 * `avatarProps.ts`, `avatarPose.ts`, `motionLibrary.ts`, `headCompose.ts`,
 * `rig.ts`, `attachHead.ts`, `seating.ts` and `manifest.ts`.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import {
  AnimationMixer,
  Group,
  LoopOnce,
  LoopRepeat,
  Object3D,
} from 'three'
import type { AnimationClip } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

import type { HeadMount } from './attachHead'
import { applyBodyOffset, UPRIGHT_REVEAL, uprightFraction } from './avatarPose'
import { resolveProps } from './avatarProps'
import type { AvatarProps } from './avatarProps'
import { gltfLoader } from './decoders'
import { classifyHeadCompose, createHeadAttachment } from './headCompose'
import { loadMotionClips, motionClipSignature } from './motionLibrary'
import { restrictClipToRoot } from './rig'
import type { BodyInsertion, HeadInsertion } from './types'

export type {
  AvatarProps,
  AvatarReadyInfo,
  AvatarResolved,
  HeadComposeMode,
} from './avatarProps'

const _ROOT_NAME = 'Avatar'

function AvatarInner(props: AvatarProps): JSX.Element {
  const resolved = useMemo(() => resolveProps(props), [props])
  const {
    assets,
    headBone,
    motion: activeName,
    playing,
    loop,
    speed,
    headMode,
  } = resolved
  const clipsDefs = resolved.clips

  // GLBs suspend — must be inside <Suspense>.
  const bodyGltf = useLoader(gltfLoader, assets.body) as GLTF & {
    scene: Object3D
  }
  const faceGltf = useLoader(gltfLoader, assets.face) as GLTF & {
    scene: Object3D
  }
  const bodyScene = bodyGltf.scene
  const faceScene = faceGltf.scene

  const root = useMemo(() => {
    const g = new Group()
    g.name = _ROOT_NAME
    return g
  }, [])

  const [rig, setRig] = useState<{
    mixer: AnimationMixer
    boneName: string | null
  } | null>(null)
  const mountRef = useRef<HeadMount | null>(null)
  const faceGroupRef = useRef<Group | null>(null)
  const mixerRef = useRef<AnimationMixer | null>(null)
  const headMixerRef = useRef<AnimationMixer | null>(null)
  const actionRef = useRef<ReturnType<AnimationMixer['clipAction']> | null>(null)
  const headActionRef = useRef<ReturnType<AnimationMixer['clipAction']> | null>(
    null,
  )
  const headRef = useRef<HeadInsertion>(resolved.head)
  const bodyRef = useRef<BodyInsertion>(resolved.body)
  const playingRef = useRef(playing)
  const speedRef = useRef(speed)
  const onReadyRef = useRef(props.onReady)
  onReadyRef.current = props.onReady

  // Reveal-when-upright: hidden until the skeleton stands (reset per clip).
  const revealUprightRef = useRef(props.revealWhenUpright ?? true)
  const revealStoodRef = useRef(false)
  const revealClipRef = useRef<string | null>(null)
  const activeNameRef = useRef(activeName)
  const headObjRef = useRef<Object3D | null>(null)
  const hipsObjRef = useRef<Object3D | null>(null)

  // Seamless part-switch: a body/head/gender/headMode swap rebuilds the
  // composition but keeps the active motion, so we resume the clip where it was
  // (standing mid-pose) instead of replaying its floor-splayed opening.
  const resumeTimeRef = useRef(0) // body-action time captured at teardown
  const prevRigRef = useRef<typeof rig>(null) // rig identity from the last playback run
  const prevClipNameRef = useRef<string | null>(null) // motion name last played

  headRef.current = resolved.head
  bodyRef.current = resolved.body
  playingRef.current = playing
  speedRef.current = speed
  activeNameRef.current = activeName
  revealUprightRef.current = props.revealWhenUpright ?? true

  const [loadedClips, setLoadedClips] = useState<Map<string, AnimationClip>>(
    () => new Map(),
  )

  // ---- rig lifecycle: body + head composition, mixers, offset mount ----
  useEffect(() => {
    if (!bodyScene || !faceScene) return

    // Classify + measure while both scenes are still unparented (identity
    // frame) so the congruent/seat decision can't be skewed by the avatar's
    // later uprighting rotation.
    const plan = classifyHeadCompose({
      bodyScene,
      faceScene,
      headBone,
      headMode,
    })
    headObjRef.current = plan.bone
    hipsObjRef.current = plan.hips

    root.add(bodyScene) // added first so the body mixer binds the body's bones
    const mixer = new AnimationMixer(root)
    mixerRef.current = mixer

    // Mount the face once the body scene is live under the root.
    const attachment = createHeadAttachment({ root, faceScene, plan })
    mountRef.current = attachment.mount
    faceGroupRef.current = attachment.group
    headMixerRef.current = attachment.headMixer
    if (attachment.mount) attachment.mount.update(headRef.current)

    // A re-compose (body/head/gender/headMode switch) re-attaches skinned meshes
    // that start in their lying bind pose. Keep the avatar hidden from this first
    // frame on; the playback pass drives the mixers to the active pose (via
    // `mixer.setTime`) and the reveal gate only then makes it visible — so the
    // "sleeping on the floor, head to the sky" frame never renders.
    root.visible = false
    revealStoodRef.current = false
    revealClipRef.current = null

    setRig({ mixer, boneName: plan.bone?.name ?? null })

    return () => {
      // Capture where the current motion is before the mixer/action are
      // destroyed, so a same-motion composition swap (body/head/gender) can
      // resume the clip seamlessly instead of replaying its floor intro.
      const at = actionRef.current?.time ?? mixerRef.current?.time ?? 0
      resumeTimeRef.current = Number.isFinite(at) ? at : 0

      attachment.dispose()
      mountRef.current = null
      headObjRef.current = null
      hipsObjRef.current = null
      faceGroupRef.current = null
      headMixerRef.current = null
      mixer.stopAllAction()
      mixerRef.current = null
      actionRef.current = null
      headActionRef.current = null
      setRig(null)
      if (bodyScene.parent === root) root.remove(bodyScene)
    }
  }, [bodyScene, faceScene, assets.body, headBone, root, headMode])

  // ---- eager-load the motion library (remapped to this skeleton) ----
  const clipsKey = useMemo(() => motionClipSignature(clipsDefs), [clipsDefs])
  useEffect(() => {
    if (!bodyScene || !clipsDefs.length) return
    let cancelled = false
    void loadMotionClips(clipsDefs, bodyScene).then((clips) => {
      if (!cancelled) setLoadedClips(clips)
    })
    return () => {
      cancelled = true
    }
  }, [bodyScene, clipsDefs, clipsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- active clip: baked GLB clip or a loaded FBX motion ----
  const activeClip = useMemo(() => {
    if (!activeName) return null
    const fromLib = loadedClips.get(activeName)
    if (fromLib) return fromLib
    const baked = bodyGltf.animations?.find((a) => a.name === activeName)
    if (baked) return baked
    return null
  }, [activeName, loadedClips, bodyGltf])

  // ---- play the active clip on the body and (if rigged) the head ----
  useEffect(() => {
    if (!activeClip) return
    const mixer = mixerRef.current
    const headMixer = headMixerRef.current
    if (!mixer && !headMixer) return

    // Same motion still selected? A body/head/gender/headMode switch rebuilds
    // the composition but keeps the active motion, so the character is mid-pose:
    // resume the clip from where it was instead of replaying its floor-splayed
    // "stay" opening (the intro the reveal gate hides on a fresh start).
    const continuing =
      prevClipNameRef.current != null &&
      prevClipNameRef.current === activeNameRef.current
    const rigChanged = prevRigRef.current !== rig
    const previous = actionRef.current
    const previousHead = headActionRef.current

    // Where the motion is: right after a composition teardown the cleanup stored
    // resumeTimeRef (authoritative); otherwise keep the live action's position.
    const liveTime = previous?.time ?? mixer?.time ?? 0
    const resume =
      continuing && rigChanged && resumeTimeRef.current > 0
        ? resumeTimeRef.current
        : Number.isFinite(liveTime) && liveTime > 0
          ? liveTime
          : 0
    const t = Math.max(
      0,
      Math.min(resume, Math.max(0, activeClip.duration - 0.001)),
    )

    const action = mixer ? mixer.clipAction(activeClip) : null
    // The head rig may carry fewer bones than the clip (41 vs 65 in the remix
    // set): drive only the tracks whose bones exist under the face skeleton.
    const headClip = headMixer
      ? restrictClipToRoot(activeClip, faceScene)
      : null
    const headAction = headClip ? headMixer!.clipAction(headClip) : null

    if (action) {
      action.reset()
      action.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1)
      if (!loop) action.clampWhenFinished = true
      action.enabled = true
    }
    if (headAction) {
      headAction.reset()
      headAction.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1)
      if (!loop) headAction.clampWhenFinished = true
      headAction.enabled = true
    }

    // Time to drive the (possibly separate) head rig to, clamped to its clip.
    const headT = Math.max(
      0,
      Math.min(t, Math.max(0, (headClip?.duration ?? t) - 0.001)),
    )

    if (continuing) {
      // Seamless continuation: hard-cut to the old position at full weight (same
      // pose — nothing to cross-fade). The composed meshes were just rebuilt from
      // their lying bind pose (and the rig setup hid the avatar), so drive the
      // mixers to the resumed pose NOW before anything can reveal it. A bare
      // `mixer.update(0)` after setting `action.time` isn't guaranteed to push the
      // pose onto the skeleton until the next frame advances, so jump the mixers
      // straight to the time with `setTime()` (which evaluates immediately). The
      // reveal gate is re-armed — it brings the avatar back as soon as the pose is
      // applied, i.e. standing on the next frame.
      if (previous && action && previous !== action) previous.stop()
      if (previousHead && headAction && previousHead !== headAction)
        previousHead.stop()
      if (action) {
        action.play()
        action.time = t
        action.weight = 1
      }
      if (headAction) {
        headAction.play()
        headAction.time = headT
        headAction.weight = 1
      }
      mixer?.setTime(t)
      headMixer?.setTime(headT)
      revealStoodRef.current = false
      revealClipRef.current = activeNameRef.current
    } else {
      // Fresh start (boot, or a genuinely different motion): cross-fade from the
      // previous action and re-arm the reveal gate so this clip's floor-splayed
      // opening plays hidden and the avatar appears standing.
      if (previous && action && previous !== action) previous.fadeOut(0.25)
      if (previousHead && headAction && previousHead !== headAction)
        previousHead.fadeOut(0.25)
      if (action) action.fadeIn(0.25).play()
      if (headAction) headAction.fadeIn(0.25).play()
      revealStoodRef.current = false
      revealClipRef.current = null
    }

    actionRef.current = action
    headActionRef.current = headAction
    // Only the fresh-start path can share a mixer with the (fading) previous
    // action, so it keeps the neutral update(0); the continuing path used
    // setTime() above. Both are followed by the real per-frame advances.
    if (!continuing) {
      mixer?.update(0)
      headMixer?.update(0)
    }

    prevRigRef.current = rig
    prevClipNameRef.current = activeNameRef.current
  }, [rig, activeClip, loop])

  // ---- notify once the rig is live ----
  useEffect(() => {
    if (!rig) return
    onReadyRef.current?.({
      root,
      boneName: rig.boneName,
      duration: activeClip?.duration ?? 0,
      clipNames: loadedClips.size
        ? [...loadedClips.keys()]
        : clipsDefs.map((c) => c.name),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rig])

  // ---- per-frame: advance both mixers in sync, then apply the head nudge ----
  useFrame((_, delta) => {
    const mixer = mixerRef.current
    const headMixer = headMixerRef.current
    if (mixer || headMixer) {
      const dt = Math.min(delta, 1 / 20) // clamp so tab-switch doesn't jump
      const advance = playingRef.current ? dt * speedRef.current : 0
      mixer?.update(advance)
      headMixer?.update(advance)
    }
    // Body placement offset (asset-frame correction) always wins on the root.
    applyBodyOffset(root, bodyRef.current)
    mountRef.current?.update(headRef.current)

    // Reveal-when-upright: while a clip is playing, stay hidden until the
    // skeleton stands (per clip — a standing clip reveals on its first frame).
    const clip = activeNameRef.current
    if (revealUprightRef.current && clip) {
      if (clip !== revealClipRef.current) {
        revealClipRef.current = clip
        revealStoodRef.current = false
      }
      if (playingRef.current && !revealStoodRef.current) {
        const up = uprightFraction(headObjRef.current, hipsObjRef.current)
        if (up !== null && up >= UPRIGHT_REVEAL) revealStoodRef.current = true
      }
      root.visible = !playingRef.current || revealStoodRef.current
    } else {
      root.visible = true
    }
  })

  // ---- frustum culling ----
  // Skinned meshes deform via bones, so three's auto bounding-sphere culling
  // (computed from the static bind pose) can pop the body/head in and out as
  // they animate. Disable it on every mesh of both loaded scenes.
  useEffect(() => {
    bodyScene.traverse((o) => {
      o.frustumCulled = false
    })
    faceScene.traverse((o) => {
      o.frustumCulled = false
    })
  }, [bodyScene, faceScene])

  // ---- visibility toggles ----
  useEffect(() => {
    bodyScene.visible = props.visible?.body ?? true
  }, [props.visible?.body, bodyScene])
  useEffect(() => {
    const group = faceGroupRef.current
    if (group) group.visible = props.visible?.face ?? true
  }, [props.visible?.face, rig])

  return <primitive object={root} />
}

/**
 * Public `<Avatar>` — wraps the internals in a Suspense boundary so callers
 * only need `<Canvas><Avatar manifest={…} /></Canvas>`.
 */
export function Avatar(props: AvatarProps): JSX.Element {
  return (
    <Suspense fallback={null}>
      <AvatarInner {...props} />
    </Suspense>
  )
}
