/**
 * Texture size policy — one definition, shared by both texture-loading paths
 * (`meshBuilder.getOrCreateTexture` for the live Blender sync, and
 * `ProductionViewer.resolveTexture` for a deployed zip).
 *
 * ## Why this exists
 *
 * A synced 4096×4096 texture costs 64 MB of GPU memory as RGBA8, and six of them
 * cost 384 MB — measured at 68% of everything the renderer held. Asset textures
 * arrive from Blender at whatever resolution was authored, and nothing on the
 * way to the GPU reduced them.
 *
 * Both loaders previously only ever *rounded to* a power of two. A 4096² source
 * is already a power of two, so it sailed through untouched: the rounding was a
 * no-op exactly where it mattered most.
 *
 * The cap below is the single knob. It trades no visible detail at normal
 * viewing distance — a 2× reduction, absorbed by mipmapping — for a 4× cut in
 * the memory that dominates this scene.
 */

/**
 * Longest edge a texture may have, in texels. Power of two, so the POT
 * rounding below stays exact for square and power-of-two sources.
 *
 * 4096² → 2048² is a 4× memory reduction (64 MB → 16 MB per texture).
 */
export const MAX_TEXTURE_SIZE = 2048

/** Round a dimension to the nearest power of two. */
export function nearestPOT(value: number): number {
    return Math.pow(2, Math.round(Math.log2(value)))
}

/**
 * Uniform scale factor that brings the longest edge within `max`.
 * Returns exactly `1` when no reduction is needed, so callers can skip the
 * resample entirely and hand back the decoded image untouched.
 */
export function capScale(width: number, height: number, max: number = MAX_TEXTURE_SIZE): number {
    const longest = Math.max(width, height)
    return longest > max ? max / longest : 1
}

/**
 * Target size for a texture that must stay power-of-two: round to POT, then
 * shrink uniformly until the longest edge fits `max`.
 *
 * Scaling both axes by one factor — rather than clamping each independently —
 * is what keeps the aspect ratio intact. `Math.min(nearestPOT(w), max)` would
 * turn a 4096×2048 texture into 2048×2048 and visibly stretch it.
 */
export function potSizeWithinCap(
    width: number,
    height: number,
    max: number = MAX_TEXTURE_SIZE,
): { width: number; height: number } {
    const potWidth = nearestPOT(width)
    const potHeight = nearestPOT(height)
    const scale = capScale(potWidth, potHeight, max)
    if (scale === 1) {
        return { width: potWidth, height: potHeight }
    }
    // Both operands are powers of two and `max` is one too, so the products are
    // exact powers of two — the rounding is a no-op, not a source of drift.
    return {
        width: Math.max(1, nearestPOT(Math.round(potWidth * scale))),
        height: Math.max(1, nearestPOT(Math.round(potHeight * scale))),
    }
}

/**
 * Target size for a texture that does *not* have to be power-of-two: shrink
 * uniformly until the longest edge fits `max`, preserving the exact aspect.
 */
export function fitWithinCap(
    width: number,
    height: number,
    max: number = MAX_TEXTURE_SIZE,
): { width: number; height: number } {
    const scale = capScale(width, height, max)
    if (scale === 1) {
        return { width, height }
    }
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
    }
}

/** Something drawable onto a canvas: a decoded `<img>` or an existing canvas. */
export type ImageSource = HTMLImageElement | HTMLCanvasElement

/**
 * Draw `image` onto an offscreen canvas at `width`×`height`.
 *
 * `imageSmoothingQuality = 'high'` matters here: downscaling 4096² to 2048² with
 * default bilinear settings aliases visibly on high-frequency detail like
 * foliage, and the browser's high-quality path costs nothing at load time.
 */
export function rasterize(image: ImageSource, width: number, height: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) {
        throw new Error('textureSizing: could not get a 2D canvas context.')
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, 0, 0, width, height)
    return canvas
}

/** Decode encoded image bytes via a Blob URL, using the browser's native decoder. */
export function decodeImageBytes(bytes: ArrayBuffer, mime: string): Promise<ImageSource> {
    return new Promise((resolve, reject) => {
        const blob = new Blob([bytes], { type: mime })
        const url = URL.createObjectURL(blob)
        const image = new Image()
        image.onload = () => {
            URL.revokeObjectURL(url)
            resolve(image)
        }
        image.onerror = () => {
            URL.revokeObjectURL(url)
            reject(new Error(`textureSizing: failed to decode image bytes (${mime}).`))
        }
        image.src = url
    })
}
