// ---------------------------------------------------------------------------
// KTX2 decode — transcode GPU-compressed textures for the production viewer
// ---------------------------------------------------------------------------
// The counterpart to ./opfs/ktx2.ts, which *encodes*. They live apart because
// decoding needs a live renderer (`detectSupport`) and the encoder does not —
// and the encoder's only caller, the optimiser, runs outside the canvas where
// no renderer exists.
//
// `parse` is used rather than `load`: the bytes are already in memory, straight
// out of the deploy zip, so `load` would only add a fetch and an object-URL
// round trip.
// ---------------------------------------------------------------------------

import type { CompressedTexture } from 'three/webgpu'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'

/** Same-origin path the transcoder is served from — see public/lib/basis/README.md.
 *  three's own default resolves relative to its own bundle, which Vite rewrites
 *  into `node_modules/.vite/deps/`, where the sibling `.wasm` is not present. */
const TRANSCODER_PATH = '/lib/basis/'

/**
 * The subset of a renderer this module asks about, checked structurally.
 *
 * Deliberately *not* a declared interface parameter: these fields are optional,
 * so an all-optional shape is a weak type that TypeScript refuses to match
 * against a concrete renderer — and R3F types `gl` as a `WebGLRenderer` anyway
 * (see `runtime-intelligence`'s glTypes), even when the canvas was given a
 * `WebGPURenderer`. Taking `unknown` keeps the cast inside this module.
 */
interface CompressedSupportRenderer {
    hasFeature?: (feature: string) => boolean
}

/**
 * One loader for the whole app.
 *
 * `KTX2Loader` counts active instances and warns on a second one, and each
 * instance carries a transcoder plus a 4-worker pool — a per-component loader
 * would multiply both, and nothing here ever calls `dispose()`.
 */
let loader: KTX2Loader | null = null

function getLoader(renderer: unknown): KTX2Loader {
    if (!loader) {
        loader = new KTX2Loader()
        loader.setTranscoderPath(TRANSCODER_PATH)
    }
    // Deliberately re-run per call rather than cached: it is idempotent, it is
    // cheap, and the renderer can be replaced (R3F remounts it) — the config it
    // derives is what the worker transcodes against.
    loader.detectSupport(renderer as any)
    return loader
}

/**
 * Can this renderer sample GPU-compressed textures at all?
 *
 * Asked of the *renderer*, not of the optimiser's `supportsCompressedFormats()`:
 * that helper calls `requestAdapter()` without `featureLevel: 'compatibility'`
 * while three calls it with it, so the two can describe different adapters.
 * This one describes the adapter actually in use.
 *
 * Requires an **initialised** renderer: `hasFeature` is inherited from three's
 * base `Renderer`, which delegates to the backend and throws outright if the
 * backend has not been set up yet. Callers must `await renderer.init()` first
 * (the R3F canvas here does), and should treat a throw as "unsupported" rather
 * than letting it escape.
 *
 * The check is not advisory. On a renderer with none of these features the
 * transcoder falls through to `RGBA32`, producing a `CompressedTexture` that
 * carries an *uncompressed* format — which three's WebGPU upload path then feeds
 * to `_getBlockData`, which has no RGBA8 case, and throws
 * `TypeError: undefined is not an object (evaluating 'blockData.width')`.
 * Callers must route such a device to the plain payload instead.
 */
export function supportsCompressedTextures(renderer: unknown): boolean {
    const candidate = renderer as CompressedSupportRenderer | null | undefined
    if (!candidate || typeof candidate.hasFeature !== 'function') return false
    return [
        'texture-compression-bc',
        'texture-compression-etc2',
        'texture-compression-astc',
        'texture-compression-s3tc',
        'texture-compression-etc1',
        'texture-compression-pvrtc',
    ].some((feature) => candidate.hasFeature!(feature))
}

/**
 * Transcode one KTX2 container into a GPU-compressed texture.
 *
 * The explicit `Promise` is load-bearing: `KTX2Loader.parse` returns `undefined`
 * on its fresh-buffer path (only a cache hit returns a promise), so awaiting its
 * return value would resolve *immediately* — before the texture exists — and a
 * decode failure would surface as an unhandled rejection rather than a catch.
 *
 * Note this **detaches `bytes`**: the loader transfers the buffer to its worker
 * pool. The caller must not read that buffer again — in particular, a texture
 * whose transcode fails must fall back to its *plain payload*, not to these bytes.
 */
export function transcodeKtx2(renderer: unknown, bytes: ArrayBuffer): Promise<CompressedTexture> {
    const activeLoader = getLoader(renderer)
    return new Promise((resolve, reject) => {
        activeLoader.parse(
            bytes,
            (texture) => resolve(texture as unknown as CompressedTexture),
            reject,
        )
    })
}
