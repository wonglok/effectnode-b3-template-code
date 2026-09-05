/**
 * Skeleton helpers: locate the "head" bone in a rigged body and remap FBX
 * clip tracks so they bind to the GLB skeleton.
 *
 * Naming mismatch handled here: the EffectNode GLBs keep Mixamo's Blender
 * import names with a colon (`mixamorig:Head`), while raw Mixamo FBX clips
 * use the un-prefixed form (`mixamorigHead.quaternion`). `mapClipBones`
 * rewrites each track's node token to whatever the actual scene node is called.
 */

import type * as THREE from 'three'
import type { AnimationClip } from 'three'

export type BoneLike = THREE.Object3D

/** Exact, high-priority bone names to prefer when auto-detecting the head. */
const HEAD_PRIORITY = [
  'mixamorig:Head',
  'mixamorigHead',
  'Head',
  'mixamorig:HeadTop_End',
]

/** Names that merely *contain* "head" but are not the insertion point. */
const HEAD_EXCLUDE = /(top|end|toe|_hit|\bhit|neck)/i

/** Collects every Bone reachable from `root` (bones live under the Armature). */
export function collectBones(root: THREE.Object3D): THREE.Bone[] {
  const out: THREE.Bone[] = []
  root.traverse((o) => {
    if ((o as THREE.Bone).isBone) out.push(o as THREE.Bone)
  })
  return out
}

/**
 * Finds a bone by name. GLTFLoader sanitizes node names (e.g. `mixamorig:Head`
 * becomes `mixamorigHead`), so an override written with the authored name is
 * matched after stripping punctuation too.
 */
export function findBone(
  root: THREE.Object3D,
  name: string,
): THREE.Bone | null {
  const exact = root.getObjectByName(name)
  if (exact && (exact as THREE.Bone).isBone) return exact as THREE.Bone

  const normalized = name.replace(/[:\s]/g, '')
  let hit: THREE.Bone | null = null
  root.traverse((o) => {
    if (!hit && (o as THREE.Bone).isBone && o.name.replace(/[:\s]/g, '') === normalized) {
      hit = o as THREE.Bone
    }
  })
  return hit
}

/**
 * Finds the bone the static face should be inserted into.
 * `override` wins if present; otherwise exact mixamo head names, then any bone
 * whose name contains "head" (excluding toe/top/neck-style bones).
 */
export function findHeadBone(
  root: THREE.Object3D,
  override: string | null = null,
): THREE.Bone | null {
  if (override) {
    const b = findBone(root, override)
    if (b) return b
  }

  for (const name of HEAD_PRIORITY) {
    const b = findBone(root, name)
    if (b) return b
  }

  const bones = collectBones(root)
  return (
    bones.find((b) => {
      const n = b.name.toLowerCase()
      return n.includes('head') && !HEAD_EXCLUDE.test(n)
    }) ?? null
  )
}

/**
 * Resolves an FBX track's bone token to the name of a node in the GLB scene.
 * Order: exact name → insert `:` after `mixamorig` → token minus colons.
 */
function resolveNodeName(root: THREE.Object3D, token: string): string {
  const byName = root.getObjectByName(token)
  if (byName) return token

  const colonized = token.replace(/^mixamorig(?![_:])/, 'mixamorig:')
  if (colonized !== token && root.getObjectByName(colonized)) return colonized

  const normalized = token.replace(/:/g, '')
  if (normalized !== token) {
    const candidates: THREE.Object3D[] = []
    root.traverse((o) => candidates.push(o))
    const hit = candidates.find((o) => o.name.replace(/:/g, '') === normalized)
    if (hit) return hit.name
  }
  return token
}

/**
 * Returns a new clip whose track names point at real nodes in `root`, so an
 * `AnimationMixer` bound to `root` can drive the GLB skeleton with an FBX clip.
 * Leaves the source clip untouched (it may be cached/reused across mounts).
 */
export function mapClipBones(
  clip: AnimationClip,
  root: THREE.Object3D,
): AnimationClip {
  const remapped = clip.clone()

  remapped.tracks = clip.tracks.map((track) => {
    const dot = track.name.lastIndexOf('.')
    if (dot <= 0) return track
    const token = track.name.slice(0, dot)
    const prop = track.name.slice(dot + 1)
    const node = resolveNodeName(root, token)
    if (node === token) return track
    const next = track.clone()
    next.name = `${node}.${prop}`
    return next
  })

  return remapped
}

/**
 * Returns a copy of `clip` keeping only tracks whose bone actually exists under
 * `root`. Used when a co-located rig has fewer bones than the clip (e.g. the
 * 41-bone "male-02" skeleton driven by a 65-bone Mixamo clip) so the mixer
 * doesn't warn about / skip missing targets. Returns the original clip when
 * nothing is dropped, or `null` when no track survives.
 */
export function restrictClipToRoot(
  clip: AnimationClip,
  root: THREE.Object3D,
): AnimationClip | null {
  const kept = clip.tracks.filter((track) => {
    const dot = track.name.lastIndexOf('.')
    if (dot <= 0) return true
    const token = track.name.slice(0, dot)
    const resolved = resolveNodeName(root, token)
    return !!root.getObjectByName(resolved)
  })
  if (kept.length === 0) return null
  if (kept.length === clip.tracks.length) return clip
  const next = clip.clone()
  next.tracks = kept
  return next
}

/** Strips track tokens to a bare bone-name set for diagnostics/debugging. */
export function clipBoneNames(clip: AnimationClip): string[] {
  return [
    ...new Set(
      clip.tracks.map((t) => {
        const dot = t.name.lastIndexOf('.')
        return dot > 0 ? t.name.slice(0, dot) : t.name
      }),
    ),
  ]
}
