/**
 * Manifest core — schema validation, offset normalization, serialize/download
 * and the neutral `assembleManifest` builder.
 *
 * A manifest is the full description of one composed avatar: body + face asset
 * URLs, the head-bone insertion offsets, and the motion library. It can be
 * exported as JSON and fed back into `<Avatar manifest={…}>` to reconstruct the
 * same avatar.
 *
 * **Asset-agnostic by design.** This module knows nothing about specific
 * `/char/...` assets or the EffectNode sample set — that data lives in
 * `./sample/charAssets.ts`, which builds on `assembleManifest` below to layer
 * its own catalogs/defaults on top. Core only assumes the rig convention shared
 * by all its assets: rigs export lying along +Z, so `defaultBodyFor()` returns
 * a −90° X body "home" that stands the avatar up on its motion root.
 */

import { IDENTITY_HEAD, MANIFEST_SDK, MANIFEST_VERSION } from './types'
import type {
  AvatarAssets,
  AvatarManifest,
  AvatarManifestInput,
  AvatarOffsets,
  BodyInsertion,
  ComboOffsets,
  Gender,
  HeadInsertion,
  MotionConfig,
  Offset3,
} from './types'

function vec3(value: unknown, fallback: Offset3['position']): Offset3['position'] {
  return Array.isArray(value) && value.length === 3
    ? ([Number(value[0]), Number(value[1]), Number(value[2])] as Offset3['position'])
    : ([...fallback] as Offset3['position'])
}

/** An offset group with every missing axis defaulted to `fallback`'s. */
function offset3(
  value: Partial<Offset3> | null | undefined,
  fallback: Offset3,
): Offset3 {
  const src = value && typeof value === 'object' ? value : {}
  return {
    position: vec3(src.position, fallback.position),
    rotation: vec3(src.rotation, fallback.rotation),
    scale: vec3(src.scale, fallback.scale),
  }
}

/**
 * The upright "home" for a rigged export. Rig exports come out with their
 * armature lying along +Z (~0.97 m), so the SDK stands the composed avatar up
 * by rotating its motion root group −90° about X (+Z → +Y). This is applied as
 * the default body placement offset — on the avatar's own root (the group the
 * motion clip drives), not on the hosting scene — so `<Avatar>` renders upright
 * anywhere at identity. A combo that ships in a different frame (an
 * already-upright GLB, or one with its own twist) simply tunes its own body
 * offset to correct it.
 */
const BODY_HOME_ROTATION: Offset3['rotation'] = [-90, 0, 0]

/** Fresh identity offset group (position 0, rotation 0, scale 1). */
export function identityOffset(): Offset3 {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
}

/**
 * The body placement offset a combo starts from when its pairing hasn't been
 * tuned yet. Any URL defaults to the upright home (−90° X on the motion root),
 * because rigged exports are authored lying along +Z and the hosting scene no
 * longer stands them up; a tuned combo (stored in the manifest) or a custom
 * already-upright asset overrides it via its own offset.
 */
export function defaultBodyFor(_url: string): BodyInsertion {
  return {
    position: [0, 0, 0],
    rotation: [...BODY_HOME_ROTATION] as Offset3['rotation'],
    scale: [1, 1, 1],
  }
}

/**
 * Sanitize an optional per-combination offset table into a well-formed flat
 * array, dropping malformed/duplicate entries and defaulting any missing axes.
 *
 * Accepts the v2 shape — an array of {@link ComboOffsets} — and, for imports of
 * v1 manifests, the legacy nested `[body URL][face URL]` `headOffsets` object
 * (those entries get identity body placement and their stored head insertion).
 * Returns `undefined` when empty so it can be omitted from the manifest.
 */
