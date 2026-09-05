/**
 * SAMPLE character data for the mixamo-adapter demo (EffectNode `/char` set).
 *
 * Everything in this file references concrete `/char/...` asset URLs and the
 * demo's default look pool. It is **optional** for reuse: the core SDK
 * (`index.ts`, `types.ts`, `manifest.ts`, `Avatar.tsx`, …) has zero knowledge
 * of these paths and composes whatever assets your manifest points at. If you
 * copy the SDK into a new project, either (a) drop this folder and build your
 * own manifest, or (b) keep it as a template catalog and re-point the URLs.
 *
 * Direction: SAMPLE → core. This file imports from `../manifest`; core never
 * imports from here.
 */

import { assembleManifest, defaultBodyFor } from '../manifest'
import type {
  AvatarAssets,
  AvatarManifest,
  AvatarManifestInput,
  BodyInsertion,
  Gender,
  MotionClipDef,
} from '../types'

/** Default motion library served from `/char/motion-2/fbx/stay` (the "stay"
 * clip set; the old `/char/motion` library was removed Sept 2026). */
export const MOTION_NAMES = [
  'idle-breathing',
  'idle-neutral',
  'idle-pose',
  'jumping',
  'running',
  'rush',
  'walking',
  'walking2',
] as const

export function createMotionCatalog(
  baseUrl = '/char/motion-2/fbx/stay',
): MotionClipDef[] {
  return MOTION_NAMES.map((name) => ({ name, url: `${baseUrl}/${name}.fbx` }))
}

/**
 * One named motion library (a folder of bone-only Mixamo FBX clips served from
 * `/char/motion-2/fbx`). The demo exposes these as a section picker so a large
 * clip set (e.g. the 34-clip breakdance pack) doesn't flood a single chip list.
 */
export interface MotionSection {
  /** Stable id (chip keys / store field). */
  id: string
  /** Short chip label, e.g. "breakdance". */
  label: string
  /** Folder under `/char/motion-2/fbx` holding the `.fbx` files. */
  baseUrl: string
  /** FBX file base names (each `${baseUrl}/${name}.fbx` is one clip). */
  names: readonly string[]
  /** Clip to autoplay when this section is selected. */
  default: string
}

/** Breakdance clips added Sept 2026 (`/char/motion-2/fbx/breakdance`). */
export const BREAKDANCE_NAMES = [
  'breakdance-1990',
  'breakdance-1990-2',
  'breakdance-1990-3',
  'breakdance-ending-1',
  'breakdance-ending-2',
  'breakdance-ending-3',
  'breakdance-footwork-1',
  'breakdance-footwork-2',
  'breakdance-footwork-3',
  'breakdance-footwork-to-freeze',
  'breakdance-footwork-to-idle',
  'breakdance-footwork-to-idle-2',
  'breakdance-freeze-var-1',
  'breakdance-freeze-var-2',
  'breakdance-freeze-var-3',
  'breakdance-freeze-var-4',
  'breakdance-freezes',
  'breakdance-ready',
  'breakdance-ready-2',
  'breakdance-ready-3',
  'breakdance-swipes',
  'breakdance-uprock',
  'breakdance-uprock-2',
  'breakdance-uprock-to-ground',
  'breakdance-uprock-to-ground-2',
  'breakdance-uprock-var-1',
  'breakdance-uprock-var-1-end',
  'breakdance-uprock-var-1-start',
  'breakdance-uprock-var-2',
  'brooklyn-uprock',
  'crossleg-freeze',
  'flair',
  'flair-2',
  'flair-3',
] as const

/** Gesture clips added Sept 2026 (`/char/motion-2/fbx/gesture`). */
export const GESTURE_NAMES = [
  'acknowledging',
  'angry-gesture',
  'annoyed-head-shake',
  'being-cocky',
  'dismissing-gesture',
  'happy-hand-gesture',
  'hard-head-nod',
  'head-nod-yes',
  'lengthy-head-nod',
  'look-away-gesture',
  'relieved-sigh',
  'sarcastic-head-nod',
  'shaking-head-no',
  'thoughtful-head-shake',
  'weight-shift',
] as const

