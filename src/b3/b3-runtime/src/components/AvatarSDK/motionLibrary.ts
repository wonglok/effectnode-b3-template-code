/**
 * Motion-clip loading for `<Avatar>`: module-level FBX cache + the library
 * loader that remaps clips onto a given skeleton. Split out of `Avatar.tsx`.
 */

import type { Object3D } from 'three'
import type { AnimationClip } from 'three'

import { loadFBX } from './decoders'
import { mapClipBones } from './rig'
import type { MotionClipDef } from './types'

// Module-level cache so eager FBX loading is shared across mounts/remounts.
const fbxCache = new Map<string, Promise<Object3D>>()

function fbxFor(url: string): Promise<Object3D> {
  let pending = fbxCache.get(url)
  if (!pending) {
    pending = loadFBX(url).catch((error) => {
      fbxCache.delete(url)
      throw error
    })
    fbxCache.set(url, pending)
  }
  return pending
}

/** Loads and remaps every motion FBX in `defs` onto `bodyScene`'s skeleton. */
export async function loadMotionClips(
  defs: MotionClipDef[],
  bodyScene: Object3D,
): Promise<Map<string, AnimationClip>> {
  const clips = new Map<string, AnimationClip>()
  await Promise.all(
    defs.map(async (def) => {
      try {
        const fbx = await fbxFor(def.url)
        const raw = fbx.animations?.[0]
        if (!raw) {
          console.warn(`[avatar] "${def.url}" carries no animation.`)
          return
        }
        const clip = raw.clone()
        clip.name = def.name
        clips.set(def.name, mapClipBones(clip, bodyScene))
      } catch (error) {
        console.warn(`[avatar] failed to load motion "${def.name}":`, error)
      }
    }),
  )
  return clips
}

/** Stable identity of a clip library (name + url per clip), for change memo. */
export function motionClipSignature(defs: MotionClipDef[]): string {
  return defs.map((d) => `${d.name}@${d.url}`).join('|')
}
