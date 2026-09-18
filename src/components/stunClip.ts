/**
 * The clip a character plays when the jump's force field leaves it stunned.
 *
 * Read out of the auto-generated emotion catalog rather than rebuilt from a
 * `folder/name` pair here, for the reason `deathClip.ts` gives: the catalog is
 * the one place that knows the `/char/motion-2/fbx/...` layout, and a second
 * copy of that convention drifts silently — a wrong path only shows up as a
 * character that is stunned but does not react.
 *
 * The clip lives in the `more/` folder, which is where assets added by hand go.
 * It is a Mixamo "got hit" reaction, played through the rig's emotion path as a
 * one-shot. `loadMotionClips` takes the FBX's first animation and renames it to
 * the def's name, so the file's internal Mixamo take name is irrelevant.
 *
 * ## The stun does not wait for the clip
 *
 * A hit reaction runs longer than a second, and `npcEnemies` cuts it when the
 * stun ends rather than letting it play out. An emotion owns the mixers outright
 * while it is active, so an over-running clip would keep suppressing the
 * locomotion set on an NPC that is walking again by then — feet sliding. The
 * stun is exactly as long as the tunable says, clip included.
 */

import { EMOTION_FLAT } from './avatar/emotionCatalog'
import type { EmotionDef } from '../b3/b3-runtime/src/components/stores/navRigStore'

/** Catalog id of the stun reaction. */
const STUN_CLIP_ID = 'more/gun-got-hit'

/**
 * The dizzy reaction, or null when the catalog has lost it.
 *
 * Null is tolerated, not fatal: a stunned NPC with no clip is still stunned, it
 * simply does not animate — the same contract as `deathClipFor` returning null.
 */
export const STUN_CLIP: EmotionDef | null =
    EMOTION_FLAT.find((def) => def.id === STUN_CLIP_ID) ?? null