/** Rifle / gun clips added Sept 2026 (`/char/motion-2/fbx/gun`). */
export const RIFLE_NAMES = [
  'crouching-turn-90-left',
  'crouching-turn-90-right',
  'death-crouching-headshot-front',
  'death-from-back-headshot',
  'death-from-front-headshot',
  'death-from-right',
  'death-from-the-back',
  'death-from-the-front',
  'idle',
  'idle-aiming',
  'idle-crouching',
  'idle-crouching-aiming',
  'jump-down',
  'jump-loop',
  'jump-up',
  'run-backward',
  'run-backward-left',
  'run-backward-right',
  'run-forward',
  'run-forward-left',
  'run-forward-right',
  'run-left',
  'run-right',
  'sprint-backward',
  'sprint-backward-left',
  'sprint-backward-right',
  'sprint-forward',
  'sprint-forward-left',
  'sprint-forward-right',
  'sprint-left',
  'sprint-right',
  'turn-90-left',
  'turn-90-right',
  'walk-backward',
  'walk-backward-left',
  'walk-backward-right',
  'walk-crouching-backward',
  'walk-crouching-backward-left',
  'walk-crouching-backward-right',
  'walk-crouching-forward',
  'walk-crouching-forward-left',
  'walk-crouching-forward-right',
  'walk-crouching-left',
  'walk-crouching-right',
  'walk-forward',
  'walk-forward-left',
  'walk-forward-right',
  'walk-left',
  'walk-right',
] as const

/** Longbow clips added Sept 2026 (`/char/motion-2/fbx/longbow`). */
export const LONGBOW_NAMES = [
  'fall-a-land-to-run-forward',
  'fall-a-land-to-standing-idle-01',
  'fall-a-loop',
  'standing-aim-overdraw',
  'standing-aim-recoil',
  'standing-aim-walk-back',
  'standing-aim-walk-forward',
  'standing-aim-walk-left',
  'standing-aim-walk-right',
  'standing-block',
  'standing-death-backward-01',
  'standing-death-forward-01',
  'standing-disarm-bow',
  'standing-dive-forward',
  'standing-dodge-backward',
  'standing-dodge-forward',
  'standing-dodge-left',
  'standing-dodge-right',
  'standing-draw-arrow',
  'standing-equip-bow',
  'standing-idle-01',
  'standing-idle-02-looking',
  'standing-idle-03-examine',
  'standing-melee-kick',
  'standing-melee-punch',
  'standing-react-small-from-front',
  'standing-react-small-from-headshot',
  'standing-run-back',
  'standing-run-forward',
  'standing-run-forward-stop',
  'standing-run-left',
  'standing-run-right',
  'standing-turn-90-left',
  'standing-turn-90-right',
  'standing-walk-back',
  'standing-walk-forward',
  'standing-walk-left',
  'standing-walk-right',
  'unarmed-idle-01',
] as const

