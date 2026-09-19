/**
 * The clip an NPC plays when it dodges an incoming shot.
 *
 * Read out of the auto-generated emotion catalog rather than rebuilt from a
 * `folder/name` pair here, for the reason `deathClip.ts` gives: the catalog is
 * the one place that knows the `/char/motion-2/fbx/...` layout, and a second
 * copy of that convention drifts silently — a wrong path only shows up as a
 * character that dodges but does not move.
 *
 * The clip comes from the *shooter* pack (the `shooter/` folder), the pack the
 * armed crowd already walks on, so the sidestep reads as footwork the character
 * owns. It is played through the rig's emotion path as a one-shot;
 * `loadMotionClips` takes the FBX's first animation and renames it to the def's
 * name, so the file's internal Mixamo take name is irrelevant.
 *
 * ## What the clip does, and does not, do
 *
 * Measured off the FBX: **0.667 s**, and it is a *travelling* strafe — this pack
 * is authored to carry the character sideways, and this clip crosses **135.04
 * units** over its short loop. That is far too much to play under an NPC whose
 * position the navmesh owns, so the catalog declares it `inPlace` and the
 * emotion path de-trends it (`avatarLoader.stripClipTravel`) before it reaches a
 * mixer. Without that the NPC would slide ~135 units off its agent position and
 * snap back on every repeat.
 *
 * What survives the strip is the footwork: **2.55 units** of in-place sway over
 * a 3.66-unit vertical bob, with frame 0 preserved exactly as authored — the rig
 * applies no positional compensation, so the clip's first frame *is* the
 * reference stance. Only 1.9% of the removed trend remains as residual, so the
 * clip carries **no net travel**: it supplies the body language of a dodge and
 * nothing else.
 *
 * That matters, because dodging a shot is a spatial act. The pool's hit test
 * captures a droplet within `HIT_RADIUS + DROP_RADIUS` (0.407 m) of the chest,
 * so a sway of a few units would still be hit. The displacement that actually
 * makes the shot miss is applied to the crowd agent by `npcEnemies.dodge` — the
 * clip is what makes that displacement read as a dodge rather than a slide.
 */

import { EMOTION_FLAT } from './avatar/emotionCatalog'
import type { EmotionDef } from '../b3/b3-runtime/src/components/stores/navRigStore'

/** Catalog id of the dodge. */
const DODGE_CLIP_ID = 'shooter/strafe'

/**
 * The dodge, or null when the catalog has lost it.
 *
 * Null is tolerated, not fatal: an NPC with no clip still dodges — it is the
 * agent's movement that evades the shot, and that happens either way. The same
 * contract as `deathClipFor` and `STUN_CLIP` returning null.
 */
export const DODGE_CLIP: EmotionDef | null =
    EMOTION_FLAT.find((def) => def.id === DODGE_CLIP_ID) ?? null
