// ---------------------------------------------------------------------------
// KTX2 / Basis Universal encode — GPU-compressed textures for the OPFS optimiser
// ---------------------------------------------------------------------------
// AVIF and WebP shrink the *file*, but they still decode to raw RGBA in VRAM:
// a 1024² texture costs 4 MB there either way, plus mips. KTX2/Basis keeps the
// texture compressed *on the GPU* — the driver transcodes it to BC7 / ETC2 /
// ASTC once at upload, so the same 1024² costs ~1 MB. That is the actual lever.
//
// Everything KTX2 lives here so neither the optimiser nor the viewer grows a
// second copy of it. The encoder is reached through a *dynamic* import, so a
// deploy that ships no .ktx2 files never fetches the ~3.3 MB wasm.
//
// Measured against the real textures in public/deploy/scene.zip (1024², mips):
//
//     source            shipped webp      KTX2 ETC1S q150     ratio
//     Grass Color        2,268,736 B          218,244 B       10.4×
//     Grass Normal       2,896,484 B          207,470 B       14.0×
//
// i.e. ETC1S is both smaller to download *and* ~4× smaller in VRAM. The
// trade is fidelity — ETC1S is a low-bitrate codec, so the fallback path in
// the optimiser is not decorative; see `isNormalMap` below.
// ---------------------------------------------------------------------------

/** MIME type written into the texture manifest for a KTX2 entry. */
export const KTX2_MIME = 'image/ktx2'

/**
 * Whether the encoder Y-flips the source before compressing.
 *
 * This is the one constant that, if wrong, silently mirrors every texture —
 * and a mirrored foliage or bark texture looks entirely plausible, so it will
 * not be caught by eye. It is `true` on purpose:
 *
 *   - Blender exports raw UVs with no V inversion, so the viewer has always
 *     set `texture.flipY = true` to reconcile them with a top-down image
 *     decode (see ProductionViewer's `resolveTexture`).
 *   - `CompressedTexture` hard-forces `flipY = false`, and WebGPU's compressed
 *     upload path takes no flip argument at all — so the flip cannot be
 *     applied at sample time and must be baked into the file.
 *
 * Verified empirically rather than reasoned about: encoding a half-red/half-blue
 * canvas with `isYFlip: true` puts BLUE in row 0, i.e. bottom-up scanlines,
 * which is exactly what a `flipY = false` CompressedTexture expects.
 */
export const KTX2_IS_Y_FLIP = true

/**
 * The KTX2 container identifier (`«KTX 20»\r\n\x1A\n`). Used to assert that an
 * encode actually produced a KTX2 file rather than an empty buffer or an error
 * string — the encoder fails soft in some paths.
 */
export const KTX2_MAGIC = new Uint8Array([
    0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a,
])

/**
 * The encoder wasm, served from a stable same-origin path.
 *
 * `ktx2-encoder` defaults to `new URL('../basis/basis_encoder.wasm',
 * import.meta.url)`. Vite pre-bundles the package into `node_modules/.vite/deps/`,
 * so that relative path resolves next to the generated chunk and 404s. See
 * `public/lib/basis/README.md` — the same trap as three's transcoder, and the
 * same fix (mirroring the committed `public/draco/` precedent).
 */
const ENCODER_WASM_URL = '/lib/basis/basis_encoder.wasm'

/** ETC1S quality (1-255). 150 is basisu's own default and the knee of the
 *  curve — measured on a real 1024² normal map, q255 costs 47% more bytes for
 *  no visible gain the eye can find at screen resolution.
 *
 *  The option is `qualityLevel`, NOT `quality`. A `quality` key is accepted and
 *  silently ignored (the encoder prints the quality it actually used — worth
 *  reading on the first run, since two different `quality` values producing
 *  byte-identical output is the only symptom). */
const DEFAULT_QUALITY_LEVEL = 150

/** `compressionLevel` is the encoder's effort knob, default 2 / range 0-6.
 *  Do not raise it: measured at 6 it took 76.6s versus 2.1s for a *0.4%*
 *  smaller file. Left at the default deliberately. */
const DEFAULT_COMPRESSION_LEVEL = 2

// A known ETC1S limitation, accepted rather than discovered later.
//
// ETC1S is a low-bitrate codec that shares an endpoint/selector codebook across
// 8×8 blocks, so content changing sharply within a block smears. Measured on an
// adversarial case (a 1px saturated-green column at 64²) the green shifted to
// (106, 221, 255) — cyan. Real photographic and PBR textures at 1024² do not
// exhibit this, and UASTC does not smear at all, but UASTC is ~7× larger.
//
// If one specific texture does need to be exact, the per-texture fallback in
// the optimiser is the escape hatch: route that texture through AVIF/WebP
// rather than chasing it with a higher `qualityLevel`, which will not help.