/** Magic caster clips added Sept 2026 (`/char/motion-2/fbx/pro-magic`). */
export const MAGIC_NAMES = [
  'crouch-idle',
  'crouch-to-standing-idle',
  'crouch-turn-left-90',
  'crouch-turn-right-90',
  'crouch-walk-back',
  'crouch-walk-forward',
  'crouch-walk-left',
  'crouch-walk-right',
  'standing-1h-cast-spell-01',
  'standing-1h-magic-attack-01',
  'standing-1h-magic-attack-02',
  'standing-1h-magic-attack-03',
  'standing-2h-cast-spell-01',
  'standing-2h-magic-area-attack-01',
  'standing-2h-magic-area-attack-02',
  'standing-2h-magic-attack-01',
  'standing-2h-magic-attack-02',
  'standing-2h-magic-attack-03',
  'standing-2h-magic-attack-04',
  'standing-2h-magic-attack-05',
  'standing-block-end',
  'standing-block-idle',
  'standing-block-react-large',
  'standing-block-start',
  'standing-idle',
  'standing-idle-02',
  'standing-idle-03',
  'standing-idle-04',
  'standing-idle-to-crouch',
  'standing-jump',
  'standing-jump-running',
  'standing-jump-running-landing',
  'standing-land-to-standing-idle',
  'standing-react-death-backward',
  'standing-react-death-forward',
  'standing-react-death-left',
  'standing-react-death-right',
  'standing-react-large-from-back',
  'standing-react-large-from-front',
  'standing-react-large-from-left',
  'standing-react-large-from-right',
  'standing-react-small-from-back',
  'standing-react-small-from-front',
  'standing-react-small-from-left',
  'standing-react-small-from-right',
  'standing-run-back',
  'standing-run-forward',
  'standing-run-left',
  'standing-run-right',
  'standing-sprint-forward',
  'standing-turn-left-90',
  'standing-turn-right-90',
  'standing-walk-back',
  'standing-walk-forward',
  'standing-walk-left',
  'standing-walk-right',
] as const

/** Shooter / tactical movement clips added Sept 2026 (`/char/motion-2/fbx/shooter`). */
export const SHOOTER_NAMES = [
  'firing-rifle',
  'jump-backward',
  'jump-forward',
  'rifle-aiming-idle',
  'rifle-run',
  'run-backwards',
  'start-walking',
  'start-walking-backwards',
  'stop-walking',
  'strafe',
  'strafe-2',
  'walk-backwards-stop',
  'walking',
  'walking-backwards',
  'walking-to-dying',
] as const

/** Motion libraries the demo exposes in the Motion section picker. */
export const MOTION_SECTIONS: MotionSection[] = [
  {
    id: 'stay',
    label: 'Stay',
    baseUrl: '/char/motion-2/fbx/stay',
    names: MOTION_NAMES,
    default: 'idle-pose',
  },
  {
    id: 'breakdance',
    label: 'Breakdance',
    baseUrl: '/char/motion-2/fbx/breakdance',
    names: BREAKDANCE_NAMES,
    default: 'breakdance-1990',
  },
  {
    id: 'gesture',
    label: 'Gesture',
    baseUrl: '/char/motion-2/fbx/gesture',
    names: GESTURE_NAMES,
    default: 'head-nod-yes',
  },
  {
    id: 'magic',
    label: 'Magic',
    baseUrl: '/char/motion-2/fbx/pro-magic',
    names: MAGIC_NAMES,
    default: 'standing-1h-cast-spell-01',
  },
  {
    id: 'rifle',
    label: 'Rifle',
    baseUrl: '/char/motion-2/fbx/gun',
    names: RIFLE_NAMES,
    default: 'idle-aiming',
  },
  {
    id: 'longbow',
    label: 'Longbow',
    baseUrl: '/char/motion-2/fbx/longbow',
    names: LONGBOW_NAMES,
    default: 'standing-aim-overdraw',
  },
  {
    id: 'shooter',
    label: 'Shooter',
    baseUrl: '/char/motion-2/fbx/shooter',
    names: SHOOTER_NAMES,
    default: 'rifle-aiming-idle',
  },
]

/** Clip defs for one motion section (names → `${baseUrl}/${name}.fbx`). */
export function motionSectionClips(
  section: MotionSection,
): MotionClipDef[] {
  return section.names.map((name) => ({
    name,
    url: `${section.baseUrl}/${name}.fbx`,
  }))
}

/** The section whose folder a clip url lives under, else the first section. */
export function motionSectionForClips(
  clips: MotionClipDef[],
): MotionSection {
  const sample = clips[0]?.url ?? ''
  return (
    MOTION_SECTIONS.find((s) => sample.includes(`${s.baseUrl}/`)) ??
    MOTION_SECTIONS[0]
  )
}

