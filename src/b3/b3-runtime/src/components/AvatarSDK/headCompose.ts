/**
 * Head/face composition onto a body rig — how a rigged or static face is
 * attached to the body's head bone, and how the "congruent vs seat" decision
 * is made. Split out of `Avatar.tsx`.
 *
 * Two cooperating steps, because parenting order matters:
 * 1. `classifyHeadCompose` measures both skeletons' authored rest **while the
 *    scenes are still unparented** (identity frame), so the congruent test and
 *    the seat sizing can't be skewed by the avatar's later upright rotation.
 * 2. `createHeadAttachment` runs once the body scene is parented under the
 *    avatar root and builds the mount/seat/fallback for the face.
 */

import {
  AnimationMixer,
  Group,
  Vector3,
} from 'three'
import type { Object3D } from 'three'

import { createHeadMount } from './attachHead'
import type { HeadMount } from './attachHead'
import type { HeadComposeMode } from './avatarProps'
import { findBone, findHeadBone } from './rig'
import { seatHeadAlign } from './seating'

/** Whether a loaded GLB scene carries its own skinned rig (vs a static mesh). */
function hasOwnRig(scene: Object3D): boolean {
  let rigged = false
  scene.traverse((o) => {
    if ((o as { isSkinnedMesh?: boolean }).isSkinnedMesh) rigged = true
  })
  return rigged
}

const _wp = new Vector3()

function worldOf(o: Object3D | null): [number, number, number] | null {
  if (!o) return null
  o.getWorldPosition(_wp)
  return [_wp.x, _wp.y, _wp.z]
}

/** Neck bone of a mixamorig scene (tolerant of `:` / sanitized names). */
function findNeck(root: Object3D) {
  return findBone(root, 'mixamorig:Neck') ?? findBone(root, 'Neck')
}

export interface HeadComposePlan {
  /** Body head bone the face mounts on (null when the rig has no head bone). */
  bone: Object3D | null
  /** Body hips bone (used by the upright reveal test). */
  hips: Object3D | null
  /** The face GLB carries its own skinned skeleton. */
  faceRigged: boolean
  /** Rigged face rests <1 cm from the body head at the same skeleton rest. */
  congruent: boolean
  /** `headMode === 'seat'` forces seat glue (no dual-drive). */
  forceSeat: boolean
  // Measured rest positions (identity frame) feeding the seat math.
  bodyHeadW: [number, number, number] | null
  bodyNeckW: [number, number, number] | null
  faceHeadW: [number, number, number] | null
  faceNeckW: [number, number, number] | null
}

/**
 * Measure both skeletons' authored rest and classify how the face should be
 * composed. Must be called while `bodyScene`/`faceScene` are **not yet
 * parented** under the avatar root — they are temporarily grouped under an
 * identity probe so the world measurements are rotation-independent.
 */
export function classifyHeadCompose(opts: {
  bodyScene: Object3D
  faceScene: Object3D
  headBone: string | null
  headMode: HeadComposeMode
}): HeadComposePlan {
  const { bodyScene, faceScene, headBone, headMode } = opts

  const bone = findHeadBone(bodyScene, headBone)
  const hips =
    findBone(bodyScene, 'mixamorig:Hips') ?? findBone(bodyScene, 'Hips')
  const faceRigged = hasOwnRig(faceScene)

  const probe = new Group()
  probe.add(bodyScene)
  probe.add(faceScene)
  probe.updateMatrixWorld(true)
  const neckB = findNeck(bodyScene)
  const headF = bone
    ? findBone(faceScene, bone.name) ?? findHeadBone(faceScene)
    : null
  const neckF = findNeck(faceScene)
  const bodyHeadW = bone ? worldOf(bone) : null
  const bodyNeckW = worldOf(neckB)
  const faceHeadW = worldOf(headF)
  const faceNeckW = worldOf(neckF)
  probe.remove(bodyScene)
  probe.remove(faceScene)

  const congruent =
    !!bodyHeadW &&
    !!faceHeadW &&
    Math.hypot(
      bodyHeadW[0] - faceHeadW[0],
      bodyHeadW[1] - faceHeadW[1],
      bodyHeadW[2] - faceHeadW[2],
    ) < 0.01

  return {
    bone,
    hips,
    faceRigged,
    congruent,
    forceSeat: headMode === 'seat',
    bodyHeadW,
    bodyNeckW,
    faceHeadW,
    faceNeckW,
  }
}

