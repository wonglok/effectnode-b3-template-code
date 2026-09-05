/**
 * Avatar demo store — a zustand store that doubles as the manifest editor.
 *
 * Every field the sidebar can tune lives here; `makeDefaultManifest`/export
 * serializes the current state to a manifest, and import (file/url) replaces
 * the state from one.
 *
 * Avatar/tuning state is **not persisted** (no `zustand/persist`): the
 * checked-in `public/char/avatar.manifest.json` is the single source of truth.
 * `hydrateAvatarStore()` (awaited before first render) always fetches that file
 * and seeds the store from it, so any tuning is session-only and reloads fall
 * back to the file's contents.
 *
 * One exception: the **folder chosen for exporting `avatar.manifest.json`** (a
 * `FileSystemDirectoryHandle`) is remembered across reloads via localforage —
 * a UI convenience, not avatar state. The handle must keep working in the same
 * browser origin; permission is re-requested when you click "Write".
 *
 * Offsets are stored **per body × head combination**: `offsets` is a flat array
 * of combo namespaces (`ComboOffsets`), each carrying that pairing's `body`
 * placement offset and its `head` insertion offset. `head`/`body` on the state
 * are the live copies of the active combination's entry, so tuning writes
 * through to that pairing's namespace and switching either part recalls that
 * combination's stored tune (or the −90° X upright "home" factory default the
 * first time it is seen — rigs export lying along +Z and the body placement
 * stands them up).
 */

import localforage from 'localforage'
import { create } from 'zustand'

import {
  bodyPlacementFor,
  createMotionCatalog,
  DEFAULT_GENDER,
  downloadManifest,
  GENDER_ASSETS,
  genderFromAssets,
  identityOffset,
  makeDefaultManifest,
  MANIFEST_SDK,
  MANIFEST_VERSION,
  motionSectionClips,
  motionSectionForClips,
  MOTION_SECTIONS,
  parseManifest,
  serializeManifest,
} from '../../b3/b3-runtime/src/components/AvatarSDK'
import type {
  AvatarAssets,
  AvatarManifest,
  AvatarOffsets,
  BodyInsertion,
  ComboOffsets,
  Gender,
  HeadInsertion,
  MotionClipDef,
  Offset3,
  Vec3,
} from '../../b3/b3-runtime/src/components/AvatarSDK'
import type { AvatarConfig, LocomotionKey } from '../avatarLoader'

/** One of the three tunable offset axes/groups (`position`|`rotation`|`scale`). */
export type OffsetKey = keyof Offset3
export type Axis = 0 | 1 | 2

/** The four NavMeshRig locomotion states the Motion tab assigns stay clips to. */
export const LOCOMOTION_STATES: LocomotionKey[] = ['idle', 'walk', 'run', 'jump']

/** Candidate stay-locomotion clip names per rig state (shown in the Motion tab). */
export const RIG_STATE_CANDIDATES: Record<LocomotionKey, string[]> = {
  idle: ['idle-breathing', 'idle-neutral', 'idle-pose'],
  walk: ['walking', 'walking2'],
  run: ['running', 'rush'],
  jump: ['jumping'],
}

/** Default clip name per rig state. */
export const RIG_DEFAULT_CLIP_NAMES: Record<LocomotionKey, string> = {
  idle: 'idle-breathing',
  walk: 'walking',
  run: 'running',
  jump: 'jumping',
}

/** The `/char/motion-2/fbx/stay` library the four rig states pick from. */
const STAY_CLIPS = createMotionCatalog('/char/motion-2/fbx/stay')

function defaultRigClips(): Record<LocomotionKey, MotionClipDef> {
  const out = {} as Record<LocomotionKey, MotionClipDef>
  for (const key of LOCOMOTION_STATES) {
    const name = RIG_DEFAULT_CLIP_NAMES[key]
    out[key] =
      STAY_CLIPS.find((c) => c.name === name) ?? {
        name,
        url: `/char/motion-2/fbx/stay/${name}.fbx`,
      }
  }
  return out
}

