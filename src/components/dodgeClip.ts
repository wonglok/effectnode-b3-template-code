/**
 * The clip an NPC plays when it dodges an incoming shot.
 *
 * Read out of the auto-generated emotion catalog rather than rebuilt from a
 * `folder/name` pair here, for the reason `deathClip.ts` gives: the catalog is
 * the one place that knows the `/char/motion-2/fbx/...` layout, and a second
 * copy of that convention drifts silently — a wrong path only shows up as a
 * character that dodges but does not move.
 *
 * The clip lives in `more/`, where hand-added assets go. It is a Mixamo dodge,
 * played through the rig's emotion path as a one-shot; `loadMotionClips` takes
 * the FBX's first animation and renames it to the def's name, so the file's
 * internal Mixamo take name is irrelevant.
 *
 * ## What the clip does, and does not, do
 *
 * Measured off the FBX: **1.633 s**, and it is a duck-and-weave *in place* — the
 * left foot stays planted while the right repositions, the head travels ~20 cm,
 * and every bone returns to exactly where it started. So the clip carries **no
 * net travel**: it supplies the body language of a dodge and nothing else.
 *
 * That matters, because dodging a shot is a spatial act. The pool's hit test
 * captures a droplet within `HIT_RADIUS + DROP_RADIUS` (0.407 m) of the chest,
 * so a 20 cm weave would still be hit. The displacement that actually makes the
 * shot miss is applied to the crowd agent by `npcEnemies.dodge` — the clip is
 * what makes that displacement read as a dodge rather than a slide.
 */

import { EMOTION_FLAT } from './avatar/emotionCatalog'
import type { EmotionDef } from '../b3/b3-runtime/src/components/stores/navRigStore'

/** Catalog id of the dodge. */
const DODGE_CLIP_ID = 'more/dodging'

/**
 * The dodge, or null when the catalog has lost it.
 *
 * Null is tolerated, not fatal: an NPC with no clip still dodges — it is the
 * agent's movement that evades the shot, and that happens either way. The same
 * contract as `deathClipFor` and `STUN_CLIP` returning null.
 */
export const DODGE_CLIP: EmotionDef | null =
    EMOTION_FLAT.find((def) => def.id === DODGE_CLIP_ID) ?? null
