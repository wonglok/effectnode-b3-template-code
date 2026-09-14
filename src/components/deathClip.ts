/**
 * The clip a character plays when it goes down.
 *
 * Read out of the auto-generated emotion catalog rather than rebuilt from a
 * `folder/name` pair here. The catalog is the one place that knows the
 * `/char/motion-2/fbx/...` layout, and a second copy of that convention is
 * exactly the drift `armedClipSet.ts` was created to prevent — a wrong path
 * only shows up as a character that does not fall over.
 *
 * The clips come from the *rifle* pack (the `gun/` folder in the catalog), since
 * that is the pack an armed character is already carrying, and they are all
 * one-shots — the emotion path plays them `LoopOnce`.
 */

import { EMOTION_FLAT } from './avatar/emotionCatalog'
import type { EmotionDef } from '../b3/b3-runtime/src/components/stores/navRigStore'

/** Folder prefix for the death clips in the catalog's ids. */
const DEATH_PREFIX = 'gun/death-'

/**
 * Every death clip the rifle pack ships, in catalog order.
 *
 * More than one so a crowd does not fall over in unison — see `deathClipFor`.
 * Empty if the catalog is regenerated without them, which callers must tolerate:
 * a character that dies without a clip still dies, it just does not animate.
 */
export const DEATH_CLIPS: readonly EmotionDef[] = EMOTION_FLAT.filter((def) =>
    def.id.startsWith(DEATH_PREFIX),
)

/**
 * A death clip for the character at `index`.
 *
 * Deterministic rather than random: the same NPC always falls the same way
 * across respawns, so a repeated death reads as that character's death rather
 * than as the animation being unstable.
 */
export function deathClipFor(index: number): EmotionDef | null {
    if (DEATH_CLIPS.length === 0) return null
    return DEATH_CLIPS[index % DEATH_CLIPS.length]
}
