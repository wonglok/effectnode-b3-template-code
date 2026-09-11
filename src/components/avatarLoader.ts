'use client'

/**
 * Avatar loader for the NavMeshRig character, rebuilt on the AvatarSDK.
 *
 * Previously this module loaded one bespoke `/character/avatar2/avatar.glb` and
 * bound four raw FBX clips to it by hand. It now composes a proper SDK avatar —
 * a rigged body GLB + a face/head GLB seated on the shared mixamorig skeleton
 * (`/char` catalog) — stands it up with the manifest's body offset, and remaps
 * the four locomotion clips (idle / walk / run / jump) onto that skeleton.
 *
 * The NavMeshRig drives *where* the character is and *how fast* it moves, so it
 * owns the group position on the navmesh. Motion clips are therefore expected to
 * be "in place" — any root translation the FBX carries is discarded (the jump
 * clip's hop is frozen at its standing value) so the character never drifts or
 * hops *inside* the player group.
 *
 * The SDK's `<Avatar>` React component plays a single clip at a time and is the
 * documented consumer path (see AvatarSDK/README.md). That model can't express
 * the rig's four-way weighted blend (crossfading idle/walk/run while a jump arcs
 * over the top), so this loader reuses the SDK's *assembly* primitives
 * (headCompose / attachHead / motion remap) and exposes a small imperative
 * controller the NavMeshRig's existing per-frame engine can drive unchanged.
 */

import * as THREE from 'three'

import { UPRIGHT_REVEAL, applyBodyOffset, uprightFraction } from '../b3/b3-runtime/src/components/AvatarSDK/avatarPose'
import { loadGLB } from '../b3/b3-runtime/src/components/AvatarSDK/decoders'
import {
    classifyHeadCompose,
    createHeadAttachment,
    type HeadComposePlan,
} from '../b3/b3-runtime/src/components/AvatarSDK/headCompose'
import { parseManifest } from '../b3/b3-runtime/src/components/AvatarSDK/manifest'
import { loadMotionClips } from '../b3/b3-runtime/src/components/AvatarSDK/motionLibrary'
import { findBone, restrictClipToRoot } from '../b3/b3-runtime/src/components/AvatarSDK/rig'
import { makeDefaultManifest } from '../b3/b3-runtime/src/components/AvatarSDK/sample/charAssets'
import type {
    AvatarManifest,
    BodyInsertion,
    HeadInsertion,
    MotionClipDef,
} from '../b3/b3-runtime/src/components/AvatarSDK/types'

// ---------------------------------------------------------------------------
// Look + motion configuration
// ---------------------------------------------------------------------------

/**
 * HTTP source of the saved character manifest (body × face URLs, every tuned
 * body/face offset, and the motion library). This is the served URL of the file
 * the user edits on disk:
 *   `public/char/avatar.manifest.json`  →  GET `/char/avatar.manifest.json`
 * It is the sole source of the NavMeshRig character data.
 */
export const DEFAULT_MANIFEST_URL = '/char/avatar.manifest.json'

/** Locomotion states the NavMeshRig blends between. */
export type LocomotionKey = 'idle' | 'walk' | 'run' | 'jump'
/** Target weights (0..1) per locomotion state, fed to `AvatarRig.blend`. */
export type LocomotionTargets = Record<LocomotionKey, number>

/**
 * Names the SDK's stay library (`/char/motion-2/fbx/stay`) gives each
 * locomotion state. A manifest's `motion.clips` is searched for one of these;
 * unknown names fall back to the same stay folder.
 */
const LOCOMOTION_SYNONYMS: Record<LocomotionKey, string[]> = {
    idle: ['idle-breathing', 'idle-neutral', 'idle-pose'],
    walk: ['walking', 'walking2'],
    run: ['running', 'rush'],
    jump: ['jumping', 'jump'],
}
const STAY_FBX = '/char/motion-2/fbx/stay'

/** The four locomotion states a NavMeshRig avatar blends between. */
export const LOCOMOTION_KEYS: LocomotionKey[] = ['idle', 'walk', 'run', 'jump']

/** Cadence correction for the walk clip (matches the character's navmesh speed). */
const WALK_TIMESCALE = 1.5

/**
 * GET the persisted character manifest over HTTP and validate it. Throws when
 * the fetch fails or the JSON doesn't parse as a manifest — callers decide how
 * to fall back. `cache: "no-cache"` revalidates so edits to the file on disk
 * (e.g. switching the look in `avatar.manifest.json`) show up on the next load.
 */
export async function loadSavedManifest(): Promise<AvatarManifest> {
    const res = await fetch(DEFAULT_MANIFEST_URL, {
        method: 'GET',
        cache: 'no-cache',
    })
    if (!res.ok) {
        throw new Error(`[avatarLoader] GET ${DEFAULT_MANIFEST_URL} → HTTP ${res.status}`)
    }
    return parseManifest(await res.json())
}

