/**
 * Pure pose/transform helpers used by `<Avatar>`: the upright reveal test and
 * the body-placement "home" offset. Split out of `Avatar.tsx`; three-math only,
 * no React.
 */

import { Euler, Vector3 } from 'three'
import type { Object3D } from 'three'

import type { BodyInsertion } from './types'

const _DEG2RAD = Math.PI / 180
const _bodyEuler = new Euler()

const _upHead = new Vector3()
const _upHips = new Vector3()

/**
 * Clips can open with the character lying down and standing up over the first
 * seconds (the current library's "stay" intro). Until the skeleton is truly
 * upright the avatar is kept hidden so the user never sees it splayed on the
 * floor. `UPRIGHT_REVEAL` is the minimum |dy| / length of the head→hips axis
 * that counts as "standing" (0.8 ⇒ head within ~37° of straight up).
 */
export const UPRIGHT_REVEAL = 0.8

/** Vertical-ness of the head→hips axis in world space (0 lying … 1 vertical).
 * `null` when the needed bones aren't present (don't gate in that case). */
export function uprightFraction(
  head: Object3D | null,
  hips: Object3D | null,
): number | null {
  if (!head || !hips) return null
  head.getWorldPosition(_upHead)
  hips.getWorldPosition(_upHips)
  _upHead.sub(_upHips)
  const len = _upHead.length()
  if (len < 1e-6) return null
  return Math.abs(_upHead.y) / len
}

/**
 * Apply a body placement offset to the composed avatar root: translate, rotate
 * (degrees → Euler XYZ) and scale the whole group. Both rigs (and any head
 * mount glued onto a bone) live under the root, so they transform together and
 * keep their authored alignment — the body offset reads as an asset-frame
 * correction, on top of the stage's own uprighting transform.
 */
export function applyBodyOffset(target: Object3D, offset: BodyInsertion): void {
  _bodyEuler.set(
    offset.rotation[0] * _DEG2RAD,
    offset.rotation[1] * _DEG2RAD,
    offset.rotation[2] * _DEG2RAD,
    'XYZ',
  )
  target.quaternion.setFromEuler(_bodyEuler)
  target.position.set(
    offset.position[0],
    offset.position[1],
    offset.position[2],
  )
  target.scale.set(offset.scale[0], offset.scale[1], offset.scale[2])
}
