import * as THREE from 'three/webgpu'
import type { TextureData, GeoBuffer } from '../types/blenderTypes'
import { buildTSLMaterial, type ShaderGraph } from './tslMaterialBuilder'
import { decodeImageBytes, potSizeWithinCap, rasterize, type ImageSource } from './textureSizing'

// ---------------------------------------------------------------------------
// Module-level caches (shared across Viewer and export utilities)
// ---------------------------------------------------------------------------

/** Cached geometries + materials, keyed by `name@version@textureUuid`. */
export const _geoMaterialCache = new Map<
    string,
    { geometry: THREE.BufferGeometry; material: THREE.MeshPhysicalNodeMaterial }
>()

/** Three.js Textures built from encoded image data, keyed by `name:kind`. */
const _textureCache = new Map<string, THREE.Texture>()

export type TexKind = 'color' | 'noncolor'

/**
 * Decode encoded PNG / JPEG / WebP bytes, then draw them onto an offscreen
 * canvas rounded to the nearest power of two and capped at `MAX_TEXTURE_SIZE`
 * — mirroring `loadAndResizePOTTexture`.
 *
 * POT keeps mipmap generation + RepeatWrapping working on renderers that
 * require them, and gives a single uniform downscale that preserves the aspect
 * ratio. The **cap** is the part that matters for memory: rounding alone is a
 * no-op for an already-POT 4096² source, which then uploaded at a full 64 MB.
 * See `utils/textureSizing`.
 *
 * Decoding goes through the browser's native decoder via a Blob URL, so the
 * resulting image data (and sRGB handling) matches the previous TextureLoader
 * path.
 */
async function decodeImageToPOT(bytes: ArrayBuffer, mime: string): Promise<ImageSource> {
    const image = await decodeImageBytes(bytes, mime)
    const target = potSizeWithinCap(image.width, image.height)
    // Already POT and within the cap: hand back the decoded image untouched
    // rather than paying a lossy resample and an extra canvas allocation.
    if (target.width === image.width && target.height === image.height) {
        return image
    }
    return rasterize(image, target.width, target.height)
}

export function getOrCreateTexture(
    name: string,
    texData: Map<string, TextureData>,
    kind: TexKind = 'color',
): THREE.Texture | null {
    const cacheKey = `${name}:${kind}`
    const existing = _textureCache.get(cacheKey)
    if (existing) return existing

    const texEntry = texData.get(name)
    if (!texEntry) return null

    // Reserve the texture immediately: callers build materials and cache keys
    // from its stable uuid right away, and the decoded image is published onto
    // it once the native decode finishes (same async contract as the old
    // TextureLoader call).
    //
    // The image is intentionally left unset until the decode below resolves.
    // three/webgpu only hands a source to `copyExternalImageToTexture` once it
    // has real pixels, so an empty canvas never reaches the browser — otherwise
    // Chromium logs "CopyExternalImageToTexture(): Browser fails extracting
    // valid resource from external image." (a fresh 300×150 canvas that was
    // never drawn on is not an extractable source).
    const texture = new THREE.Texture()
    _textureCache.set(cacheKey, texture)

    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.RepeatWrapping
    texture.flipY = true
    texture.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace

    decodeImageToPOT(texEntry.bytes, texEntry.mime)
        .then((source) => {
            // Publish the real pixels — the decoded <img> when the source was
            // already POT, otherwise the POT-resized canvas. Bumping needsUpdate
            // after the assignment makes the renderer (re)create the GPU texture
            // at the source's true size and upload it.
            texture.image = source
            // texture.generateMipmaps = false
            // texture.magFilter = THREE.NearestFilter
            // texture.minFilter = THREE.NearestFilter
            texture.needsUpdate = true
        })
        .catch((error) => {
            console.error(`getOrCreateTexture: failed to load texture "${name}"`, error)
        })

    return texture
}

/** Parameters for {@link buildGeometryFromBuffer}. */
export interface BuildGeometryParams {
    buf: GeoBuffer
    color: [number, number, number]
    roughness: number
    metalness: number
    emissiveColor: [number, number, number]
    emissiveIntensity: number
    map: THREE.Texture | null
    roughnessMap: THREE.Texture | null
    metalnessMap: THREE.Texture | null
    normalMap: THREE.Texture | null
    emissiveMap?: THREE.Texture | null
    transparent?: boolean
    opacity?: number
    alphaTest?: number
    flatShading?: boolean
    /** True (default) renders both sides — matches Blender's double-sided default. */
    doubleSided?: boolean
    graph?: ShaderGraph
    // Physical material properties
    transmission?: number
    transmissionMap?: THREE.Texture | null
    thickness?: number
    thicknessMap?: THREE.Texture | null
    ior?: number
    clearcoat?: number
    clearcoatRoughness?: number
    clearcoatMap?: THREE.Texture | null
    clearcoatRoughnessMap?: THREE.Texture | null
    clearcoatNormalMap?: THREE.Texture | null
    sheen?: number
    sheenRoughness?: number
    sheenColor?: [number, number, number]
    sheenColorMap?: THREE.Texture | null
    sheenRoughnessMap?: THREE.Texture | null
    specularIntensity?: number
    specularColor?: [number, number, number]
    specularColorMap?: THREE.Texture | null
    specularIntensityMap?: THREE.Texture | null
    iridescence?: number
    iridescenceMap?: THREE.Texture | null
    iridescenceIOR?: number
    iridescenceThicknessRange?: [number, number]
    iridescenceThicknessMap?: THREE.Texture | null
    anisotropy?: number
    anisotropyMap?: THREE.Texture | null
    attenuationDistance?: number
    attenuationColor?: [number, number, number]
}

