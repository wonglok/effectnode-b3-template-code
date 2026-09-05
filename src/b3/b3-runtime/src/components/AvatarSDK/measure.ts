/**
 * Bounding-box measurement that reflects the *rendered* size of an object.
 *
 * three's default (non-precise) `Box3.setFromObject` uses the raw geometry box,
 * which is meaningless for the EffectNode skinned exports: their geometry is
 * stored near the origin and stretched ~100× onto the bones by skinning, so it
 * reads ~1 cm for a ~1 m figure.
 *
 * `Box3.expandByObject(object, precise)` is the fix: in precise mode three walks
 * every vertex through `getVertexPosition`, which for a `SkinnedMesh` applies
 * `applyBoneTransform` — the same skinning the renderer uses — before mapping by
 * `matrixWorld`. So the returned box is the real on-screen AABB. It also covers
 * plain meshes precisely (vertex-accurate even when rotated), instead of
 * transforming only the 8 corners of the local box.
 */

import { Box3 } from 'three'
import type { Object3D } from 'three'

export interface MeasuredBox {
  /** [x,y,z] lower corner, metres in world space. */
  min: number[]
  /** [x,y,z] upper corner, metres in world space. */
  max: number[]
  /** [x,y,z] extents, metres in world space. */
  size: number[]
}

/**
 * World-axis-aligned box of every visible mesh under `root`, evaluated at the
 * skeleton's current pose (bind/rest if nothing is animating yet).
 */
export function measureWorldBox(root: Object3D): MeasuredBox {
  // Force an update of the whole subtree (incl. bone matrixWorld) so the
  // skinning inside `expandByObject` reads fresh bone transforms.
  root.updateMatrixWorld(true)

  const box = new Box3()
  box.expandByObject(root, true)

  return {
    min: [box.min.x, box.min.y, box.min.z],
    max: [box.max.x, box.max.y, box.max.z],
    size: [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z],
  }
}

/** Largest bounding-box dimension (uniform-scale invariant), metres. */
export function largestDimension(box: MeasuredBox): number {
  return Math.max(box.size[0], box.size[1], box.size[2])
}