/** Convenience used by `loadAvatar()`: the saved manifest from
 *  `public/char/avatar.manifest.json` (via GET), with the SDK's sample default
 *  male look (swat × chinese) only as a last resort when the GET/parse fails. */
export async function fetchSavedManifest(): Promise<AvatarManifest> {
    try {
        return await loadSavedManifest()
    } catch (error) {
        console.warn('[avatarLoader] Failed to GET saved manifest — using sample default.', error)
        return makeDefaultManifest({ gender: 'male' })
    }
}

/**
 * Resolve the four locomotion clips out of a manifest's motion library.
 * Each state maps to one stay-clip whose name matches its synonym list, with a
 * hardcoded `/char/motion-2/fbx/stay` fallback so the rig still works even for a
 * manifest whose motion list only carries, say, breakdance poses.
 */
function resolveLocomotionDefs(manifest: AvatarManifest): Record<LocomotionKey, MotionClipDef> {
    const byName = new Map(manifest.motion.clips.map((c) => [c.name, c]))
    const out = {} as Record<LocomotionKey, MotionClipDef>
    for (const key of LOCOMOTION_KEYS) {
        const found = LOCOMOTION_SYNONYMS[key].map((name) => byName.get(name)).find((c): c is MotionClipDef => !!c)
        out[key] = found ?? { name: LOCOMOTION_SYNONYMS[key][0], url: `${STAY_FBX}/${LOCOMOTION_SYNONYMS[key][0]}.fbx` }
    }
    return out
}

// ---------------------------------------------------------------------------
// Clip helpers
// ---------------------------------------------------------------------------

/** First bone under a scene (the mixamo rig always roots at the hips). */
function findFirstBone(root: THREE.Object3D): THREE.Bone | null {
    let hit: THREE.Bone | null = null
    root.traverse((o) => {
        const b = o as THREE.Bone
        if (!hit && b.isBone) hit = b
    })
    return hit
}

/**
 * The rig owns the group's position, so the *root* (hips) translation an FBX
 * carries — the clip's own hop/drift — is discarded. This returns a copy of
 * `clip` whose root `.position` track is frozen at its first (standing) value.
 * The track must still animate so the mixer never drops the hips to the bind
 * pose and sinks the model while the action is running.
 */
function freezeClipRootPosition(clip: THREE.AnimationClip, bodyScene: THREE.Object3D): THREE.AnimationClip {
    const root = findBone(bodyScene, 'mixamorig:Hips') ?? findBone(bodyScene, 'Hips') ?? findFirstBone(bodyScene)
    if (!root) return clip

    const trackName = `${root.name}.position`
    const source = clip.tracks.find((t) => t.name === trackName)
    if (!source) return clip

    const TrackClass = source.constructor as new (
        name: string,
        times: ArrayLike<number>,
        values: ArrayLike<number>,
    ) => THREE.KeyframeTrack
    const size = source.getValueSize()
    const times = source.times.slice()
    const base = source.values.slice(0, size)
    const values = new Float32Array(times.length * size)
    for (let i = 0; i < times.length; i++) values.set(base, i * size)

    const next = clip.clone()
    next.tracks = clip.tracks.map((t) => (t.name === trackName ? new TrackClass(trackName, times, values) : t))
    return next
}

/**
 * Removes the root's **linear XZ travel** — the net forward distance a clip
 * carries the character — while leaving the vertical bob and the in-place sway
 * alone.
 *
 * Weapon-pack clips are authored to travel: `shooter/walking` moves 83.6 units
 * and `gun/run-forward` 148.1 over one loop, which walks the avatar straight off
 * its navmesh position and snaps back on every repeat. `freezeClipRootPosition`
 * would fix that too, but it collapses the whole track to its first value and so
 * also flattens the bob (4.9 units on the peace walk, 6.2 on the armed run).
 *
 * Subtracting the endpoint-to-endpoint trend pins frame 0 exactly as authored —
 * important because the rig applies no positional compensation, so the clip's
 * first frame *is* the reference stance. A clip with no net drift returns the
 * **same object**, allocation-free, which is what makes it safe to run over
 * every locomotion clip unconditionally.
 */