interface AvatarState {
  name: string
  gender: Gender
  assets: AvatarAssets
  /**
   * Default body × head per gender (from the manifest's `genderDefaults`, or the
   * built-in catalog). Used the first time a gender is shown.
   */
  genderDefaults: Partial<Record<Gender, AvatarAssets>>
  /**
   * Last-picked body × head per gender, so toggling Male ⇄ Female recalls each
   * gender's chosen look instead of resetting to the default. UI-only.
   */
  assetsByGender: Partial<Record<Gender, AvatarAssets>>
  headBone: string | null
  /** Body placement offset of the *active* combo (live copy of `offsets[..].body`). */
  body: BodyInsertion
  /** Head-insertion offset of the *active* combo (live copy of `offsets[..].head`). */
  head: HeadInsertion
  /**
   * Per-combination offset namespaces, one element per stored body × head
   * pairing. Tuning writes through to the active combination's element, and
   * switching either part recalls that pairing's stored tune (or factory
   * defaults the first time).
   */
  offsets: AvatarOffsets
  clips: MotionClipDef[]
  /** Which motion library (`MOTION_SECTIONS` id) the clip chips come from. */
  motionSectionId: string
  /** Last active motion per section id, so toggling sections doesn't reset
   * each library to its default every time. UI-only (not serialized). */
  motionBySection: Record<string, string>
  activeMotion: string
  playing: boolean
  loop: boolean
  speed: number
  /** Stay clips feeding the NavMeshRig's four locomotion states. UI-only (not
   * serialized into the manifest — it describes a composed look, not a rig). */
  rigClips: Record<LocomotionKey, MotionClipDef>

  // ---- UI-only (not part of the manifest) ----
  detectedBone: string | null
  bodyVisible: boolean
  faceVisible: boolean
  nonce: number
  notice: string | null
  /** Folder the user picked for writing `avatar.manifest.json` (session-only). */
  exportDir: FileSystemDirectoryHandle | null
  exportDirName: string | null

  // ---- actions ----
  setName: (name: string) => void
  /** Switch to the male/female built-in character set. */
  setGender: (gender: Gender) => void
  setAsset: (kind: keyof AvatarAssets, url: string) => void
  setHeadBoneOverride: (value: string | null) => void
  setBodyAxis: (key: OffsetKey, axis: Axis, value: number) => void
  setBodyGroup: (key: OffsetKey, value: Offset3[OffsetKey]) => void
  setHeadAxis: (key: OffsetKey, axis: Axis, value: number) => void
  setHeadGroup: (key: OffsetKey, value: Offset3[OffsetKey]) => void
  resetBody: () => void
  resetHead: () => void
  /** Load a motion library's clips (replaces `clips`, recalls its active clip). */
  setMotionSection: (sectionId: string) => void
  setActiveMotion: (name: string) => void
  setPlaying: (value: boolean) => void
  setLoop: (value: boolean) => void
  setSpeed: (value: number) => void
  /** Assign one stay clip to one of the rig's four locomotion states. */
  setRigClip: (state: LocomotionKey, name: string) => void
  toggleBody: () => void
  toggleFace: () => void
  setDetectedBone: (name: string | null) => void
  setNotice: (text: string | null) => void

  /** Apply an externally parsed manifest (import / url) and remount avatar. */
  applyManifest: (manifest: AvatarManifest) => void
  importFromText: (text: string) => void
  importFromUrl: (url: string) => Promise<void>
  exportManifest: () => void
  /** Copy the serialized manifest JSON for the current state to the clipboard. */
  copyManifest: () => void
  /** Let the user pick a folder to receive the exported `avatar.manifest.json`. */
  pickManifestDir: () => Promise<void>
  /** Write `avatar.manifest.json` for the current state into the picked folder. */
  writeManifestFile: () => Promise<void>
  resetAll: () => void
}