const DEFAULT_MAX_SIZE = 1024

export interface Ktx2EncodeOptions {
    /** Longest edge, in pixels. */
    maxWidth?: number
    maxHeight?: number
    /** ETC1S quality, 1-255. Higher is larger and slower. */
    qualityLevel?: number
    /**
     * Tunes several codec parameters for tangent-space normal maps
     * (`setNormalMap` / the `-normal_map` basisu preset). Worth setting: ETC1S
     * is at its weakest on the smooth gradients a normal map is made of, and
     * this preset is the codec's own answer to that. Measured cost is nil
     * (305,376 B vs 305,072 B on a real 1024² normal map).
     */
    isNormalMap?: boolean
    /**
     * Whether the payload is colour. Defaults to true.
     *
     * Set false for every linear slot — normal, roughness, metalness, emissive.
     * This is not cosmetic: it writes (or omits) the sRGB transfer function in
     * the container's DFD, and the transcode target is chosen from that flag,
     * so an sRGB-tagged roughness map uploads into an `*-SRGB` GPU format and
     * gets decoded as if it were a colour.
     */
    isColor?: boolean
}

export interface Ktx2EncodeResult {
    bytes: Uint8Array
    mime: string
    width: number
    height: number
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function hasMagic(bytes: Uint8Array): boolean {
    if (bytes.length < KTX2_MAGIC.length) return false
    for (let i = 0; i < KTX2_MAGIC.length; i++) {
        if (bytes[i] !== KTX2_MAGIC[i]) return false
    }
    return true
}

/** True when a manifest entry's mime says the payload is a KTX2 container. */
export function isKtx2Mime(mime: string | undefined | null): boolean {
    return mime === KTX2_MIME
}

/** True when the bytes themselves are a KTX2 container (magic, not mime). */
export function isKtx2Bytes(bytes: Uint8Array | ArrayBuffer): boolean {
    return hasMagic(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
}

/**
 * Can this device sample GPU-compressed textures at all?
 *
 * If no `texture-compression-*` feature is exposed, the transcoder falls back
 * to `RGBA32` — in which case KTX2 is strictly *worse* than AVIF: same raw
 * VRAM cost, larger file, plus a transcode step. So this gates the whole
 * feature rather than being advisory.
 *
 * Cheap and cached: one `requestAdapter()` the browser has already resolved.
 */
let compressedFormatsSupported: boolean | null = null

export async function supportsCompressedFormats(): Promise<boolean> {
    if (compressedFormatsSupported !== null) return compressedFormatsSupported

    const gpu = (navigator as any)?.gpu
    if (!gpu) {
        compressedFormatsSupported = false
        return compressedFormatsSupported
    }

    try {
        const adapter = await gpu.requestAdapter()
        if (!adapter) {
            compressedFormatsSupported = false
            return compressedFormatsSupported
        }
        compressedFormatsSupported = [
            'texture-compression-bc',
            'texture-compression-etc2',
            'texture-compression-astc',
        ].some((feature) => adapter.features.has(feature))
    } catch {
        // No secure context / WebGPU disabled / adapter refused.
        compressedFormatsSupported = false
    }
    return compressedFormatsSupported
}

// ---------------------------------------------------------------------------
// Encoder bootstrap
// ---------------------------------------------------------------------------

type EncodeToKTX2 = typeof import('ktx2-encoder').encodeToKTX2

let encoderPromise: Promise<EncodeToKTX2> | null = null
let encoderReady: Promise<void> | null = null

async function loadEncoder(): Promise<EncodeToKTX2> {
    if (!encoderPromise) {
        encoderPromise = import('ktx2-encoder').then((mod) => mod.encodeToKTX2)
    }
    return encoderPromise
}

/**
 * Fetch, instantiate and prove the encoder works — once per session.
 *
 * Deliberately a *real* 4×4 encode rather than a presence check. Loading the
 * wasm can fail in ways a feature test would miss (404 on the .wasm, a bad
 * Content-Type, a WASM instantiation the browser refuses), and every one of
 * those failures would otherwise surface 20 textures into a run, as 20
 * individual fallbacks — which is exactly the outcome that hides for a week.
 */
export async function ensureKtx2Encoder(): Promise<void> {
    if (encoderReady) return encoderReady

    encoderReady = (async () => {
        const encodeToKTX2 = await loadEncoder()

        const size = 4
        const rgba = new Uint8Array(size * size * 4)
        for (let i = 0; i < size * size; i++) {
            rgba[i * 4] = 255
            rgba[i * 4 + 3] = 255
        }

        const out = await encodeToKTX2(new Uint8Array(0), {
            isKTX2File: true,
            isUASTC: false,
            isYFlip: KTX2_IS_Y_FLIP,
            needSupercompression: false,
            generateMipmap: false,
            wasmUrl: ENCODER_WASM_URL,
            imageDecoder: async () => ({ data: rgba, width: size, height: size }),
        })

        if (!hasMagic(out)) {
            throw new Error(
                `[KTX2] Encoder produced ${out.length} bytes that are not a KTX2 container — ` +
                    `check that ${ENCODER_WASM_URL} is served correctly.`,
            )
        }
    })()

    // Let the next caller retry after a transient failure (offline, cold
    // server) rather than caching the rejection for the session.
    encoderReady.catch(() => {
        encoderReady = null
        encoderPromise = null
    })

    return encoderReady
}

// ---------------------------------------------------------------------------
// Encode
// ---------------------------------------------------------------------------

/**
 * Round down to a multiple of 4.
 *
 * ETC1S works on 4×4 blocks. Given a 798px edge the encoder pads to 800 and
 * records the *padded* size in the container, so the texture silently gains
 * two pixels of edge. Rounding the cap down first keeps the transcode
 * dimensions equal to the authored ones — and costs at most 3px of a
 * 1024px texture.
 */
function floorTo4(value: number): number {
    return Math.max(4, value - (value % 4))
}

function computeKtx2Size(
    w: number,
    h: number,
    maxW: number,
    maxH: number,
): { width: number; height: number } {
    if (w <= maxW && h <= maxH) return { width: floorTo4(w), height: floorTo4(h) }
    const scale = Math.min(maxW / w, maxH / h)
    return { width: floorTo4(Math.round(w * scale)), height: floorTo4(Math.round(h * scale)) }
}

/**
 * Encode one texture to a KTX2 container.
 *
 * Pixels are handed to the encoder as raw RGBA through its `imageDecoder`
 * hook, rather than as an encoded PNG it would have to decode: we already have
 * the bitmap, and the round-trip through PNG would cost both time and quality.
 *
 * Throws on failure. The caller is expected to fall back to AVIF/WebP for that
 * texture rather than dropping it — a mixed manifest is valid by construction,
 * because the reader resolves the format per entry.
 */
export async function encodeKtx2(
    source: ImageBitmap | Blob,
    options: Ktx2EncodeOptions = {},
): Promise<Ktx2EncodeResult> {
    const {
        maxWidth = DEFAULT_MAX_SIZE,
        maxHeight = DEFAULT_MAX_SIZE,
        qualityLevel = DEFAULT_QUALITY_LEVEL,
        isNormalMap = false,
        isColor = true,
    } = options

    await ensureKtx2Encoder()
    const encodeToKTX2 = await loadEncoder()

    // Only close a bitmap we created — a caller-owned one is still theirs, and
    // the optimiser reuses its source for the AVIF/WebP fallback.
    const ownsBitmap = source instanceof Blob
    const bitmap = ownsBitmap ? await createImageBitmap(source) : source
    const { width, height } = computeKtx2Size(bitmap.width, bitmap.height, maxWidth, maxHeight)

    const canvas = new OffscreenCanvas(width, height)
    // `willReadFrequently` because the very next thing we do is read the whole
    // thing back out — without it the browser may keep the canvas on the GPU
    // and pay for a readback per texture.
    const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D
    ctx.drawImage(bitmap, 0, 0, width, height)
    if (ownsBitmap) bitmap.close()

    const imageData = ctx.getImageData(0, 0, width, height)
    const rgba = new Uint8Array(imageData.data.buffer)

    const bytes = await encodeToKTX2(new Uint8Array(0), {
        isKTX2File: true,
        // ETC1S, not UASTC. UASTC is the higher-quality mode but measured ~7×
        // larger on the same texture — it is a *VRAM* format, not a download
        // one, and this asset path is download-bound.
        isUASTC: false,
        isYFlip: KTX2_IS_Y_FLIP,
        // Explicitly off. The package defaults this to `true`, and it is the
        // UASTC zstd path — irrelevant for ETC1S, and three's transcoder ships
        // no ZSTD_/HUF_ symbols, so a supercompressed container may not decode
        // at all.
        needSupercompression: false,
        // CompressedTexture cannot generate mips at runtime, so they must be
        // in the file. This roughly triples the payload and is not optional.
        generateMipmap: true,
        qualityLevel,
        compressionLevel: DEFAULT_COMPRESSION_LEVEL,
        isPerceptual: isColor,
        isSetKTX2SRGBTransferFunc: isColor,
        isNormalMap,
        wasmUrl: ENCODER_WASM_URL,
        imageDecoder: async () => ({ data: rgba, width, height }),
    })

    if (!hasMagic(bytes)) {
        throw new Error(`[KTX2] Encode of ${width}×${height} produced a non-KTX2 container`)
    }

    return { bytes, mime: KTX2_MIME, width, height }
}