export const DEFAULT_GENDER: Gender = 'male'

/** Built-in character sets, keyed by `/char/<gender>/{body|face}/*.glb`. */
export const GENDER_ASSETS: Record<Gender, AvatarAssets> = {
  male: {
    body: '/char/male/body/swat.glb',
    face: '/char/male/face/chinese.glb',
  },
  female: {
    body: '/char/female/body/body-01.glb',
    face: '/char/female/face/head-01.glb',
  },
}

/** One swappable body/face part inside a gender pool. */
export interface PartVariant {
  /** Stable id (chip keys / selection). */
  id: string
  /** Short chip label, e.g. "army". */
  label: string
  kind: 'body' | 'face'
  gender: Gender
  url: string
}

export interface PartPool {
  body: PartVariant[]
  face: PartVariant[]
}

/**
 * Remix catalog — the parts you can cross-combine per gender. Male looks:
 * space / space2 / army / t-shirt / skydive (rigged bodies) + the Tripo
 * single-mesh office / winter / hoodie bodies, and asian / mr-bun / blond /
 * blond2 / latin / mexican / mexican2 heads. A second male set was added Sept
 * 2026 (all single-mesh rigged "Scene" exports, independent looks): bodies
 * army-1 / commander-1 / rocket-01 / space-army-01..03 / swat /
 * wintersnow, plus the chinese head — the current male boot default is
 * `swat × chinese`. Female looks: body-01 / body-02 + seven Tripo bodies
 * (blue-polo / office-01 / office-02 / runner / space / street / teal-polo)
 * and head-01 + five Tripo heads (blond / lady / princess / snow-white /
 * southern). Bodies and heads are independent, so any body × any head of a
 * gender composes. `<Avatar>` auto-seats cross-character heads (different
 * skeleton rest space) via `seating.ts` (rigid glue when >1 cm apart,
 * dual-drive when congruent).
 */