/** Serialize the store's editor fields back into a shareable manifest. */
function toManifest(state: AvatarState): AvatarManifest {
  const manifest: AvatarManifest = {
    sdk: MANIFEST_SDK,
    version: MANIFEST_VERSION,
    name: state.name,
    gender: state.gender,
    assets: state.assets,
    headBone: state.headBone,
    head: state.head,
    body: state.body,
    offsets: state.offsets,
    motion: {
      clips: state.clips,
      default: state.activeMotion,
      loop: state.loop,
      speed: state.speed,
      playing: state.playing,
    },
  }
  const keys = Object.keys(state.genderDefaults) as Gender[]
  const genderDefaults: AvatarManifest['genderDefaults'] = {}
  for (const g of keys) {
    const a = state.genderDefaults[g]
    if (a?.body && a?.face) genderDefaults[g] = { body: a.body, face: a.face }
  }
  if (genderDefaults && Object.keys(genderDefaults).length) {
    manifest.genderDefaults = genderDefaults
  }
  return manifest
}

const DEFAULTS = makeDefaultManifest()

function cloneOffset(offset: Offset3): Offset3 {
  return {
    position: [...offset.position] as Vec3,
    rotation: [...offset.rotation] as Vec3,
    scale: [...offset.scale] as Vec3,
  }
}

/** Clone the per-gender default assets map, dropping empty entries. */
function cloneGenderDefaults(
  defaults: Partial<Record<Gender, AvatarAssets>>,
): Partial<Record<Gender, AvatarAssets>> {
  const out: Partial<Record<Gender, AvatarAssets>> = {}
  for (const g of ['male', 'female'] as const) {
    const a = defaults[g]
    if (a?.body && a?.face) out[g] = { body: a.body, face: a.face }
  }
  return out
}

/**
 * Initial per-gender pick memory: the active gender starts on the manifest's
 * own `assets`, every other gender on its recorded default (so toggling to a
 * gender you haven't visited shows that gender's default, and returning to the
 * active one keeps what you had).
 */
function seedAssetsByGender(
  activeGender: Gender,
  activeAssets: AvatarAssets,
  defaults: Partial<Record<Gender, AvatarAssets>>,
): Partial<Record<Gender, AvatarAssets>> {
  const out = cloneGenderDefaults(defaults)
  out[activeGender] = { body: activeAssets.body, face: activeAssets.face }
  return out
}

function cloneEntry(entry: ComboOffsets): ComboOffsets {
  return {
    bodyUrl: entry.bodyUrl,
    faceUrl: entry.faceUrl,
    body: cloneOffset(entry.body),
    head: cloneOffset(entry.head),
  }
}

function cloneOffsets(offsets: AvatarOffsets): AvatarOffsets {
  return offsets.map(cloneEntry)
}

/** Index of a body × face namespace in the flat `offsets` array (−1 if absent). */
function findIndex(
  offsets: AvatarOffsets,
  bodyUrl: string,
  faceUrl: string,
): number {
  return offsets.findIndex(
    (e) => e.bodyUrl === bodyUrl && e.faceUrl === faceUrl,
  )
}

/** `offsets` with the `[bodyUrl][faceUrl]` namespace (re)stored to `values`. */
function upsertEntry(
  offsets: AvatarOffsets,
  bodyUrl: string,
  faceUrl: string,
  values: { body: Offset3; head: Offset3 },
): AvatarOffsets {
  const entry: ComboOffsets = {
    bodyUrl,
    faceUrl,
    body: cloneOffset(values.body),
    head: cloneOffset(values.head),
  }
  const index = findIndex(offsets, bodyUrl, faceUrl)
  if (index < 0) return [...offsets, entry]
  const next = offsets.slice()
  next[index] = entry
  return next
}

/** `offsets` with the `[bodyUrl][faceUrl]` namespace removed (if present). */
function removeEntry(
  offsets: AvatarOffsets,
  bodyUrl: string,
  faceUrl: string,
): AvatarOffsets {
  const index = findIndex(offsets, bodyUrl, faceUrl)
  if (index < 0) return offsets
  const next = offsets.slice()
  next.splice(index, 1)
  return next
}

