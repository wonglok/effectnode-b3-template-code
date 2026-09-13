/**
 * Asset decoders for the avatar SDK.
 *
 * The rigged body GLBs are compressed with both `KHR_draco_mesh_compression`
 * and `EXT_meshopt_compression`, so GLTFLoader must be handed a DRACOLoader
 * (decoder files are served locally, default `/lib/draco/`) and three's inline
 * MeshoptDecoder or it throws before parsing. FBX motion files are bone-only
 * skeletons carrying a single "mixamo.com" clip.
 *
 * The shared `gltfLoader`/`dracoLoader` singletons let R3F's
 * `useLoader(gltfLoader, …)` run with one configured loader. Point the decoders
 * at a different directory with `setDracoDecoderPath(...)` at boot (before the
 * first load), or pass an explicit `decoderPath` to `createGltfLoader` /
 * `configureGltfLoader` / `loadGLB` for a per-call override.
 */

import type * as THREE from 'three'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import { fitWithinCap, rasterize, type ImageSource } from '../utils/textureSizing'

/** Default location of the Draco decoder files (served from the app root). */
export const DEFAULT_DRACO_DECODER_PATH = '/lib/draco/'

let dracoDecoderPath = DEFAULT_DRACO_DECODER_PATH

// One shared draco decoder across every default-configured GLTFLoader instance.
const dracoLoader = new DRACOLoader()
dracoLoader.setDecoderConfig({ type: 'wasm' })
dracoLoader.setDecoderPath(dracoDecoderPath)

/** Current Draco decoder directory (see `setDracoDecoderPath`). */
export function getDracoDecoderPath(): string {
  return dracoDecoderPath
}

/**
 * Point the shared Draco decoder (and therefore the shared `gltfLoader` used
 * by R3F's `useLoader`) at a different directory. Call once at boot before the
 * first model loads; the default is `/lib/draco/`.
 */
export function setDracoDecoderPath(path: string): void {
  if (path === dracoDecoderPath) return
  dracoDecoderPath = path
  dracoLoader.setDecoderPath(path)
}

/** Applies Draco + meshopt decoders to a fresh GLTFLoader. An explicit
 * `decoderPath` that differs from the shared path binds a dedicated
 * DRACOLoader for that directory (so the shared loader is untouched). */
export function configureGltfLoader(
  loader: GLTFLoader,
  decoderPath?: string,
): GLTFLoader {
  loader.setMeshoptDecoder(MeshoptDecoder)
  if (decoderPath && decoderPath !== dracoDecoderPath) {
    const perLoader = new DRACOLoader()
    perLoader.setDecoderConfig({ type: 'wasm' })
    perLoader.setDecoderPath(decoderPath)
    loader.setDRACOLoader(perLoader)
  } else {
    loader.setDRACOLoader(dracoLoader)
  }
  return loader
}

export function createGltfLoader(decoderPath?: string): GLTFLoader {
  return configureGltfLoader(new GLTFLoader(), decoderPath)
}

/**
 * Single configured GLTFLoader for R3F's `useLoader`/Suspense path. Passing an
 * instance (instead of the class) lets `configureGltfLoader` run exactly once;
 * useLoader still caches results per URL.
 */
export const gltfLoader = createGltfLoader()

// ---------------------------------------------------------------------------
// Texture budget
// ---------------------------------------------------------------------------

/** Narrow an unknown value to something `drawImage` accepts, or null. */
function asDrawableImage(value: unknown): ImageSource | null {
  if (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) return value
  if (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) return value
  if (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap) return value
  if (typeof OffscreenCanvas !== 'undefined' && value instanceof OffscreenCanvas) return value
  return null
}

/**
 * Downscale one texture to the app's `MAX_TEXTURE_SIZE`, in place.
 *
 * Deliberately narrow about what it will touch: a `CompressedTexture` (KTX2), a
 * `DataTexture`, and a texture whose image has not decoded yet all carry an
 * `image` that is *not* canvas-drawable, and resampling those would corrupt
 * them. A failure here is logged and the texture keeps its authored size — a
 * texture that is too big is a memory problem, not a reason to fail the load.
 */