function stripClipTravel(clip: THREE.AnimationClip, bodyScene: THREE.Object3D): THREE.AnimationClip {
    const root = findBone(bodyScene, 'mixamorig:Hips') ?? findBone(bodyScene, 'Hips') ?? findFirstBone(bodyScene)
    if (!root) return clip

    const trackName = `${root.name}.position`
    const source = clip.tracks.find((t) => t.name === trackName)
    if (!source || source.getValueSize() < 3) return clip

    const times = source.times as ArrayLike<number>
    const n = times.length
    const span = n > 0 ? times[n - 1] - times[0] : 0
    if (n < 2 || span <= 0) return clip

    const size = source.getValueSize()
    const v = source.values
    const dx = v[(n - 1) * size] - v[0]
    const dz = v[(n - 1) * size + 2] - v[2]
    if (dx === 0 && dz === 0) return clip // already in place — no clone, same identity

    const TrackClass = source.constructor as new (
        name: string,
        times: ArrayLike<number>,
        values: ArrayLike<number>,
    ) => THREE.KeyframeTrack
    const values = Float32Array.from(v as ArrayLike<number>)
    for (let i = 0; i < n; i++) {
        const u = (times[i] - times[0]) / span
        values[i * size] -= dx * u
        values[i * size + 2] -= dz * u
        // Y is deliberately untouched, so the bob survives the de-trend.
    }

    const next = clip.clone()
    next.tracks = clip.tracks.map((t) => (t.name === trackName ? new TrackClass(trackName, times, values) : t))
    return next
}

/**
 * The root-motion treatment for one state's clip. `jump` is always fully
 * frozen (the rig drives the arc ballistically, so the clip's own hop is
 * discarded); everything else is de-trended only when the set asks for it.
 */
function deriveBodyClip(
    key: LocomotionKey,
    clip: THREE.AnimationClip | null,
    bodyScene: THREE.Object3D,
    stripTravel: boolean,
): THREE.AnimationClip | null {
    if (!clip) return null
    if (key === 'jump') return freezeClipRootPosition(clip, bodyScene)
    return stripTravel ? stripClipTravel(clip, bodyScene) : clip
}