export const GENDER_PARTS: Record<Gender, PartPool> = {
  male: {
    body: [
      { id: 'male-body', label: 'space', kind: 'body', gender: 'male', url: '/char/male/body/space.glb' },
      { id: 'space2-body', label: 'space2', kind: 'body', gender: 'male', url: '/char/male/body/space2.glb' },
      { id: 'male2-body', label: 'army', kind: 'body', gender: 'male', url: '/char/male/body/army.glb' },
      { id: 'male3-body', label: 't-shirt', kind: 'body', gender: 'male', url: '/char/male/body/t-shirt.glb' },
      { id: 'male4-body', label: 'skydive', kind: 'body', gender: 'male', url: '/char/male/body/skydive.glb' },
      { id: 'office-body', label: 'office', kind: 'body', gender: 'male', url: '/char/male/body/office-male-body.glb' },
      { id: 'winter-body', label: 'winter', kind: 'body', gender: 'male', url: '/char/male/body/winter-clothing-male.glb' },
      { id: 'hoodie-body', label: 'hoodie', kind: 'body', gender: 'male', url: '/char/male/body/hoodie.glb' },
      // Added Sept 2026 — second male export set (all single-mesh rigged scenes
      // "Scene"; mixamorig skeletons of 65/41/33/57 bones). Independent looks,
      // so every combo with them is cross-look seat glue.
      { id: 'army1-body', label: 'army-1', kind: 'body', gender: 'male', url: '/char/male/body/army-1.glb' },
      { id: 'commander1-body', label: 'commander-1', kind: 'body', gender: 'male', url: '/char/male/body/commander-1.glb' },
      { id: 'rocket1-body', label: 'rocket-01', kind: 'body', gender: 'male', url: '/char/male/body/rocket-01.glb' },
      { id: 'spacearmy1-body', label: 'space-army-01', kind: 'body', gender: 'male', url: '/char/male/body/space-army-01.glb' },
      { id: 'spacearmy2-body', label: 'space-army-02', kind: 'body', gender: 'male', url: '/char/male/body/space-army-02.glb' },
      { id: 'spacearmy3-body', label: 'space-army-03', kind: 'body', gender: 'male', url: '/char/male/body/space-army-03.glb' },
      { id: 'swat-body', label: 'swat', kind: 'body', gender: 'male', url: '/char/male/body/swat.glb' },
      { id: 'wintersnow-body', label: 'wintersnow', kind: 'body', gender: 'male', url: '/char/male/body/wintersnow.glb' },
    ],
    face: [
      { id: 'male-head', label: 'asian', kind: 'face', gender: 'male', url: '/char/male/face/asian.glb' },
      { id: 'male2-head', label: 'mr-bun', kind: 'face', gender: 'male', url: '/char/male/face/mr-bun.glb' },
      { id: 'male3-head', label: 'blond', kind: 'face', gender: 'male', url: '/char/male/face/blond.glb' },
      { id: 'blond2-face', label: 'blond2', kind: 'face', gender: 'male', url: '/char/male/face/blond2.glb' },
      { id: 'latin-face', label: 'latin', kind: 'face', gender: 'male', url: '/char/male/face/latin-face-male.glb' },
      { id: 'mexican-face', label: 'mexican', kind: 'face', gender: 'male', url: '/char/male/face/mexican.glb' },
      { id: 'mexican2-face', label: 'mexican2', kind: 'face', gender: 'male', url: '/char/male/face/mexican2.glb' },
      // Added Sept 2026 — second male head export (65-bone, scene "Scene").
      { id: 'chinese-head', label: 'chinese', kind: 'face', gender: 'male', url: '/char/male/face/chinese.glb' },
    ],
  },
  female: {
    body: [
      { id: 'female-body', label: 'body-01', kind: 'body', gender: 'female', url: '/char/female/body/body-01.glb' },
      { id: 'female2-body', label: 'body-02', kind: 'body', gender: 'female', url: '/char/female/body/body-02.glb' },
      { id: 'bluepolo-body', label: 'blue-polo', kind: 'body', gender: 'female', url: '/char/female/body/blue-polo.glb' },
      { id: 'office1-body', label: 'office-01', kind: 'body', gender: 'female', url: '/char/female/body/office-01.glb' },
      { id: 'office2-body', label: 'office-02', kind: 'body', gender: 'female', url: '/char/female/body/office-02.glb' },
      { id: 'runner-body', label: 'runner', kind: 'body', gender: 'female', url: '/char/female/body/runner.glb' },
      { id: 'space-body', label: 'space', kind: 'body', gender: 'female', url: '/char/female/body/space.glb' },
      { id: 'street-body', label: 'street', kind: 'body', gender: 'female', url: '/char/female/body/street.glb' },
      { id: 'tealpolo-body', label: 'teal-polo', kind: 'body', gender: 'female', url: '/char/female/body/teal-polo.glb' },
    ],
    face: [
      { id: 'female-head', label: 'head-01', kind: 'face', gender: 'female', url: '/char/female/face/head-01.glb' },
      { id: 'blond-face', label: 'blond', kind: 'face', gender: 'female', url: '/char/female/face/blond.glb' },
      { id: 'lady-face', label: 'lady', kind: 'face', gender: 'female', url: '/char/female/face/lady.glb' },
      { id: 'princess-face', label: 'princess', kind: 'face', gender: 'female', url: '/char/female/face/princess.glb' },
      { id: 'snowwhite-face', label: 'snow-white', kind: 'face', gender: 'female', url: '/char/female/face/snow-white.glb' },
      { id: 'southern-face', label: 'southern', kind: 'face', gender: 'female', url: '/char/female/face/southern.glb' },
    ],
  },
}

export type PartKind = PartVariant['kind']

