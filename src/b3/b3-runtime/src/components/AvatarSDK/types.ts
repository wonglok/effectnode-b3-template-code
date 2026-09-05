/**
 * mixamo-adapter avatar SDK — shared types & defaults.
 *
 * The manifest is the persistence + interchange format for a composed avatar:
 * a rigged body GLB, a static face GLB inserted into a named head bone, and a
 * set of Mixamo FBX motions that drive the body skeleton.
 *
 * # Offsets (v2)
 *
 * Every body × head combination keeps its own *offset namespace* — an entry in
 * the manifest's flat `offsets` array (`ComboOffsets`). A namespace stores two
 * transforms for that pairing:
 * - `body` — placement of the body asset. Rigs export lying along +Z, so the
 *   default (see `defaultBodyFor`) is the −90° X home that stands the motion
 *   root up; a combo whose asset ships in a different frame tunes this to
 *   correct it.
 * - `head` — the head-insertion tuning (how the face seats on this body's head
 *   bone).
 *
 * `AvatarManifest.head` / `.body` mirror the active combination's entry, so the
 * live tuning controls read/write them while `offsets` round-trips the whole
 * remix set on export/import.
 */

export type Vec3 = [number, number, number]

/** Built-in character set the demo can switch between. */
export type Gender = 'male' | 'female'

export const MANIFEST_SDK = 'mixamo-adapter/avatar'
export const MANIFEST_VERSION = 2 as const

/**
 * Generic translate/rotate/scale offset group, shared by body placement and
 * head insertion.
 *
 * - `position` — meters along the target's axes.
 * - `rotation` — Euler offset around the target's axes, **in degrees**.
 * - `scale`    — multiplier (1 = natural / authored size).
 */
export interface Offset3 {
  position: Vec3
  rotation: Vec3
  scale: Vec3
}

/**
 * Head-insertion tuning: how the static face is seated onto the head bone.
 *
 * Offsets are expressed in the bone's local frame but measured in the rig's
 * *visual* world space, so they stay intuitive regardless of the skeleton's
 * internal unit scale (see `attachHead.ts`).
 */
export type HeadInsertion = Offset3

/**
 * Body placement applied to the whole composed avatar for one body. Rigs export
 * lying along +Z, so the SDK's default (see `defaultBodyFor` in `manifest.ts`)
 * is the −90° X "home" that stands the motion root up (+Z → +Y); a body that
 * ships in a different frame (already upright, or with its own twist) tunes this
 * offset to correct it back to the canonical stance.
 */
export type BodyInsertion = Offset3

export const IDENTITY_HEAD: Offset3 = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
}

/**
 * One body × face combination's offset namespace. A manifest stores these as a
 * flat array (`offsets`) — each element is a namespace keyed by the body/face
 * URLs, carrying both the body placement offset and the head insertion.
 */
export interface ComboOffsets {
  /** Body GLB URL (the body side of the namespace). */
  bodyUrl: string
  /** Face/head GLB URL (the head side of the namespace). */
  faceUrl: string
  /** Placement transform applied to the body (asset-frame correction). */
  body: BodyInsertion
  /** Head-insertion tuning: how the face seats on this body's head bone. */
  head: HeadInsertion
}

/** Flat, namespaced offset table carried by a manifest (replaces v1's nested
 * `[body URL][face URL]` `headOffsets` object). */
export type AvatarOffsets = ComboOffsets[]

export interface MotionClipDef {
  /** Stable id used by {@link MotionConfig.default} and the player. */
  name: string
  /** FBX file that carries a single "mixamo.com" clip. */
  url: string
}

export interface MotionConfig {
  clips: MotionClipDef[]
  /** Name of the clip to autoplay on load. */
  default: string
  loop: boolean
  speed: number
  playing: boolean
}

export interface AvatarAssets {
  /** Rigged body GLB (skinned mesh + mixamorig skeleton). */
  body: string
  /** Static face/head GLB inserted into the head bone. */
  face: string
}

export interface AvatarManifest {
  sdk: string
  version: number
  name: string
  /** Which built-in character set the assets belong to (null for custom URLs). */
  gender?: Gender | null
  assets: AvatarAssets
  /**
   * Default body × head for each gender, used by the demo when the user switches
   * genders (and as the boot seed when the file's top-level `assets` is absent).
   * Optional — falls back to the built-in `GENDER_ASSETS` catalog when missing.
   */
  genderDefaults?: Partial<Record<Gender, AvatarAssets>> | null
  /**
   * Bone to insert the face into. `null` = auto-detect the most head-like bone
   * (`mixamorig:Head`, `Head`, any bone whose name contains "head" …).
   */
  headBone: string | null
  /** Head-insertion offset of the *active* body × face combination. */
  head: HeadInsertion
  /** Body placement offset of the *active* body × face combination. */
  body: BodyInsertion
  /**
   * All stored per-combination offset namespaces (see {@link ComboOffsets}),
   * so export/import preserves every body × face pairing. `head`/`body` mirror
   * the entry for the active `assets`. `null`/absent = none stored.
   */
  offsets?: AvatarOffsets | null
  motion: MotionConfig
}

/**
 * Loose input used to construct a complete manifest: every field optional, so
 * partial JSON or partial props can be merged over defaults.
 */
export interface AvatarManifestInput {
  name?: string
  gender?: Gender | null
  assets?: Partial<AvatarAssets>
  genderDefaults?: Partial<Record<Gender, AvatarAssets>> | null
  headBone?: string | null
  head?: Partial<HeadInsertion>
  body?: Partial<BodyInsertion>
  /** New flat array, or a legacy v1 nested `headOffsets` object (tolerated on
   * import and normalized to the array). */
  offsets?: AvatarOffsets | AvatarManifest['offsets']
  motion?: Partial<MotionConfig>
}