/** The face attachment the rig-lifecycle keeps alive for one composition. */
export interface HeadAttachment {
  mount: HeadMount | null
  /** Face group to toggle visibility on (`mount.group`, else the fallback). */
  group: Group | null
  /** Mixer driving the face's own skeleton (rigged dual-drive/fallback only). */
  headMixer: AnimationMixer | null
  /** Detach the face, dispose the mount and stop the face mixer. */
  dispose: () => void
}

/**
 * Attach the face to the composed avatar. Call **after** `bodyScene` has been
 * parented under the avatar `root` (so the head bone's world frame is live).
 *
 * - Rigged + congruent (and not forced-seat) → co-located dual-drive
 *   (`mode:'offset'`): the face's own rig is driven by the same clip.
 * - Rigged + foreign → size-fit by neck→head ratio (authored size when
 *   `forceSeat`), its Head bone moved to the seat origin, then rigid-glued
 *   (`mode:'mount'`) onto the live body head bone.
 * - Static face on a head bone → rigid glue (`mode:'mount'`).
 * - No head bone → plain fallback group under the root.
 */
export function createHeadAttachment(opts: {
  root: Group
  faceScene: Object3D
  plan: HeadComposePlan
}): HeadAttachment {
  const { root, faceScene, plan } = opts
  const {
    bone,
    faceRigged,
    congruent,
    forceSeat,
    bodyHeadW,
    bodyNeckW,
    faceHeadW,
    faceNeckW,
  } = plan

  let headMixer: AnimationMixer | null = null
  let mount: HeadMount | null = null
  let fallback: Group | null = null
  let seat: Group | null = null

  if (faceRigged) {
    if (bone) {
      if (congruent && !forceSeat) {
        // Same character: co-located dual-drive (head deforms in exact sync).
        mount = createHeadMount({
          bone,
          root,
          content: faceScene,
          mode: 'offset',
        })
        headMixer = new AnimationMixer(faceScene)
      } else {
        // Not dual-driving: seat the face (its Head bone moved to the seat
        // origin) and rigid-glue that origin onto the live body head bone so
        // it tracks at exactly [0,0,0] even mid-clip. A foreign character is
        // sized by its neck→head ratio; the `forceSeat` (cross-look) override
        // keeps the authored size (s = 1) instead, because those heads are
        // near-congruent in size, only their proportions drift.
        seat = new Group()
        seat.name = 'AvatarHeadSeat'
        seat.add(faceScene)
        let s = 1
        if (!forceSeat) {
          const align = seatHeadAlign({
            head: faceHeadW ?? [0, 0, 0],
            neck: faceNeckW ?? [0, 0, 0],
            targetHead: bodyHeadW ?? [0, 0, 0],
            targetNeck: bodyNeckW ?? [0, 0, 0],
          })
          s = align.scale
        }
        seat.scale.setScalar(s)
        if (faceHeadW) {
          seat.position.set(
            -faceHeadW[0] * s,
            -faceHeadW[1] * s,
            -faceHeadW[2] * s,
          )
        }
        mount = createHeadMount({
          bone,
          root,
          content: seat,
          mode: 'mount',
        })
      }
    } else {
      fallback = new Group()
      fallback.name = 'AvatarHeadMount'
      fallback.add(faceScene)
      root.add(fallback)
      headMixer = new AnimationMixer(faceScene)
    }
  } else if (bone) {
    // Legacy static face: glue it to the head bone (follows the animation).
    mount = createHeadMount({ bone, root, content: faceScene, mode: 'mount' })
  } else {
    fallback = new Group()
    fallback.name = 'AvatarHeadMount'
    fallback.add(faceScene)
    root.add(fallback)
  }

  return {
    mount,
    group: mount ? mount.group : fallback,
    headMixer,
    dispose: () => {
      mount?.dispose()
      if (seat) seat.remove(faceScene)
      if (fallback) {
        fallback.remove(faceScene)
        if (fallback.parent === root) root.remove(fallback)
      }
      headMixer?.stopAllAction()
    },
  }
}
