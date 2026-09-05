/**
 * mixamo-adapter avatar SDK — public surface.
 *
 * Everything a three.js / React Three Fiber consumer needs:
 * - `<Avatar>` R3F component + its props/types
 * - manifest helpers (build, parse, download)
 * - skeleton utilities (head-bone detection, FBX→GLB clip remap)
 * - asset loaders (Draco + meshopt-aware GLTF, bone-only FBX)
 *
 * The exports below mix the **asset-agnostic core** with the EffectNode
 * `/char` **sample data** (`src/AvatarSDK/sample/charAssets.ts`). Both are re-exported
 * so the demo can import everything from this single barrel; a new project that
 * brings its own assets can ignore the sample exports.
 */

export { Avatar } from './Avatar'
export type {
  AvatarProps,
  AvatarReadyInfo,
  AvatarResolved,
} from './avatarProps'

export {
  MANIFEST_SDK,
  MANIFEST_VERSION,
  IDENTITY_HEAD,
} from './types'
export type {
  AvatarAssets,
  AvatarManifest,
  AvatarManifestInput,
  AvatarOffsets,
  BodyInsertion,
  ComboOffsets,
  Gender,
  HeadInsertion,
  MotionClipDef,
  MotionConfig,
  Offset3,
  Vec3,
} from './types'

// ---- core manifest (asset-agnostic) ----
export {
  basenameOf,
  defaultBodyFor,
  downloadManifest,
  identityOffset,
  normalizeOffsets,
  parseManifest,
  serializeManifest,
} from './manifest'

// ---- sample: EffectNode /char catalogs + char-aware defaults ----
export {
  BODY_SINK_Y,
  bodyPlacementFor,
  BREAKDANCE_NAMES,
  createMotionCatalog,
  DEFAULT_GENDER,
  defaultVariant,
  GENDER_ASSETS,
  GENDER_PARTS,
  genderFromAssets,
  GESTURE_NAMES,
  LONGBOW_NAMES,
  MAGIC_NAMES,
  makeDefaultManifest,
  motionSectionClips,
  motionSectionForClips,
  MOTION_NAMES,
  MOTION_SECTIONS,
  partsFor,
  RIFLE_NAMES,
  SHOOTER_NAMES,
  variantForUrl,
} from './sample/charAssets'
export type {
  MotionSection,
  PartKind,
  PartPool,
  PartVariant,
} from './sample/charAssets'

export {
  clipBoneNames,
  collectBones,
  findBone,
  findHeadBone,
  mapClipBones,
  restrictClipToRoot,
} from './rig'
export type { BoneLike } from './rig'

export { seatHeadAlign, solveRigAlign } from './seating'
export type { HeadSeat, HeadSeatInput, SeatPoints, SeatResult } from './seating'

export { largestDimension, measureWorldBox } from './measure'
export type { MeasuredBox } from './measure'

export { createHeadMount } from './attachHead'
export type { HeadMount, HeadMountOptions } from './attachHead'

export {
  configureGltfLoader,
  createGltfLoader,
  DEFAULT_DRACO_DECODER_PATH,
  getDracoDecoderPath,
  gltfLoader,
  loadFBX,
  loadGLB,
  setDracoDecoderPath,
} from './decoders'