/** Live body+head values for a combo: stored tune if present, else factory
 * defaults (body → this body's intrinsic placement; head → identity). */
function liveCombo(
  offsets: AvatarOffsets,
  bodyUrl: string,
  faceUrl: string,
): { body: Offset3; head: Offset3 } {
  const index = findIndex(offsets, bodyUrl, faceUrl)
  if (index >= 0) {
    const entry = offsets[index]
    return { body: cloneOffset(entry.body), head: cloneOffset(entry.head) }
  }
  return { body: bodyPlacementFor(bodyUrl), head: identityOffset() }
}

/** Write one axis of one offset group into an offset, returning a new object. */
function withAxis(
  offset: Offset3,
  key: OffsetKey,
  axis: Axis,
  value: number,
): Offset3 {
  const group = [...offset[key]] as Offset3[OffsetKey]
  group[axis] = value
  return { ...offset, [key]: group } as Offset3
}

/** Write a whole offset group into an offset, returning a new object. */
function withGroup(
  offset: Offset3,
  key: OffsetKey,
  value: Offset3[OffsetKey],
): Offset3 {
  return { ...offset, [key]: [...value] as Offset3[OffsetKey] } as Offset3
}

/** Near-equality across every axis (reset bookkeeping, not user-visible). */
function offsetEquals(a: Offset3, b: Offset3): boolean {
  const eps = 1e-6
  return (
    a.position.every((v, i) => Math.abs(v - b.position[i]) < eps) &&
    a.rotation.every((v, i) => Math.abs(v - b.rotation[i]) < eps) &&
    a.scale.every((v, i) => Math.abs(v - b.scale[i]) < eps)
  )
}

const DEFAULT_MANIFEST_URL = '/char/avatar.manifest.json'

/** localforage key for the remembered manifest-export folder handle. */
const EXPORT_DIR_KEY = 'mixamo-adapter.manifest-export-dir'

/**
 * Checked-in default manifest (`public/char/avatar.manifest.json`) — the app's
 * shipped defaults, loaded at boot by `hydrateAvatarStore()`. Used for first-run
 * seeding and "Reset all"; falls back to the built-in `makeDefaultManifest()`
 * if the file can't be fetched.
 */
let fileDefaults: AvatarManifest | null = null
function defaultManifest(): AvatarManifest {
  return fileDefaults ?? makeDefaultManifest()
}

/** Non-notice store state described by a manifest (first-run / reset seed). */
function stateFromManifest(manifest: AvatarManifest) {
  const head = cloneOffset(manifest.head)
  const body = cloneOffset(manifest.body)
  const { body: bodyUrl, face: faceUrl } = manifest.assets
  // Always seed the active combo's namespace so exports round-trip it; older
  // manifests may carry the tune only on `head`/`body` without an `offsets` row.
  const offsets = upsertEntry(
    cloneOffsets(manifest.offsets ?? []),
    bodyUrl,
    faceUrl,
    { body, head },
  )
  return {
    name: manifest.name,
    gender:
      manifest.gender ??
      genderFromAssets(manifest.assets) ??
      DEFAULT_GENDER,
    assets: { ...manifest.assets },
    genderDefaults: cloneGenderDefaults(
      manifest.genderDefaults ?? GENDER_ASSETS,
    ),
    assetsByGender: seedAssetsByGender(
      manifest.gender ?? genderFromAssets(manifest.assets) ?? DEFAULT_GENDER,
      manifest.assets,
      manifest.genderDefaults ?? GENDER_ASSETS,
    ),
    headBone: manifest.headBone,
    body,
    head,
    offsets,
    clips: manifest.motion.clips.map((c) => ({ ...c })),
    motionSectionId: motionSectionForClips(manifest.motion.clips).id,
    motionBySection: {
      [motionSectionForClips(manifest.motion.clips).id]: manifest.motion.default,
    },
    activeMotion: manifest.motion.default,
    loop: manifest.motion.loop,
    speed: manifest.motion.speed,
    playing: manifest.motion.playing,
    rigClips: defaultRigClips(),
    detectedBone: null,
  }
}