/** Variants of one part kind offered by a gender (male body × head etc.). */
export function partsFor(gender: Gender, kind: PartKind): PartVariant[] {
  return GENDER_PARTS[gender]?.[kind] ?? []
}

/** The default (first) variant of a part for a gender. */
export function defaultVariant(gender: Gender, kind: PartKind): PartVariant {
  return partsFor(gender, kind)[0]
}

/** Whether a URL is one of a gender pool's built-in variants of this part. */
export function variantForUrl(
  gender: Gender,
  kind: PartKind,
  url: string,
): PartVariant | null {
  return partsFor(gender, kind).find((v) => v.url === url) ?? null
}

/** Infers the built-in gender from an asset path (null for custom URLs). */
export function genderFromAssets(assets: AvatarAssets): Gender | null {
  const url = `${assets.body} ${assets.face}`
  if (url.includes('/male/')) return 'male'
  if (url.includes('/female/')) return 'female'
  return null
}

/**
 * Default body placement per catalog body.
 *
 * Every `/char` rig body exports standing in the same frame, so the sample's
 * catalog shares one feet-sink: the body is dropped −0.045 m on the upright
 * −90° X home so its soles rest on the floor. Keyed per body URL so a single
 * export that needs a different rest height can override without touching the
 * uniform default.
 */
export const BODY_SINK_Y = -0.045

/** Per-body feet-sink overrides (body URL → sink in meters). Bodies that don't
 * share the uniform {@link BODY_SINK_Y} get an entry here. */
const BODY_SINK_OVERRIDES: Record<string, number> = {}

/** URLs of every catalog body (male + female pools). */
const CATALOG_BODY_URLS = new Set(
  Object.values(GENDER_PARTS)
    .flatMap((pool) => pool.body)
    .map((v) => v.url),
)

/**
 * The body placement a catalog combo falls back to when its pairing has no
 * stored tune: the upright −90° X home (core `defaultBodyFor`) plus the body's
 * feet-sink Y. Catalog bodies sit at {@link BODY_SINK_Y}; non-catalog / custom
 * URLs keep the core neutral home (Y = 0), since the SDK can't guess their
 * ground frame.
 */
export function bodyPlacementFor(bodyUrl: string): BodyInsertion {
  const home = defaultBodyFor(bodyUrl)
  if (!CATALOG_BODY_URLS.has(bodyUrl)) return home
  const sink = BODY_SINK_OVERRIDES[bodyUrl] ?? BODY_SINK_Y
  return { ...home, position: [0, sink, 0] }
}

/**
 * Builds a complete manifest, defaulting to the sample `/char` set: assets from
 * the requested gender (male by default), a natural head insertion, the upright
 * body home, and the default motion library (`/char/motion-2/fbx/stay`,
 * autoplaying `idle-breathing`). Implements the demo's defaults over the core
 * {@link assembleManifest}; see the core module for the asset-agnostic builder.
 */
export function makeDefaultManifest(input?: AvatarManifestInput): AvatarManifest {
  const gender: Gender | null = input?.gender ?? null
  const assets: AvatarAssets = {
    ...(gender ? GENDER_ASSETS[gender] : GENDER_ASSETS[DEFAULT_GENDER]),
    ...(input?.assets ?? {}),
  }
  const manifest = assembleManifest({
    ...input,
    gender,
    assets,
    genderDefaults: input?.genderDefaults ?? GENDER_ASSETS,
    body: input?.body ?? bodyPlacementFor(assets.body),
    motion: {
      clips: input?.motion?.clips?.length
        ? input.motion.clips
        : createMotionCatalog(),
      default: input?.motion?.default ?? 'idle-breathing',
      loop: input?.motion?.loop ?? true,
      speed: input?.motion?.speed ?? 1,
      playing: input?.motion?.playing ?? true,
    },
  })
  return { ...manifest, gender: gender ?? genderFromAssets(manifest.assets) }
}