/**
 * Build geometry from a pre-transferred binary blob (GeoBuffer).
 * Uses the typed arrays directly — no Float32Array conversion needed.
 */
export function buildGeometryFromBuffer(params: BuildGeometryParams): {
    geometry: THREE.BufferGeometry
    material: THREE.MeshPhysicalNodeMaterial
} {
    const {
        buf,
        color,
        roughness,
        metalness,
        emissiveColor,
        emissiveIntensity,
        map,
        roughnessMap,
        metalnessMap,
        normalMap,
        emissiveMap,
        transparent = false,
        opacity = 1.0,
        alphaTest = 0.0,
        flatShading = false,
        doubleSided = true,
        graph,
        // Physical properties
        transmission = 0,
        transmissionMap = null,
        thickness = 0,
        thicknessMap = null,
        ior = 1.5,
        clearcoat = 0,
        clearcoatRoughness = 0,
        clearcoatMap = null,
        clearcoatRoughnessMap = null,
        clearcoatNormalMap = null,
        sheen = 0,
        sheenRoughness = 0,
        sheenColor = [1, 1, 1],
        sheenColorMap = null,
        sheenRoughnessMap = null,
        specularIntensity = 0,
        specularColor = [1, 1, 1],
        specularColorMap = null,
        specularIntensityMap = null,
        iridescence = 0,
        iridescenceMap = null,
        iridescenceIOR = 1.3,
        iridescenceThicknessRange = [100, 400],
        iridescenceThicknessMap = null,
        anisotropy = 0,
        anisotropyMap = null,
        attenuationDistance = Infinity,
        attenuationColor = [1, 1, 1],
    } = params

    const geo = new THREE.BufferGeometry()

    // Vertices — already a Float32Array from the binary blob
    geo.setAttribute('position', new THREE.BufferAttribute(buf.vertices, 3))

    // Indices — use BufferAttribute to preserve uint32 precision
    geo.setIndex(new THREE.BufferAttribute(buf.indices, 1))

    // UVs — stored as full-precision float64; WebGL vertex attributes only
    // support 32-bit floats, so downcast here at the GPU upload boundary.
    if (buf.uvs && buf.uvs.length > 0) {
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(buf.uvs), 2))
    }

    geo.computeVertexNormals()

    if (normalMap) {
        geo.computeTangents()
    }

    // Build material using the TSL shader graph pipeline
    const mat = buildTSLMaterial({
        geometry: geo,
        graph,
        color,
        roughness,
        metalness,
        emissiveColor,
        emissiveIntensity,
        map,
        roughnessMap,
        metalnessMap,
        normalMap,
        emissiveMap: emissiveMap ?? null,
        transparent,
        opacity,
        alphaTest,
        flatShading,
        doubleSided,
        // Physical properties
        transmission,
        transmissionMap,
        thickness,
        thicknessMap,
        ior,
        clearcoat,
        clearcoatRoughness,
        clearcoatMap,
        clearcoatRoughnessMap,
        clearcoatNormalMap,
        sheen,
        sheenRoughness,
        sheenColor,
        sheenColorMap,
        sheenRoughnessMap,
        specularIntensity,
        specularColor,
        specularColorMap,
        specularIntensityMap,
        iridescence,
        iridescenceMap,
        iridescenceIOR,
        iridescenceThicknessRange,
        iridescenceThicknessMap,
        anisotropy,
        anisotropyMap,
        attenuationDistance,
        attenuationColor,
    })

    return { geometry: geo, material: mat }
}

// ---------------------------------------------------------------------------
// InstancedMesh helpers
// ---------------------------------------------------------------------------

/** Build a cache key that uniquely identifies a geometry+material combination.
 *  Objects sharing the same key can be batched into a single InstancedMesh. */
export function computeMeshCacheKey(
    objName: string,
    objVersion: string,
    geoVersion: string | undefined,
    map: THREE.Texture | null,
    roughnessMap: THREE.Texture | null,
    metalnessMap: THREE.Texture | null,
    normalMap: THREE.Texture | null,
    emissiveMap: THREE.Texture | null,
): string {
    return `${objName}@${objVersion}@${map?.uuid ?? 'n'}@${metalnessMap?.uuid ?? 'n'}@${normalMap?.uuid ?? 'n'}@${roughnessMap?.uuid ?? 'n'}@${emissiveMap?.uuid ?? 'n'}@${geoVersion ?? 'n'}`
}

/** A managed InstancedMesh group — one draw call for N objects sharing the same geometry+material. */
export interface InstancedGroupEntry {
    mesh: THREE.InstancedMesh
    /** Object names in this instance group (order matches instance index). */
    names: Set<string>
}

/**
 * Compose a world matrix from position / quaternion / scale arrays (Blender convention).
 * Used for setting per-instance matrices on InstancedMesh.
 */
export function composeMatrix(
    pos: [number, number, number],
    quat: [number, number, number, number],
    scl: [number, number, number],
): THREE.Matrix4 {
    return new THREE.Matrix4().compose(
        new THREE.Vector3(pos[0], pos[1], pos[2]),
        new THREE.Quaternion(quat[0], quat[1], quat[2], quat[3]),
        new THREE.Vector3(scl[0], scl[1], scl[2]),
    )
}
