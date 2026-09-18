/**
 * The rifle-holding locomotion set, shared by the NPC crowd and the player.
 *
 * Both the crowd (`npcEnemies`) and the player's attack mode switch their rig to
 * the same armed set, and the clips are named by the SDK's own motion registry
 * rather than spelled out as paths. Keeping the three defs in one place is what
 * stops the two callers from drifting — the URLs are not obvious, and a typo
 * only shows up as an arms-hanging pose at runtime.
 */

import { MOTION_SECTIONS, type MotionClipDef } from '../b3/b3-runtime/src/components/AvatarSDK'
import type { LocomotionKey } from './avatarLoader'

/** Key of the rifle-holding set, as handed to `loadAvatar` and `setClipSet`. */
export const ARMED_SET_KEY = 'armed'

/**
 * One clip from a named SDK motion section, so the paths live in the SDK's
 * registry (`MOTION_SECTIONS`) rather than being spelled out here. The def name
 * is prefixed because it also becomes the `AnimationClip`'s name and the
 * `loadMotionClips` result key — a set's names must be unique within that set.
 */
export function sectionClip(sectionId: string, name: string): MotionClipDef | null {
    const section = MOTION_SECTIONS.find((s) => s.id === sectionId)
    if (!section) return null
    return { name: `armed-${name}`, url: `${section.baseUrl}/${name}.fbx` }
}

/** Warn at most once per page: every avatar rebuild re-derives this set, and a
 *  missing section would otherwise fill the console from the rebuild path. */
let warnedIncomplete = false

/**
 * The rifle-holding locomotion set: `gun/idle-aiming`, `shooter/walking`,
 * `gun/run-forward` (the `rifle` section is the `gun` directory).
 *
 * The idle is the *aiming* variant rather than plain `gun/idle`: this pose is
 * what an armed character holds, pointing the gun forward, so the raised sights
 * read as aiming.
 *
 * `jump` is deliberately omitted, so the set falls back to the base jump clip —
 * there is no armed jump in the pack, and the caller's launch frame stays valid.
 *
 * Returns null when the SDK's section table is missing a clip, meaning the armed
 * pose cannot be assembled at all; callers then leave the character in peace
 * rather than building a half-set.
 */
export function armedClipSet(): { clips: Partial<Record<LocomotionKey, MotionClipDef>> } | null {
    const idle = sectionClip('rifle', 'idle-aiming')
    const walk = sectionClip('shooter', 'walking')
    const run = sectionClip('rifle', 'run-forward')
    if (!idle || !walk || !run) {
        if (!warnedIncomplete) {
            warnedIncomplete = true
            console.warn('[armedClipSet] armed clip set incomplete — characters stay in peace')
        }
        return null
    }
    return { clips: { idle, walk, run } }
}

/** The firing one-shot, played through the rig's emotion path. */
export const ARMED_FIRING_CLIP: MotionClipDef | null = sectionClip('shooter', 'firing-rifle')

/**
 * Is the emotion the rig reports a **reflex** one — a clip played as a side
 * effect of something the player is already doing, rather than one they asked
 * for?
 *
 * The emotion path hands a clip the mixers outright (see `avatarLoader`), which
 * is right for a gesture or a dance and wrong for a reflex: a clip that keeps
 * the mixers keeps the character in its pose. The firing recoil is the one that
 * bites, because it is re-triggered on every shot — during sustained fire it is
 * active almost continuously, so anything that defers to it defers to it
 * forever. Concretely: without this, the player cannot jump while shooting.
 *
 * The id is matched against the clip's own name because that is what
 * `AvatarRig.getEmotionId()` reports for a def that carries no `id` of its own,
 * which is how every clip in the SDK's motion registry is identified.
 *
 * Deliberately a whitelist of one. A dance or a gesture is the player's own
 * choice and still owns the character; only the clips in here may be interrupted
 * by movement.
 */
export function isReflexEmotion(emotionId: string | null): boolean {
    return emotionId !== null && emotionId === ARMED_FIRING_CLIP?.name
}