function capTextureSize(texture: THREE.Texture): void {
  const image = asDrawableImage(texture.image)
  if (!image) return
  const { width, height } = image
  if (!width || !height) return
  const target = fitWithinCap(width, height)
  if (target.width === width && target.height === height) return
  try {
    texture.image = rasterize(image, target.width, target.height)
    texture.needsUpdate = true
  } catch (error) {
    console.warn(
      `[decoders] could not cap texture "${texture.name}" to ${target.width}×${target.height}`,
      error,
    )
  }
}

/** Cap every texture slot on one material, once per texture identity. */
function capMaterialTextures(material: unknown, seen: Set<string>): void {
  if (!material || typeof material !== 'object') return
  for (const value of Object.values(material as Record<string, unknown>)) {
    const texture = value as THREE.Texture | null
    if (!texture || typeof texture !== 'object' || !('isTexture' in texture)) continue
    if (seen.has(texture.uuid)) continue
    seen.add(texture.uuid)
    capTextureSize(texture)
  }
}

/**
 * Enforce `MAX_TEXTURE_SIZE` on everything a loaded GLB brought with it.
 *
 * GLTFLoader returns embedded images at their authored size, and those images
 * never pass through the two places that normally do the capping —
 * `meshBuilder.getOrCreateTexture` and `ProductionViewer.resolveTexture`. A
 * model therefore uploads whatever the DCC tool exported: `props/water-gun.glb`
 * is a 1.9 MB file carrying three 4096² maps, which cost 192 MB of VRAM for a
 * 5,453-vertex mesh.
 *
 * Runs inside `loadGLB`, on the shared template, so the resample is paid once
 * and every clone shares the capped texture.
 */
export function capGLTFTextures(gltf: GLTF): GLTF {
  const seen = new Set<string>()
  const scenes = gltf.scenes?.length ? gltf.scenes : [gltf.scene]
  for (const scene of scenes) {
    scene?.traverse((object) => {
      const { material } = object as THREE.Mesh
      if (!material) return
      for (const one of Array.isArray(material) ? material : [material]) {
        capMaterialTextures(one, seen)
      }
    })
  }
  return gltf
}

// ---------------------------------------------------------------------------
// Loads
// ---------------------------------------------------------------------------

/**
 * Parsed GLBs, keyed by decoder path + URL — two URLs served through different
 * decoder directories are genuinely different parses, so both parts matter.
 *
 * The *promise* is cached rather than the result, so two callers in the same
 * tick share one download and one Draco/meshopt parse. A rejected load is
 * dropped from the cache so a later caller retries instead of being poisoned by
 * a transient failure.
 *
 * ⚠ The resolved GLTF is a **shared template** — its `scene`, materials and
 * textures are handed to every caller. Clone before reparenting or mutating it
 * (`SkeletonUtils.clone` for skinned meshes); mutating in place moves the model
 * for everyone holding it.
 */
const glbPromises = new Map<string, Promise<GLTF>>()

/** Loads a (compressed or plain) GLB/GLTF, capped to the texture budget and
 *  memoized per URL. The result is shared — clone it before mutating. */
export function loadGLB(url: string, decoderPath?: string): Promise<GLTF> {
  const key = `${decoderPath ?? ''}\n${url}`
  const cached = glbPromises.get(key)
  if (cached) return cached
  const pending = createGltfLoader(decoderPath)
    .loadAsync(url)
    .then(capGLTFTextures)
    .catch((error) => {
      glbPromises.delete(key)
      throw error
    })
  glbPromises.set(key, pending)
  return pending
}

const fbxLoader = new FBXLoader()

/** Loads a bone-only Mixamo FBX (used only for its `animations` clips). */
export async function loadFBX(url: string): Promise<THREE.Group> {
  return (await fbxLoader.loadAsync(url)) as THREE.Group
}