export function normalizeOffsets(value: unknown): AvatarOffsets | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: AvatarOffsets = []
  const seen = new Set<string>()

  const push = (
    bodyUrl: unknown,
    faceUrl: unknown,
    raw:
      | { body?: Partial<BodyInsertion> | null; head?: Partial<HeadInsertion> | null }
      | null
      | undefined,
  ): void => {
    if (typeof bodyUrl !== 'string' || !bodyUrl) return
    if (typeof faceUrl !== 'string' || !faceUrl) return
    const key = `${bodyUrl}~${faceUrl}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      bodyUrl,
      faceUrl,
      body: offset3(raw?.body, defaultBodyFor(bodyUrl)),
      head: offset3(raw?.head, IDENTITY_HEAD),
    })
  }

  if (Array.isArray(value)) {
    // v2 flat namespace array.
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const raw = entry as Partial<ComboOffsets>
      push(e.bodyUrl ?? e.body, e.faceUrl ?? e.face, raw)
    }
  } else {
    // Legacy v1 object: { [bodyUrl]: { [faceUrl]: HeadInsertion } }.
    for (const [bodyUrl, faces] of Object.entries(value)) {
      if (!faces || typeof faces !== 'object') continue
      for (const [faceUrl, rawHead] of Object.entries(faces)) {
        push(bodyUrl, faceUrl, { head: rawHead as Partial<HeadInsertion> })
      }
    }
  }
  return out.length > 0 ? out : undefined
}

/**
 * Fills every optional slot so an `AvatarManifest` is always well-formed, using
 * only structure — no built-in asset catalog. Callers must supply concrete
 * `assets.body`/`assets.face` URLs (throws otherwise). The sample layer
 * (`./sample/charAssets.ts`) wraps this to add its own gender/asset/motion
 * defaults; `parseManifest` uses it directly for validated input.
 *
 * Not part of the public barrel — reach it through `parseManifest`,
 * `makeDefaultManifest` (sample) or by composing a manifest literal.
 */
export function assembleManifest(input?: AvatarManifestInput): AvatarManifest {
  const assets: AvatarAssets = {
    body: input?.assets?.body ?? '',
    face: input?.assets?.face ?? '',
  }
  if (!assets.body || !assets.face) {
    throw new Error('Manifest assets need both "body" and "face".')
  }
  const bodyDefault = defaultBodyFor(assets.body)
  const genderDefaults = normalizeGenderDefaults(input?.genderDefaults)
  const manifest: AvatarManifest = {
    sdk: MANIFEST_SDK,
    version: MANIFEST_VERSION,
    name: input?.name ?? 'avatar-01',
    gender: input?.gender ?? null,
    assets,
    headBone: input?.headBone ?? null,
    head: offset3(input?.head, IDENTITY_HEAD),
    body: offset3(input?.body, bodyDefault),
    offsets: normalizeOffsets(input?.offsets) ?? [],
    motion: {
      clips: input?.motion?.clips ?? [],
      default: input?.motion?.default ?? '',
      loop: input?.motion?.loop ?? true,
      speed: input?.motion?.speed ?? 1,
      playing: input?.motion?.playing ?? true,
    },
  }
  if (genderDefaults) manifest.genderDefaults = genderDefaults
  return manifest
}

/** Coerce a raw `genderDefaults` map, keeping only complete male/female entries. */
function normalizeGenderDefaults(
  value: Partial<Record<Gender, AvatarAssets>> | null | undefined,
): Partial<Record<Gender, AvatarAssets>> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const out: Partial<Record<Gender, AvatarAssets>> = {}
  for (const g of ['male', 'female'] as const) {
    const a = value[g]
    if (a && typeof a === 'object' && a.body && a.face) {
      out[g] = { body: a.body, face: a.face }
    }
  }
  return out.male || out.female ? out : undefined
}

const REQUIRED = ['assets', 'head'] as const

/**
 * Validates raw (possibly user-supplied / imported) JSON and returns a
 * normalized manifest. Throws `Error` with a readable message when invalid.
 *
 * Neutral: it fills structure only (no `/char` catalog). To also apply the
 * demo's asset/motion defaults, wrap the result with the sample
 * `makeDefaultManifest(...)`.
 */
export function parseManifest(json: unknown): AvatarManifest {
  if (!json || typeof json !== 'object') {
    throw new Error('Manifest must be a JSON object.')
  }
  const raw = json as AvatarManifestInput

  for (const key of REQUIRED) {
    if (!raw[key]) throw new Error(`Manifest is missing "${key}".`)
  }
  const assets = raw.assets as Partial<AvatarManifest['assets']> | undefined
  if (!assets?.body || !assets.face) {
    throw new Error('Manifest assets need both "body" and "face".')
  }
  const motion: Partial<MotionConfig> = raw.motion ?? {}
  if (motion.clips && !Array.isArray(motion.clips)) {
    throw new Error('Manifest motion.clips must be an array.')
  }

  return assembleManifest(raw)
}

export function serializeManifest(manifest: AvatarManifest): string {
  return JSON.stringify(manifest, null, 2)
}

/** Triggers a browser download of the manifest as `avatar.<name>.json`. */
export function downloadManifest(
  manifest: AvatarManifest,
  filename = `avatar-${manifest.name}.manifest.json`,
): void {
  const blob = new Blob([serializeManifest(manifest)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** Last path segment of a URL, for compact UI labels. */
export function basenameOf(url: string): string {
  const cleaned = url.split('?')[0].split('#')[0]
  return cleaned.split('/').filter(Boolean).pop() ?? url
}
