import * as THREE from "three/webgpu";
import type { TextureData, GeoBuffer } from "../types/blenderTypes";
import { buildTSLMaterial, type ShaderGraph } from "./tslMaterialBuilder";

// ---------------------------------------------------------------------------
// Module-level caches (shared across Viewer and export utilities)
// ---------------------------------------------------------------------------

/** Cached geometries + materials, keyed by `name@version@textureUuid`. */
export const _geoMaterialCache = new Map<
  string,
  { geometry: THREE.BufferGeometry; material: THREE.MeshPhysicalNodeMaterial }
>();

/** Three.js Textures built from encoded image data via TextureLoader, keyed by `name:kind`. */
const _textureCache = new Map<string, THREE.Texture>();

export type TexKind = "color" | "noncolor";

export function getOrCreateTexture(
  name: string,
  texData: Map<string, TextureData>,
  kind: TexKind,
): THREE.Texture | null {
  const cacheKey = `${name}:${kind}`;
  const existing = _textureCache.get(cacheKey);
  if (existing) return existing;

  const texEntry = texData.get(name);
  if (!texEntry) return null;

  // Create a Blob URL from the encoded image bytes so the browser's native
  // PNG / JPEG / WebP decoder handles the sRGB → linear conversion correctly.
  const blob = new File([texEntry.bytes], "image.png", { type: texEntry.mime });
  const url = URL.createObjectURL(blob);
  const texture = new THREE.TextureLoader().load(url);

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.flipY = true;
  texture.colorSpace =
    kind === "color" ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;

  _textureCache.set(cacheKey, texture);
  return texture;
}

/** Parameters for {@link buildGeometryFromBuffer}. */
export interface BuildGeometryParams {
  buf: GeoBuffer;
  color: [number, number, number];
  roughness: number;
  metalness: number;
  emissiveColor: [number, number, number];
  emissiveIntensity: number;
  map: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  emissiveMap?: THREE.Texture | null;
  transparent?: boolean;
  opacity?: number;
  alphaTest?: number;
  flatShading?: boolean;
  graph?: ShaderGraph;
  // Physical material properties
  transmission?: number;
  transmissionMap?: THREE.Texture | null;
  thickness?: number;
  thicknessMap?: THREE.Texture | null;
  ior?: number;
  clearcoat?: number;
  clearcoatRoughness?: number;
  clearcoatMap?: THREE.Texture | null;
  clearcoatRoughnessMap?: THREE.Texture | null;
  clearcoatNormalMap?: THREE.Texture | null;
  sheen?: number;
  sheenRoughness?: number;
  sheenColor?: [number, number, number];
  sheenColorMap?: THREE.Texture | null;
  sheenRoughnessMap?: THREE.Texture | null;
  specularIntensity?: number;
  specularColor?: [number, number, number];
  specularColorMap?: THREE.Texture | null;
  specularIntensityMap?: THREE.Texture | null;
  iridescence?: number;
  iridescenceMap?: THREE.Texture | null;
  iridescenceIOR?: number;
  iridescenceThicknessRange?: [number, number];
  iridescenceThicknessMap?: THREE.Texture | null;
  anisotropy?: number;
  anisotropyMap?: THREE.Texture | null;
  attenuationDistance?: number;
  attenuationColor?: [number, number, number];
}

/**
 * Build geometry from a pre-transferred binary blob (GeoBuffer).
 * Uses the typed arrays directly — no Float32Array conversion needed.
 */
export function buildGeometryFromBuffer(params: BuildGeometryParams): {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshPhysicalNodeMaterial;
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
  } = params;

  const geo = new THREE.BufferGeometry();

  // Vertices — already a Float32Array from the binary blob
  geo.setAttribute("position", new THREE.BufferAttribute(buf.vertices, 3));

  // Indices — use BufferAttribute to preserve uint32 precision
  geo.setIndex(new THREE.BufferAttribute(buf.indices, 1));

  // UVs — stored as full-precision float64; WebGL vertex attributes only
  // support 32-bit floats, so downcast here at the GPU upload boundary.
  if (buf.uvs && buf.uvs.length > 0) {
    geo.setAttribute(
      "uv",
      new THREE.BufferAttribute(new Float32Array(buf.uvs), 2),
    );
  }

  geo.computeVertexNormals();

  if (normalMap) {
    geo.computeTangents();
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
  });

  return { geometry: geo, material: mat };
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
  return `${objName}@${objVersion}@${map?.uuid ?? "n"}@${metalnessMap?.uuid ?? "n"}@${normalMap?.uuid ?? "n"}@${roughnessMap?.uuid ?? "n"}@${emissiveMap?.uuid ?? "n"}@${geoVersion ?? "n"}`;
}

/** A managed InstancedMesh group — one draw call for N objects sharing the same geometry+material. */
export interface InstancedGroupEntry {
  mesh: THREE.InstancedMesh;
  /** Object names in this instance group (order matches instance index). */
  names: Set<string>;
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
  );
}
