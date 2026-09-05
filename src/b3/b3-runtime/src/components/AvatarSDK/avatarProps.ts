/**
 * `<Avatar>` props & resolution — pure types + `resolveProps`.
 *
 * Split out of `Avatar.tsx` so the public component stays a thin orchestrator.
 * `resolveProps` merges per-prop overrides on top of a manifest and fills any
 * missing body axes with the −90° X "home" from `defaultBodyFor`.
 */

import type { Object3D } from 'three'

import { defaultBodyFor } from './manifest'
import type {
  AvatarAssets,
  AvatarManifest,
  BodyInsertion,
  HeadInsertion,
  MotionClipDef,
} from './types'

/** Result of merging a manifest with per-prop overrides. */
export interface AvatarResolved {
  name: string
  assets: AvatarAssets
  headBone: string | null
  head: HeadInsertion
  /** Body placement offset applied to the composed avatar root. */
  body: BodyInsertion
  /** How a rigged face is composed onto the body head bone. */
  headMode: HeadComposeMode
  clips: MotionClipDef[]
  motion: string
  playing: boolean
  loop: boolean
  speed: number
}

/**
 * Composition of a rigged face onto the live body head bone:
 * - `'auto'` — geometry decides: congruent (same skeleton rest) heads are
 *   co-located and dual-driven (exact skin sync); others are seated (their
 *   Head bone moved to the seat origin) and rigid-glued at the neck→head ratio.
 * - `'seat'` — always seat + rigid-glue at the **authored** size (no ratio
 *   rescale), skipping dual-drive. Use for cross-look remixes whose rest
 *   skeletons happen to sit <1 cm apart (so they read "congruent") but whose
 *   proportions differ enough that dual-driving drifts the head off the neck
 *   the moment a clip poses them.
 */
export type HeadComposeMode = 'auto' | 'seat'

export interface AvatarProps {
  /** Manifest describing the avatar to compose. **Runtime-required** (the
   * component throws without it) — build one with the SDK's
   * `makeDefaultManifest` (sample) or pass your own object. Fields can be
   * overridden prop-by-prop below. */
  manifest?: AvatarManifest
  name?: string
  assets?: Partial<AvatarAssets>
  headBone?: string | null
  head?: Partial<HeadInsertion>
  /** Body placement offset (defaults to the −90° X "home" that stands the
   * motion root up — rigs export lying along +Z). */
  body?: Partial<BodyInsertion>
  /** Rigged-head composition: `'auto'` (geometry decides) or `'seat'` (force
   * glue at authored size, no dual-drive). Defaults to `'auto'`. */
  headMode?: HeadComposeMode
  /** Active motion (name from `manifest.motion.clips`, or a baked GLB clip name). */
  motion?: string
  playing?: boolean
  loop?: boolean
  speed?: number
  visible?: { body?: boolean; face?: boolean }
  /** Hide the avatar until its skeleton stands upright at the start of a clip
   * (motions that open lying down won't show the floor-splayed intro). Defaults
   * to `true`. */
  revealWhenUpright?: boolean
  onReady?: (info: AvatarReadyInfo) => void
}

export interface AvatarReadyInfo {
  root: Object3D
  boneName: string | null
  duration: number
  clipNames: string[]
}

/**
 * Merge `AvatarProps` overrides on top of a manifest into a single resolved
 * config. A manifest is required at runtime so the core never needs to know
 * about a default character set — supply one, or a custom manifest object.
 */
export function resolveProps(props: AvatarProps): AvatarResolved {
  const manifest = props.manifest
  if (!manifest) {
    throw new Error(
      '[Avatar] <Avatar> requires a manifest prop. Build one with makeDefaultManifest ' +
        'from the SDK sample module (or your own manifest object) and pass it as ' +
        '<Avatar manifest={…} />.',
    )
  }
  const headIn = props.head ?? manifest.head
  const bodyIn = props.body ?? manifest.body
  const assets: AvatarAssets = {
    body: props.assets?.body ?? manifest.assets.body,
    face: props.assets?.face ?? manifest.assets.face,
  }
  // The body placement defaults to the −90° X upright "home" for any rigged
  // export (they come out lying along +Z), so falling back to it whenever the
  // caller hasn't supplied an explicit body offset already stands the body up.
  const bodyDefault = defaultBodyFor(assets.body)
  return {
    name: manifest.name,
    assets,
    headBone: props.headBone !== undefined ? props.headBone : manifest.headBone,
    head: {
      position: (headIn.position ?? manifest.head.position) as HeadInsertion['position'],
      rotation: (headIn.rotation ?? manifest.head.rotation) as HeadInsertion['rotation'],
      scale: (headIn.scale ?? manifest.head.scale) as HeadInsertion['scale'],
    },
    body: {
      position: (bodyIn.position ?? bodyDefault.position) as BodyInsertion['position'],
      rotation: (bodyIn.rotation ?? bodyDefault.rotation) as BodyInsertion['rotation'],
      scale: (bodyIn.scale ?? bodyDefault.scale) as BodyInsertion['scale'],
    },
    headMode: props.headMode ?? 'auto',
    clips: manifest.motion.clips,
    motion: props.motion ?? manifest.motion.default,
    playing: props.playing ?? manifest.motion.playing,
    loop: props.loop ?? manifest.motion.loop,
    speed: props.speed ?? manifest.motion.speed,
  }
}
