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

/** Loads a (compressed or plain) GLB/GLTF. */
export function loadGLB(url: string, decoderPath?: string): Promise<GLTF> {
  return createGltfLoader(decoderPath).loadAsync(url)
}

const fbxLoader = new FBXLoader()

/** Loads a bone-only Mixamo FBX (used only for its `animations` clips). */
export async function loadFBX(url: string): Promise<THREE.Group> {
  return (await fbxLoader.loadAsync(url)) as THREE.Group
}