export const useAvatarStore = create<AvatarState>()((set, get) => ({
  name: DEFAULTS.name,
  gender: DEFAULTS.gender ?? DEFAULT_GENDER,
  assets: { ...DEFAULTS.assets },
  genderDefaults: cloneGenderDefaults(
    DEFAULTS.genderDefaults ?? GENDER_ASSETS,
  ),
  assetsByGender: seedAssetsByGender(
    DEFAULTS.gender ?? DEFAULT_GENDER,
    DEFAULTS.assets,
    DEFAULTS.genderDefaults ?? GENDER_ASSETS,
  ),
  headBone: DEFAULTS.headBone,
  body: cloneOffset(DEFAULTS.body),
  head: cloneOffset(DEFAULTS.head),
  offsets: cloneOffsets(DEFAULTS.offsets ?? []),
  clips: DEFAULTS.motion.clips.map((c) => ({ ...c })),
  motionSectionId: motionSectionForClips(DEFAULTS.motion.clips).id,
  motionBySection: {
    [motionSectionForClips(DEFAULTS.motion.clips).id]: DEFAULTS.motion.default,
  },
  activeMotion: DEFAULTS.motion.default,
  playing: DEFAULTS.motion.playing,
  loop: DEFAULTS.motion.loop,
  speed: DEFAULTS.motion.speed,
  rigClips: defaultRigClips(),

  detectedBone: null,
  bodyVisible: true,
  faceVisible: true,
  nonce: 0,
  notice: null,
  exportDir: null,
  exportDirName: null,

  setName: (name) => set({ name }),
  setGender: (gender) =>
    set((s) => {
      // Remember the look we're leaving, then switch to this gender's own
      // last-picked body × head (falling back to its recorded default the
      // first time it's visited) so toggling Male ⇄ Female doesn't reset picks.
      const leaving = s.gender
      const next: AvatarAssets =
        s.assetsByGender[gender] ??
        s.genderDefaults[gender] ??
        GENDER_ASSETS[gender]
      const assets = { body: next.body, face: next.face }
      const live = liveCombo(s.offsets, assets.body, assets.face)
      // Both the session memory and the persisted default follow the combo each
      // gender is last shown with, so an export/Write bakes the latest picks.
      const leavingCombo = { body: s.assets.body, face: s.assets.face }
      const arrivingCombo = { body: assets.body, face: assets.face }
      return {
        gender,
        assets,
        assetsByGender: {
          ...s.assetsByGender,
          [leaving]: leavingCombo,
          [gender]: arrivingCombo,
        },
        genderDefaults: {
          ...s.genderDefaults,
          [leaving]: leavingCombo,
          [gender]: arrivingCombo,
        },
        body: live.body,
        head: live.head,
        detectedBone: null,
        nonce: s.nonce + 1,
        notice: `Switched to ${gender} character`,
      }
    }),
  setAsset: (kind, url) =>
    set((s) => {
      const assets = { ...s.assets, [kind]: url }
      // Swapping either part changes the combination → recall that pairing's
      // own stored tune (or factory defaults the first time).
      const live = liveCombo(s.offsets, assets.body, assets.face)
      const combo = { body: assets.body, face: assets.face }
      return {
        assets,
        assetsByGender: {
          ...s.assetsByGender,
          [s.gender]: combo,
        },
        genderDefaults: {
          ...s.genderDefaults,
          [s.gender]: combo,
        },
        body: live.body,
        head: live.head,
        detectedBone: null,
        nonce: s.nonce + 1,
      }
    }),
  setHeadBoneOverride: (headBone) => set({ headBone }),

  setBodyAxis: (key, axis, value) =>
    set((s) => {
      const body = withAxis(s.body, key, axis, value)
      return {
        body,
        offsets: upsertEntry(s.offsets, s.assets.body, s.assets.face, {
          body,
          head: s.head,
        }),
      }
    }),
  setBodyGroup: (key, value) =>
    set((s) => {
      const body = withGroup(s.body, key, value)
      return {
        body,
        offsets: upsertEntry(s.offsets, s.assets.body, s.assets.face, {
          body,
          head: s.head,
        }),
      }
    }),
  setHeadAxis: (key, axis, value) =>
    set((s) => {
      const head = withAxis(s.head, key, axis, value)
      return {
        head,
        offsets: upsertEntry(s.offsets, s.assets.body, s.assets.face, {
          body: s.body,
          head,
        }),
      }
    }),
  setHeadGroup: (key, value) =>
    set((s) => {
      const head = withGroup(s.head, key, value)
      return {
        head,
        offsets: upsertEntry(s.offsets, s.assets.body, s.assets.face, {
          body: s.body,
          head,
        }),
      }
    }),

  resetBody: () =>
    set((s) => {
      const { body: bodyUrl, face: faceUrl } = s.assets
      const defaultBody = bodyPlacementFor(bodyUrl)
      let offsets = s.offsets
      const index = findIndex(offsets, bodyUrl, faceUrl)
      if (index >= 0) {
        const entry = offsets[index]
        if (offsetEquals(entry.head, identityOffset())) {
          // Nothing but the body was tuned → drop the whole namespace.
          offsets = removeEntry(offsets, bodyUrl, faceUrl)
        } else {
          offsets = upsertEntry(offsets, bodyUrl, faceUrl, {
            body: defaultBody,
            head: entry.head,
          })
        }
      }
      const live = liveCombo(offsets, bodyUrl, faceUrl)
      return { offsets, body: live.body, head: live.head }
    }),
  resetHead: () =>
    set((s) => {
      const { body: bodyUrl, face: faceUrl } = s.assets
      const defaultBody = bodyPlacementFor(bodyUrl)
      let offsets = s.offsets
      const index = findIndex(offsets, bodyUrl, faceUrl)
      if (index >= 0) {
        const entry = offsets[index]
        if (offsetEquals(entry.body, defaultBody)) {
          // Nothing but the head was tuned → drop the whole namespace.
          offsets = removeEntry(offsets, bodyUrl, faceUrl)
        } else {
          offsets = upsertEntry(offsets, bodyUrl, faceUrl, {
            body: entry.body,
            head: identityOffset(),
          })
        }
      }
      const live = liveCombo(offsets, bodyUrl, faceUrl)
      return { offsets, body: live.body, head: live.head }
    }),

  setMotionSection: (sectionId) =>
    set((s) => {
      const section = MOTION_SECTIONS.find((sec) => sec.id === sectionId)
      if (!section) return {}
      // Switching libraries keeps each section's own last-picked clip, so
      // toggling back to "stay" doesn't lose the clip you were testing.
      const remembered = s.motionBySection[section.id]
      const activeMotion =
        remembered ??
        (section.names.includes(s.activeMotion) ? s.activeMotion : section.default)
      return {
        motionSectionId: section.id,
        clips: motionSectionClips(section),
        activeMotion,
        motionBySection: { ...s.motionBySection, [section.id]: activeMotion },
        notice: `Switched to ${section.label} motions`,
      }
    }),
  setActiveMotion: (activeMotion) =>
    set((s) => ({
      activeMotion,
      motionBySection: {
        ...s.motionBySection,
        [s.motionSectionId]: activeMotion,
      },
    })),
  setPlaying: (playing) => set({ playing }),
  setLoop: (loop) => set({ loop }),
  setSpeed: (speed) => set({ speed }),
  setRigClip: (state, name) =>
    set((s) => {
      const def = STAY_CLIPS.find((c) => c.name === name)
      if (!def || s.rigClips[state]?.name === name) return {}
      return {
        rigClips: { ...s.rigClips, [state]: def },
        notice: `Rig ${state} → ${name}`,
      }
    }),
  toggleBody: () => set((s) => ({ bodyVisible: !s.bodyVisible })),
  toggleFace: () => set((s) => ({ faceVisible: !s.faceVisible })),
  setDetectedBone: (detectedBone) => set({ detectedBone }),
  setNotice: (notice) => set({ notice }),

  applyManifest: (manifest) => {
    const head = cloneOffset(manifest.head)
    const body = cloneOffset(manifest.body)
    const { body: bodyUrl, face: faceUrl } = manifest.assets
    // Restore every stored combination carried by the manifest, then make sure
    // the active combo's namespace reflects the manifest `head`/`body`.
    const offsets = upsertEntry(
      cloneOffsets(manifest.offsets ?? []),
      bodyUrl,
      faceUrl,
      { body, head },
    )
    set({
      name: manifest.name,
      gender:
        manifest.gender ??
        genderFromAssets(manifest.assets) ??
        DEFAULT_GENDER,
      assets: { ...manifest.assets },
      genderDefaults: cloneGenderDefaults(
        manifest.genderDefaults ?? GENDER_ASSETS,
      ),
      assetsByGender: seedAssetsByGender(
        manifest.gender ?? genderFromAssets(manifest.assets) ?? DEFAULT_GENDER,
        manifest.assets,
        manifest.genderDefaults ?? GENDER_ASSETS,
      ),
      headBone: manifest.headBone,
      body,
      head,
      offsets,
      clips: manifest.motion.clips.map((c) => ({ ...c })),
      motionSectionId: motionSectionForClips(manifest.motion.clips).id,
      motionBySection: {
        [motionSectionForClips(manifest.motion.clips).id]:
          manifest.motion.default,
      },
      activeMotion: manifest.motion.default,
      loop: manifest.motion.loop,
      speed: manifest.motion.speed,
      playing: manifest.motion.playing,
      rigClips: defaultRigClips(),
      detectedBone: null,
      nonce: get().nonce + 1,
      notice: `Loaded “${manifest.name}”`,
    })
  },
  importFromText: (text) => {
    try {
      // Neutral `parseManifest` validates/normalizes structure only; re-run
      // through the sample builder so partial imports still land with the
      // demo's `/char` catalog, motion default and inferred gender.
      const manifest = makeDefaultManifest(parseManifest(JSON.parse(text)))
      get().applyManifest(manifest)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ notice: `Import failed: ${message}` })
    }
  },
  importFromUrl: async (url) => {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`${res.status} ${url}`)
      get().importFromText(await res.text())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ notice: `Import failed: ${message}` })
    }
  },
  exportManifest: () => downloadManifest(toManifest(get())),
  copyManifest: () => {
    const text = serializeManifest(toManifest(get()))
    const done = (): void => set({ notice: 'Copied manifest JSON to clipboard' })
    const failed = (): void =>
      set({ notice: 'Copy failed — clipboard unavailable' })
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, failed)
    } else {
      // Non-secure-context fallback (e.g. http on a LAN host).
      const area = document.createElement('textarea')
      area.value = text
      area.setAttribute('readonly', '')
      area.style.position = 'absolute'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      try {
        if (document.execCommand('copy')) done()
        else failed()
      } catch {
        failed()
      } finally {
        area.remove()
      }
    }
  },
  resetAll: () => {
    const defaults = defaultManifest()
    set({
      ...stateFromManifest(defaults),
      nonce: get().nonce + 1,
      notice: 'Reset to defaults',
    })
  },
  pickManifestDir: async () => {
    // File System Access API isn't in every TS DOM lib — read it loosely.
    const picker = (
      window as Window & {
        showDirectoryPicker?: (options?: {
          id?: string
          mode?: 'readwrite'
        }) => Promise<FileSystemDirectoryHandle>
      }
    ).showDirectoryPicker
    if (typeof picker !== 'function') {
      set({
        notice:
          'Folder picker needs a Chromium browser — use "Export JSON" instead.',
      })
      return
    }
    try {
      const dir = await picker.call(window, {
        id: 'mixamo-adapter-manifest-out',
        mode: 'readwrite',
      })
      set({ exportDir: dir, exportDirName: dir.name })
      // Remember the handle so the write button survives a reload. The
      // browser only lets structured-cloneable handles into IndexedDB, so a
      // failed persist is non-fatal (the in-memory handle still works).
      try {
        await localforage.setItem(EXPORT_DIR_KEY, dir)
      } catch {
        // Non-IndexedDB driver or quota — keep the session handle only.
      }
    } catch {
      // User dismissed the picker — leave the folder untouched.
    }
  },
  writeManifestFile: async () => {
    const s = get()
    const dir = s.exportDir
    if (!dir) {
      set({ notice: 'Choose an export folder first.' })
      return
    }
    try {
      // A handle restored from localforage may need its permission re-granted.
      // The click that reaches here is a user gesture, so requestPermission is
      // allowed; if it was already granted (or the browser has no such API)
      // this is a no-op.
      const withPerm = dir as FileSystemDirectoryHandle & {
        queryPermission?: (o?: { mode: 'readwrite' }) => Promise<string>
        requestPermission?: (o?: { mode: 'readwrite' }) => Promise<string>
      }
      if (typeof withPerm.queryPermission === 'function') {
        const state = await withPerm.queryPermission({ mode: 'readwrite' })
        if (state !== 'granted' && typeof withPerm.requestPermission === 'function') {
          await withPerm.requestPermission({ mode: 'readwrite' })
        }
      }
      const handle = await dir.getFileHandle('avatar.manifest.json', {
        create: true,
      })
      const writable = await handle.createWritable()
      await writable.write(serializeManifest(toManifest(get())))
      await writable.close()
      set({ notice: `Wrote avatar.manifest.json → ${dir.name}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      set({ notice: `Write failed: ${message}` })
    }
  },
}))

// ---- boot: seed from the checked-in default manifest ----

/**
 * Load `public/char/avatar.manifest.json` and seed the store from it. There is
 * no persistence layer — every boot (and "Reset all") starts from this file;
 * `makeDefaultManifest()` is only the offline fallback when the fetch fails.
 * Must be awaited before the first render (e.g. in `main.tsx`) so the UI never
 * flashes the built-in defaults over the file's contents.
 */
/**
 * Restore the remembered manifest-export folder (a `FileSystemDirectoryHandle`
 * kept in localforage) so the "Write avatar.manifest.json" button still points
 * at the folder chosen in a previous session. Permission is re-checked on write.
 */
export async function restoreManifestExportDir(): Promise<void> {
  try {
    const dir =
      await localforage.getItem<FileSystemDirectoryHandle>(EXPORT_DIR_KEY)
    useAvatarStore.setState(
      dir ? { exportDir: dir, exportDirName: dir.name } : {},
    )
  } catch {
    // Ignore — the export-folder convenience is best-effort.
  }
}

export async function hydrateAvatarStore(): Promise<void> {
  try {
    const res = await fetch(DEFAULT_MANIFEST_URL)
    if (res.ok) {
      fileDefaults = makeDefaultManifest(parseManifest(JSON.parse(await res.text())))
    }
  } catch (error) {
    console.warn('[avatar] failed to load default manifest:', error)
  }
  useAvatarStore.setState({
    ...stateFromManifest(defaultManifest()),
    bodyVisible: true,
    faceVisible: true,
    nonce: useAvatarStore.getState().nonce + 1,
  })
  // Re-attach the remembered export folder (best-effort, after avatar seed).
  await restoreManifestExportDir()
}

/** Manifest + rig-clip snapshot the NavMeshRig consumes to build its avatar. */
export function avatarConfigSnapshot(): AvatarConfig {
  const state = useAvatarStore.getState()
  return { manifest: toManifest(state), clips: state.rigClips }
}

