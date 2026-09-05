/**
 * Head mount — seats the face/head content onto a skeleton bone.
 *
 * Two composition modes, selected by {@link HeadMountOptions.mode}:
 *
 * - `'mount'` (legacy static face): the content is glued to the bone. Its
 *   origin is pulled onto the bone and offset by `offset.position`; it follows
 *   the bone's animation rigidly.
 *
 * - `'offset'` (rigged face sharing the rig): the content is already authored
 *   in the same rig space and driven by its own (identical) skeleton, so at
 *   offset = identity it stays exactly where authored. `offset` is a nudge
 *   expressed in the body head-bone's live frame, applied as a world-space
 *   delta `D` and *conjugated* through the mount parent's world transform
 *   (`local = parentWorld⁻¹ · D · parentWorld`) so that at identity the head
 *   stays glued to the co-rotating body — even under a stage wrapper that
 *   re-orients the avatar.
 *
 * The face group lives on the avatar root (never parented into the 0.01-scaled
 * armature).
 */

import { Euler, Group, Matrix4, Quaternion, Vector3 } from 'three'
import type { Object3D } from 'three'
import type { HeadInsertion } from './types'

export type HeadMountMode = 'mount' | 'offset'

export interface HeadMountOptions {
  /** Bone the face is mounted on / referenced for offset axes. */
  bone: Object3D
  /** Parent the face group is added to (the avatar root). */
  root: Object3D
  /** Static face scene to seat onto the bone. */
  content?: Object3D
  /** `'mount'` glues content to the bone; `'offset'` nudges from authored spot. */
  mode?: HeadMountMode
}

export interface HeadMount {
  readonly group: Group
  /** Re-seats the face from the bone's current (animated) transform. */
  update(offset: HeadInsertion): void
  /** Detaches the face group from the root. Does not dispose the content. */
  dispose(): void
}

const _bonePos = new Vector3()
const _boneQuat = new Quaternion()
const _boneQuatInv = new Quaternion()
const _offsetQuat = new Quaternion()
const _offsetPos = new Vector3()
const _euler = new Euler()
const _rotDelta = new Quaternion()
const _parentQ = new Quaternion()
const _parentInvQ = new Quaternion()
const _parentPos = new Vector3()
const _tmpVec = new Vector3()
const _scale = new Vector3()
const _world = new Matrix4()
const _parentInv = new Matrix4()
const _local = new Matrix4()

export function createHeadMount(options: HeadMountOptions): HeadMount {
  const { bone, root, content, mode = 'mount' } = options

  const group = new Group()
  group.name = 'AvatarHeadMount'
  if (content) group.add(content)
  root.add(group)

  const update = (offset: HeadInsertion): void => {
    const parent = group.parent
    if (!parent) return

    _scale.set(offset.scale[0], offset.scale[1], offset.scale[2])

    bone.updateWorldMatrix(true, false)
    bone.getWorldPosition(_bonePos)
    bone.getWorldQuaternion(_boneQuat)

    _euler.set(
      (offset.rotation[0] * Math.PI) / 180,
      (offset.rotation[1] * Math.PI) / 180,
      (offset.rotation[2] * Math.PI) / 180,
      'XYZ',
    )
    _offsetQuat.setFromEuler(_euler)

    if (mode === 'mount') {
      // Absolute: place content origin on the bone (+ offset), glued rigidly.
      _offsetPos
        .set(offset.position[0], offset.position[1], offset.position[2])
        .applyQuaternion(_boneQuat)
        .add(_bonePos)
      _world.compose(_offsetPos, _boneQuat.multiply(_offsetQuat), _scale)

      parent.updateWorldMatrix(true, false)
      _parentInv.copy(parent.matrixWorld).invert()
      _local.copy(_world).premultiply(_parentInv)
      _local.decompose(group.position, group.quaternion, group.scale)
    } else {
      // Offset delta about the bone's live axes (identity → no change).
      _boneQuatInv.copy(_boneQuat).invert()
      _rotDelta.copy(_boneQuat).multiply(_offsetQuat).multiply(_boneQuatInv)

      parent.updateWorldMatrix(true, false)
      parent.getWorldQuaternion(_parentQ)
      parent.getWorldPosition(_parentPos)
      _parentInvQ.copy(_parentQ).invert()

      // local rotation = P⁻¹ · D · P  (keeps head glued to the co-rotating body)
      group.quaternion.copy(_parentInvQ).multiply(_rotDelta).multiply(_parentQ)

      // local translation = P⁻¹ · ( Dp + (D−I)·tP )
      _offsetPos
        .set(offset.position[0], offset.position[1], offset.position[2])
        .applyQuaternion(_boneQuat)
      _tmpVec.copy(_parentPos).applyQuaternion(_rotDelta).sub(_parentPos)
      group.position.copy(_tmpVec.add(_offsetPos)).applyQuaternion(_parentInvQ)

      group.scale.set(_scale.x, _scale.y, _scale.z)
    }
  }

  const dispose = (): void => {
    if (content) group.remove(content)
    if (group.parent) group.parent.remove(group)
  }

  return { group, update, dispose }
}