/** Start one looping clip on a mixer at a given weight. */
function playClip(
    mixer: THREE.AnimationMixer,
    clip: THREE.AnimationClip | null,
    weight: number,
    timeScale = 1,
): THREE.AnimationAction | null {
    if (!clip) return null
    const action = mixer.clipAction(clip)
    action.loop = THREE.LoopRepeat
    action.weight = weight
    action.timeScale = timeScale
    action.play()
    return action
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * The composed, SDK-built avatar plus the small imperative controller the
 * NavMeshRig drives each frame. `scene` is the group to add under the player
 * group; the rest replace the mixer/action plumbing the rig used to own.
 */
/** Which clip each rig state uses (built from a manifest by default). */
export interface AvatarConfig {
    /** Composed look (body/face assets, head bone, body + head offsets). */
    manifest: AvatarManifest
    /** Optional per-state stay-clip overrides (what the Motion tab retunes). */
    clips?: Partial<Record<LocomotionKey, MotionClipDef>>
    /**
     * Extra locomotion clip sets, switchable at runtime by key (e.g. `armed`:
     * rifle idle/walk/run for an NPC that has drawn a weapon). Built alongside
     * the base set, so `AvatarRig.setClipSet` is synchronous. A state omitted
     * from a set falls back to the base clip for that state.
     */
    clipSets?: Record<string, ClipSetConfig>
    /** Rigged-head composition: `'auto'` (geometry decides) or `'seat'` (force
     * seat-glue at authored size, no dual-drive). Defaults to `'auto'`. */
    headMode?: 'auto' | 'seat'
}

/** Per-state natural cadence, multiplied by the live `speedFactor`. */
type TimeScaleTable = Record<LocomotionKey, number>

/** One switchable locomotion set, declared on {@link AvatarConfig.clipSets}. */
export interface ClipSetConfig {
    /** Per-state overrides; omitted states reuse the base clip for that state. */
    clips?: Partial<Record<LocomotionKey, MotionClipDef>>
    /** Per-state cadence. Defaults to the base table (1 / 1.5 / 1 / 1). */
    timeScale?: Partial<TimeScaleTable>
    /**
     * Remove the root's linear XZ travel from this set's clips (see
     * `stripClipTravel`). Defaults to **true** for named sets: weapon packs are
     * authored to carry the character forward, and the navmesh owns position.
     * The base set passes false to keep the player's output byte-identical.
     */
    stripTravel?: boolean
}

/** The key of the always-present set built from the manifest / `cfg.clips`.
 *  Exported because callers that switch sets have to switch back to it. */
export const BASE_SET_KEY = 'base'

/** Crossfade used when `setClipSet` is called without an explicit duration. */
const DEFAULT_SET_FADE = 0.25

/** One built, ready-to-play locomotion set: body + dual-drive head actions and
 *  that set's own cadence. Immutable once constructed. */
interface ClipSet {
    readonly key: string
    readonly body: Record<LocomotionKey, THREE.AnimationAction | null>
    readonly head: Record<LocomotionKey, THREE.AnimationAction | null>
    readonly timeScale: TimeScaleTable
}

export interface AvatarRig {
    /** Composed avatar root (body + seated/dual-drive head), upright "home"
     * applied. Add this under the player group — it carries the whole character. */
    readonly scene: THREE.Group
    /** Crossfade the idle/walk/run/jump weights (on body *and* dual-drive head
     * mixers) toward `targets`. `alpha` is the frame lerp factor. */
    blend(targets: LocomotionTargets, alpha: number): void
    /**
     * Crossfade onto another locomotion clip set built from
     * {@link AvatarConfig.clipSets} (e.g. `'armed'`). Synchronous — every set is
     * built with the rig, so this only moves weights. An unknown key or a
     * request for the set already active is ignored.
     */
    setClipSet(key: string, fadeSeconds?: number): void
    /** The key of the live clip set — `'base'` until `setClipSet` is called. */
    getClipSet(): string
    /** Every built set key, base first. */
    listClipSets(): string[]
    /**
     * Retune one set's per-state cadence in place — the armed walk/run are
     * authored for a slower pace than the navmesh moves the NPCs, so the GUI
     * dials these until the feet stop sliding. An unknown key is ignored.
     */
    setClipSetTimeScale(key: string, states: Partial<TimeScaleTable>): void
    /** Advance all mixers, re-glue the head to the live head bone, and reveal the
     * avatar once its skeleton stands (hides a floor-splayed clip intro). */
    advance(delta: number): void
    /** Restart the jump clip at `time` (skips the anticipation crouch so the pose
     * matches the ballistic launch). */
    startJumpAt(time: number): void
    /** Play an emotion. `def.dance` toggles between the two modes:
     *   - gesture (default): plays the clip once then returns to the caller's
     *     blend (idle). The character parks in place while it plays.
     *   - dance: loops the clip in place until {@link cancelEmotion} is called
     *     (tap the same button again / pick another emotion); the character keeps
     *     steering/walking while it plays (no park).
     * Interrupts any emotion currently playing. While it runs `isEmotionActive()`
     * is true — the emotion owns the mixers (locomotion weight forced to 0). The
     * clip plays as-authored: its root translation is preserved, so the player is
     * not locked in place. `def.startAt` skips an authored preamble (e.g. the gesture library's
     * ~0.14s "get up from the floor" intro) so a one-shot begins standing. */
    playEmotionOnce(def: MotionClipDef & { startAt?: number; dance?: boolean; id?: string }): void
    /** True while an emotion is playing. */
    isEmotionActive(): boolean
    /** True when the active emotion is a looping dance (tap again to stop). */
    isEmotionDance(): boolean
    /** Clip id of the currently active emotion (null when none is playing). */
    getEmotionId(): string | null
    /** Stop the current emotion (dance or one-shot) and hand back to the caller's
     *  blend immediately. */
    cancelEmotion(): void

    // ---- live retuning (no rebuild — cheap, called on store changes) ----
    /** Body placement offset → applyBodyOffset on the composed root. */
    setBodyOffset(offset: BodyInsertion): void
    /** Head-insertion offset → re-seat the face on the live head bone. */
    setHeadOffset(offset: HeadInsertion): void
    /** Show/hide the body and/or face meshes of the composed avatar. */
    setVisibility(visibility: { body?: boolean; face?: boolean }): void
    /** Global playback speed × (1 = natural). Multiplies every action's own
     * timescale (walk runs at 1.5× naturally). */
    setSpeed(factor: number): void
    /** Pause/resume the whole character's animation. */
    setPaused(paused: boolean): void

    /** Stop mixers/actions and detach the head mount. GPU disposal of `scene` is
     * the caller's job (NavMeshRig disposes it on teardown). */
    dispose(): void
}

/** Clone an offset group so store mutations can't alias into the rig. */
function cloneOffset(o: BodyInsertion): BodyInsertion {
    return {
        position: [...o.position] as BodyInsertion['position'],
        rotation: [...o.rotation] as BodyInsertion['rotation'],
        scale: [...o.scale] as BodyInsertion['scale'],
    }
}

/**
 * Build a composed avatar for the NavMeshRig. Optional `config.manifest` (a
 * saved `/char` look + motion library) defaults to `fetchSavedManifest()`;
 * `config.clips` overrides which stay clips feed the four rig states.
 */
export async function loadAvatar(config?: AvatarConfig | AvatarManifest): Promise<AvatarRig> {
    const cfg: AvatarConfig | undefined = config ? ('assets' in config ? { manifest: config } : config) : undefined
    const manifest = cfg?.manifest ?? (await fetchSavedManifest())

    // --- load + compose body & face on the shared mixamorig skeleton ----------
    const [bodyGltf, faceGltf] = await Promise.all([loadGLB(manifest.assets.body), loadGLB(manifest.assets.face)])
    const bodyScene = bodyGltf.scene
    const faceScene = faceGltf.scene

    // Classify (congruent dual-drive vs cross-look seat) while both scenes are
    // still unparented so the measurement can't be skewed by the upright rotation.
    const plan: HeadComposePlan = classifyHeadCompose({
        bodyScene,
        faceScene,
        headBone: manifest.headBone,
        headMode: cfg?.headMode ?? 'auto',
    })

    const root = new THREE.Group()
    root.name = 'Avatar'
    // Hidden until the reveal gate (in advance) sees the skeleton standing — a
    // clip can open with the character floor-splayed and stand over the first
    // seconds; that intro must never render on the navmesh.
    root.visible = false
    root.add(bodyScene)

    // Body mixer bound to the root: the clips are remapped onto the body bone
    // names, which the mixer resolves through the root's subtree.
    const mixer = new THREE.AnimationMixer(root)
    const attachment = createHeadAttachment({ root, faceScene, plan })
    const mount = attachment.mount
    const faceGroup = attachment.group

    // Live offset copies the tuning panel writes through `setBody/HeadOffset`.
    let bodyOffset = cloneOffset(manifest.body)
    let headOffset = cloneOffset(manifest.head) as HeadInsertion
    applyBodyOffset(root, bodyOffset)
    mount?.update(headOffset)

    // --- locomotion clip sets ---------------------------------------------------
    // Walk naturally runs at 1.5×; every action is scaled further by `speedFactor`
    // so the tuning panel's playback speed stays live-tunable. A set may override
    // its own cadence (a weapon pack's walk cycle is a different length, and
    // sharing the base table makes the feet slide).
    const BASE_TIMESCALE: TimeScaleTable = {
        idle: 1,
        walk: WALK_TIMESCALE,
        run: 1,
        jump: 1,
    }
    const headMixer = attachment.headMixer

    /**
     * Load, de-trend and bind one clip set. Everything here is per-set: sets
     * share no clips and no actions, so a set that omits a state builds its own
     * action for that state from the base def. Borrowing an action instead would
     * leave it written by two sets' gains at once during a crossfade.
     */
    const buildClipSet = async (
        key: string,
        setCfg: ClipSetConfig | undefined,
        defs: Record<LocomotionKey, MotionClipDef>,
        stripTravel: boolean,
    ): Promise<ClipSet> => {
        // `loadMotionClips` keys its result by `def.name`, so two states sharing
        // a name would collapse to one entry — and therefore one action, moved by
        // two different weights. Drop the duplicate loudly rather than bind it twice.
        const distinct: MotionClipDef[] = []
        const seen = new Set<string>()
        for (const k of LOCOMOTION_KEYS) {
            const d = defs[k]
            if (seen.has(d.name)) {
                console.warn(`[avatarLoader] clip set "${key}": "${d.name}" serves two states — ${k} ignored.`)
                continue
            }
            seen.add(d.name)
            distinct.push(d)
        }
        const loaded = await loadMotionClips(distinct, bodyScene)

        const timeScale: TimeScaleTable = { ...BASE_TIMESCALE, ...(setCfg?.timeScale ?? {}) }
        const body = {} as Record<LocomotionKey, THREE.AnimationAction | null>
        const head = {} as Record<LocomotionKey, THREE.AnimationAction | null>
        for (const k of LOCOMOTION_KEYS) {
            const derived = deriveBodyClip(k, loaded.get(defs[k].name) ?? null, bodyScene, stripTravel)
            // Created silent; `writeLocomotionWeights` is the only thing that
            // raises a weight, so every set starts from the same place.
            body[k] = playClip(mixer, derived, 0, timeScale[k])
            // The face's own rig (dual-drive heads only) plays the same clips
            // restricted to the bones it actually has. Restricted from the
            // already-derived body clip, so the two can't disagree about root motion.
            if (headMixer) head[k] = playClip(headMixer, derived ? restrictClipToRoot(derived, faceScene) : null, 0, timeScale[k])
        }
        return { key, body, head, timeScale }
    }

    const baseDefs = resolveLocomotionDefs(manifest)
    const baseSetDefs = {} as Record<LocomotionKey, MotionClipDef>
    for (const key of LOCOMOTION_KEYS) {
        baseSetDefs[key] = cfg?.clips?.[key] ?? baseDefs[key]
    }

    // Every set is built up front. `setClipSet` is called from inside the crowd's
    // per-frame update, and `mixer.clipAction` parses bindings the first time it
    // sees a clip — deferring that to the switch would put the parse on the frame
    // the NPC aggros, and four NPCs aggroing together would put sixteen of them in
    // one frame. Inactive sets are stopped, so they cost nothing in the mixer.
    const clipSets = new Map<string, ClipSet>()
    const baseSet = await buildClipSet(BASE_SET_KEY, undefined, baseSetDefs, /* stripTravel */ false)
    clipSets.set(BASE_SET_KEY, baseSet)
    for (const [key, setCfg] of Object.entries(cfg?.clipSets ?? {})) {
        const defs = {} as Record<LocomotionKey, MotionClipDef>
        for (const k of LOCOMOTION_KEYS) defs[k] = setCfg.clips?.[k] ?? baseSetDefs[k]
        try {
            const set = await buildClipSet(key, setCfg, defs, setCfg.stripTravel ?? true)
            // Start silent: whatever the base set left on the mixers must not
            // blend with a set that is not yet active.
            for (const k of LOCOMOTION_KEYS) {
                set.body[k]?.stop()
                set.head[k]?.stop()
            }
            clipSets.set(key, set)
        } catch (err) {
            console.warn(`[avatarLoader] clip set "${key}" failed to build:`, err)
        }
    }

    let active: ClipSet = baseSet
    let outgoing: ClipSet | null = null
    let activeGain = 1
    let fadeElapsed = 0
    let fadeDuration = 0

    /** Exactly the sets currently audible — the single definition of what the
     *  weight writer must touch. */
    const liveSets = (): ClipSet[] => (outgoing ? [active, outgoing] : [active])

    const stopClipSet = (set: ClipSet) => {
        for (const key of LOCOMOTION_KEYS) {
            const body = set.body[key]
            if (body) {
                body.enabled = false
                body.stop()
            }
            const head = set.head[key]
            if (head) {
                head.enabled = false
                head.stop()
            }
        }
    }

    /** Retire the fading set. Also the settle path for `settleIdle`. */
    const finishSwap = () => {
        if (outgoing) {
            stopClipSet(outgoing)
            outgoing = null
        }
        activeGain = 1
    }

    const stepFade = (dt: number) => {
        if (!outgoing || emotionActiveFlag) return
        fadeElapsed += dt
        const u = fadeDuration > 0 ? Math.min(1, fadeElapsed / fadeDuration) : 1
        // Smoothstep: no velocity step at either end of the crossfade.
        activeGain = u * u * (3 - 2 * u)
        if (activeGain >= 1) finishSwap()
    }

    /**
     * Crossfade onto another clip set. Synchronous — every set is built up front,
     * so this only moves weights. Unknown keys and repeats are no-ops.
     */
    const setClipSet = (key: string, fadeSeconds = DEFAULT_SET_FADE) => {
        if (key === active.key) return
        const next = clipSets.get(key)
        if (!next) {
            console.warn(`[avatarLoader] unknown clip set "${key}" — ignoring.`)
            return
        }
        // Enable the incoming set and give it the caller's current intent before
        // it becomes audible, or its first frame would snap from the bind pose.
        for (const k of LOCOMOTION_KEYS) {
            next.body[k]?.reset()
            next.body[k]?.play()
            next.head[k]?.play()
        }
        outgoing = active
        active = next
        activeGain = 0
        fadeElapsed = 0
        fadeDuration = Math.max(0, fadeSeconds)
        applyTimescales()
        if (fadeDuration === 0) finishSwap()
        writeLocomotionWeights()
    }

    // --- reveal gate -----------------------------------------------------------
    let revealed = false
    let hiddenElapsed = 0
    const maybeReveal = (dt: number) => {
        if (revealed) return
        hiddenElapsed += dt
        // Refresh world matrices so the standing test reads live bone positions.
        root.updateMatrixWorld(true)
        const up = uprightFraction(plan.bone, plan.hips)
        // No head/hips to measure → don't gate; also un-hide after ~1.6s no matter
        // what so a clip with no obvious "stand" never leaves the avatar invisible.
        if (up === null || up >= UPRIGHT_REVEAL || hiddenElapsed > 1.6) {
            revealed = true
            root.visible = true
        }
    }

    // Live-playback state (set by the tuning panel / NavMeshRig).
    let speedFactor = 1
    let paused = false

    // ------------------------------------------------------------------
    // One-shot emotion (gesture / dance). No fade in/out: whichever emotion is
    // active owns the mixers outright — its clip at full weight, every locomotion
    // action (body + dual-drive head) forced to 0 — so nothing underneath leaks
    // through. A *gesture* plays one pass then hands back to the caller's blend;
    // a *dance* loops in place until cancelEmotion() (tap again / pick another).
    // ------------------------------------------------------------------
    // Clips load through the SDK's module FBX cache and are remapped onto the
    // body skeleton. Each clip plays as-authored: its root translation is left
    // intact, so the character is not locked in place and an emotion with real
    // root motion can carry it (e.g. a dance with steps).
    // `startAt` skips an authored preamble (e.g. the gesture library's ~0.14s
    // "get up from the floor" intro) so a one-shot begins standing.
    let emotionActiveFlag = false
    let emotionToken = 0
    let emotionId: string | null = null
    let emotionDance = false
    let emotionElapsed = 0 // playback seconds into the current pass (one-shots)
    let emotionDuration = 0
    let emotionAction: THREE.AnimationAction | null = null
    let emotionHeadAction: THREE.AnimationAction | null = null

    const stopEmotion = () => {
        if (emotionAction) {
            emotionAction.enabled = false
            emotionAction.stop()
            emotionAction = null
        }
        if (emotionHeadAction) {
            emotionHeadAction.enabled = false
            emotionHeadAction.stop()
            emotionHeadAction = null
        }
        emotionActiveFlag = false
        emotionId = null
        emotionDance = false
        emotionElapsed = 0
        emotionDuration = 0
    }

    // ------------------------------------------------------------------
    // The one place locomotion weights are written.
    //
    // The caller's intent lives in `weights`; this projects it onto whichever
    // sets are live, splitting by the crossfade gain. Keeping a single writer is
    // what makes the "an emotion owns the mixers outright" invariant hold by
    // construction: before, it was enforced by `weight = 0` writes scattered
    // across two loops, and a second clip set would have slipped past both and
    // rendered at 50/50 against the emotion.
    // ------------------------------------------------------------------
    const weights: Record<LocomotionKey, number> = { idle: 1, walk: 0, run: 0, jump: 0 }

    const writeLocomotionWeights = () => {
        const emotionOn = emotionActiveFlag
        for (const set of liveSets()) {
            const gain = set === active ? activeGain : 1 - activeGain
            for (const key of LOCOMOTION_KEYS) {
                const w = emotionOn ? 0 : weights[key] * gain
                const body = set.body[key]
                if (body) body.weight = w
                const head = set.head[key]
                if (head) head.weight = w
            }
        }
        if (emotionOn) {
            if (emotionAction) emotionAction.weight = 1
            if (emotionHeadAction) emotionHeadAction.weight = 1
        }
    }

    /** Re-apply a set's cadence to the mixer. Each live set keeps its own, so the
     *  outgoing armed walk doesn't adopt the incoming set's stride mid-fade. */
    const applyTimescales = () => {
        for (const set of liveSets()) {
            for (const key of LOCOMOTION_KEYS) {
                const target = set.timeScale[key] * speedFactor
                const body = set.body[key]
                if (body) body.timeScale = target
                const head = set.head[key]
                if (head) head.timeScale = target
            }
        }
    }

    // Snap the locomotion back to a full idle stance (used the frame an emotion
    // finishes, so there is no bind-pose flash before the caller re-asserts idle).
    const settleIdle = () => {
        weights.idle = 1
        weights.walk = 0
        weights.run = 0
        weights.jump = 0
        finishSwap() // an emotion ending mid-swap must land idle on the incoming set
        writeLocomotionWeights()
    }

    const startEmotionClip = (clip: THREE.AnimationClip, def: { startAt?: number; dance?: boolean; id?: string }) => {
        const startAt = def.startAt ?? 0
        const bodyClip = clip
        const makeAction = (m: THREE.AnimationMixer, c: THREE.AnimationClip) => {
            const action = m.clipAction(c)
            action.loop = def.dance ? THREE.LoopRepeat : THREE.LoopOnce
            // A gesture holds its last frame until the cut; a dance just loops.
            action.clampWhenFinished = !def.dance
            action.weight = 0
            action.timeScale = speedFactor
            action.play()
            // Skip the clip's authored preamble so a one-shot starts standing.
            if (startAt > 0) action.time = startAt
            return action
        }
        emotionId = def.id ?? clip.name
        emotionDance = !!def.dance
        emotionAction = makeAction(mixer, bodyClip)
        if (headMixer) {
            // Dual-drive faces play the emotion restricted to the bones under the face
            // skeleton (head nods / shakes drive the seated head too). When nothing
            // survives the restriction (e.g. a body-only clip), the face just rests.
            const headClip = restrictClipToRoot(bodyClip, faceScene)
            if (headClip) {
                emotionHeadAction = makeAction(headMixer, headClip)
            }
        }
        emotionDuration = Math.max(0.001, bodyClip.duration - startAt)
        emotionElapsed = 0
        emotionActiveFlag = true
        writeLocomotionWeights()
    }

    /**
     * Remapped one-shot clips, keyed by URL.
     *
     * `loadMotionClips` clones the clip on every call, and `mixer.clipAction`
     * caches by `clip.uuid` and never evicts — so re-loading the same URL per
     * trigger hands the mixer a brand-new clip and a brand-new action each time,
     * retained forever. Harmless at the emotion buttons' manual cadence, but a
     * firing NPC replays one clip every second or so, which grows without bound.
     * Caching here also keeps the action identity stable so `stopEmotion`/`play`
     * reuse a single action.
     */
    const oneShotClips = new Map<string, Promise<THREE.AnimationClip | null>>()

    const triggerEmotion = (def: MotionClipDef & { startAt?: number; dance?: boolean; id?: string }) => {
        const token = ++emotionToken
        stopEmotion() // interrupt any emotion already playing
        let pending = oneShotClips.get(def.url)
        if (!pending) {
            pending = loadMotionClips([def], bodyScene).then((loaded) => loaded.get(def.name) ?? null)
            oneShotClips.set(def.url, pending)
        }
        void pending.then((clip) => {
            if (token !== emotionToken) return // superseded by a newer request
            if (!clip) {
                console.warn(`[avatarLoader] emotion "${def.name}" has no clip.`)
                return
            }
            startEmotionClip(clip, def)
        })
    }

    // One-shots count the single pass and cut to idle at its end; dances loop
    // until cancelEmotion(). Weights are asserted by writeLocomotionWeights() at
    // the top of advance(), not here.
    const advanceEmotion = (dt: number) => {
        if (!emotionActiveFlag) return
        if (emotionDance) return // keep dancing until explicitly stopped
        emotionElapsed += dt * speedFactor
        if (emotionElapsed >= emotionDuration) {
            settleIdle()
            stopEmotion()
        }
    }

    return {
        scene: root,
        blend(targets, alpha) {
            // Accumulate the caller's intent; the projector below applies it to
            // whichever sets are live (and to the crossfade split).
            for (const key of LOCOMOTION_KEYS) {
                weights[key] = THREE.MathUtils.lerp(weights[key], targets[key], alpha)
            }
            writeLocomotionWeights()
        },
        advance(delta) {
            const dt = paused ? 0 : delta
            // Step the crossfade, then re-project. While an emotion is active it
            // owns the mixers: the projector forces the gesture to full weight and
            // every locomotion action of *every* live set to 0, so the caller's
            // blend can't leak idle in underneath.
            stepFade(dt)
            writeLocomotionWeights()
            mixer.update(dt)
            if (headMixer) headMixer.update(dt)
            advanceEmotion(dt)
            // Re-seat the face on the *live* head bone (both rigid glue and the
            // dual-drive offset nudge recompute against the bone's current transform).
            mount?.update(headOffset)
            maybeReveal(delta)
        },
        startJumpAt(time) {
            const body = active.body.jump
            if (body) body.time = time
            const head = active.head.jump
            if (head) head.time = time
        },
        setClipSet,
        getClipSet() {
            return active.key
        },
        listClipSets() {
            return [...clipSets.keys()]
        },
        setClipSetTimeScale(key, states) {
            const set = clipSets.get(key)
            if (!set) return
            // Mutate the set's own table rather than replacing it: `ClipSet` is
            // otherwise immutable, and the live sets read this table every time
            // the cadence is applied.
            Object.assign(set.timeScale, states)
            applyTimescales()
        },
        playEmotionOnce(def) {
            triggerEmotion(def)
        },
        isEmotionActive() {
            return emotionActiveFlag
        },
        isEmotionDance() {
            return emotionDance
        },
        getEmotionId() {
            return emotionId
        },
        cancelEmotion() {
            if (!emotionActiveFlag) return
            settleIdle()
            stopEmotion()
        },
        setBodyOffset(offset) {
            bodyOffset = cloneOffset(offset)
            applyBodyOffset(root, bodyOffset)
        },
        setHeadOffset(offset) {
            headOffset = cloneOffset(offset) as HeadInsertion
            mount?.update(headOffset)
        },
        setVisibility(visibility) {
            if (visibility.body !== undefined) bodyScene.visible = visibility.body
            if (visibility.face !== undefined && faceGroup) faceGroup.visible = visibility.face
        },
        setSpeed(factor) {
            speedFactor = factor
            applyTimescales()
        },
        setPaused(value) {
            paused = value
        },
        dispose() {
            stopEmotion()
            // Stops every set's actions — they all share the two mixers, which is
            // why a clip set must never bring its own (nothing would stop it here).
            mixer.stopAllAction()
            if (headMixer) headMixer.stopAllAction()
            clipSets.clear()
            oneShotClips.clear()
            attachment.dispose()
        },
    }
}
