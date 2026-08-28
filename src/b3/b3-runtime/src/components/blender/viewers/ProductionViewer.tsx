"use client";

import { useState, useEffect, Suspense, type ReactNode } from "react";
import { useThree } from "@react-three/fiber";
import * as THREE from "three/webgpu";
import JSZip from "jszip";
import draco3d from "draco3d";

import type {
  SceneData,
  CameraData,
  LightData,
  BlenderObject,
  GeoBuffer,
  TextureData,
} from "../../types/blenderTypes";
import { LightFromData } from "../canvas-units/LightFromData";
import { useMeshSync } from "../canvas-units/useMeshSync";
import { useEmptySync } from "../canvas-units/useEmptySync";
import { useEnvironmentMap } from "../canvas-units/useEnvironmentMap";
import {
  buildGeometryFromBuffer,
  computeMeshCacheKey,
  type TexKind,
} from "../../utils/meshBuilder";
import { CanvasGPU } from "../CanvasGPU";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProductionScene {
  objects: BlenderObject[];
  geometryMap: Map<string, GeoBuffer>;
  /** Encoded texture bytes keyed by texture name. Decoded lazily per colour
   *  space — the same image can be a colour map on one object and a
   *  roughness map on another. */
  textureData: Map<string, TextureData>;
  lights: LightData[];
  cameras: CameraData[];
  /** Radiance RGBE HDR buffer — decoded via HDRLoader inside Canvas. */
  hdrBytes: ArrayBuffer | null;
  hdrIntensity: number;
}

/** Decoded textures keyed by `name:kind`, scoped per loaded scene rather than
 *  reusing meshBuilder's module-level cache — production texture names would
 *  otherwise collide with the live sync scene's. Derived state, so it's held
 *  beside the scene instead of on it. */
const _textureCaches = new WeakMap<
  ProductionScene,
  Map<string, THREE.Texture>
>();

/**
 * Decode a zip texture into a Three.js texture with the correct colour space
 * for its usage. Mirrors meshBuilder's `getOrCreateTexture`.
 */
function resolveTexture(
  scene: ProductionScene,
  name: string | undefined,
  kind: TexKind,
): THREE.Texture | null {
  if (!name) return null;

  let cache = _textureCaches.get(scene);
  if (!cache) {
    cache = new Map();
    _textureCaches.set(scene, cache);
  }

  const cacheKey = `${name}:${kind}`;
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const entry = scene.textureData.get(name);
  if (!entry) return null;

  // Go through a Blob URL so the browser's native decoder handles the
  // sRGB → linear conversion for colour maps.
  const blob = new Blob([entry.bytes], { type: entry.mime });
  const url = URL.createObjectURL(blob);
  const texture = new THREE.TextureLoader().load(url, () =>
    URL.revokeObjectURL(url),
  );

  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.flipY = true;
  texture.colorSpace =
    kind === "color" ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;

  cache.set(cacheKey, texture);
  return texture;
}

// ---------------------------------------------------------------------------
// Draco decoder (mirrors the encoder in optimizer.ts)
// ---------------------------------------------------------------------------

const DRACO_WASM_URL = "/draco/";

async function decodeDraco(
  buffer: ArrayBuffer,
  objectName: string,
): Promise<{
  vertices: Float32Array;
  indices: Uint32Array;
  uvs?: Float32Array;
}> {
  // Ensure we have an exact-size buffer (no slack bytes from the zip extraction)
  const bytes = new Uint8Array(buffer);

  const mod = await (draco3d as any).createDecoderModule({
    locateFile: (path: string) => DRACO_WASM_URL + path,
  });

  const decoder = new mod.Decoder();
  const decoderBuffer = new mod.DecoderBuffer();
  decoderBuffer.Init(
    new Int8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    bytes.byteLength,
  );

  const geometryType = decoder.GetEncodedGeometryType(decoderBuffer);
  if (geometryType !== mod.TRIANGULAR_MESH) {
    mod.destroy(decoderBuffer);
    mod.destroy(decoder);
    if (geometryType === -1) {
      throw new Error(`Draco: invalid or corrupt data for "${objectName}"`);
    }
    throw new Error(
      `Draco: unexpected geometry type ${geometryType} for "${objectName}"`,
    );
  }

  const mesh = new mod.Mesh();
  const status = decoder.DecodeBufferToMesh(decoderBuffer, mesh);
  mod.destroy(decoderBuffer);

  if (!status.ok || mesh.num_faces() === 0) {
    mod.destroy(mesh);
    mod.destroy(decoder);
    throw new Error(
      `Draco: decode failed for "${objectName}" (${status.error_string?.() ?? "unknown"})`,
    );
  }

  // Indices
  const numFaces = mesh.num_faces();
  const numIndices = numFaces * 3;
  const indices = new Uint32Array(numIndices);
  const ia = new mod.DracoInt32Array();
  for (let i = 0; i < numFaces; i++) {
    decoder.GetFaceFromMesh(mesh, i, ia);
    indices[i * 3] = ia.GetValue(0);
    indices[i * 3 + 1] = ia.GetValue(1);
    indices[i * 3 + 2] = ia.GetValue(2);
  }
  mod.destroy(ia);

  // POSITION
  const posAttrId = decoder.GetAttributeId(mesh, mod.POSITION);
  if (posAttrId < 0) {
    mod.destroy(mesh);
    mod.destroy(decoder);
    throw new Error(`Draco: no POSITION attribute for "${objectName}"`);
  }

  const posAttr = decoder.GetAttribute(mesh, posAttrId);
  const numVertices = mesh.num_points();
  const vertices = new Float32Array(numVertices * 3);
  const posArray = new mod.DracoFloat32Array();
  decoder.GetAttributeFloatForAllPoints(mesh, posAttr, posArray);
  for (let i = 0; i < numVertices * 3; i++) vertices[i] = posArray.GetValue(i);
  mod.destroy(posArray);

  // TEX_COORD
  let uvs: Float32Array | undefined;
  const texAttrId = decoder.GetAttributeId(mesh, mod.TEX_COORD);
  if (texAttrId >= 0) {
    const texAttr = decoder.GetAttribute(mesh, texAttrId);
    const numUVs = mesh.num_points();
    uvs = new Float32Array(numUVs * 2);
    const uvArray = new mod.DracoFloat32Array();
    decoder.GetAttributeFloatForAllPoints(mesh, texAttr, uvArray);
    for (let i = 0; i < numUVs * 2; i++) uvs[i] = uvArray.GetValue(i);
    mod.destroy(uvArray);
  }

  mod.destroy(mesh);
  mod.destroy(decoder);

  return { vertices, indices, uvs };
}

// ---------------------------------------------------------------------------
// Scene loader (runs once per zip buffer)
// ---------------------------------------------------------------------------

async function loadProductionScene(
  zipBuffer: ArrayBuffer,
): Promise<ProductionScene> {
  const zip = await JSZip.loadAsync(zipBuffer);

  // Parse JSON files
  const sceneJson = zip.file("scene.json");
  const camerasJson = zip.file("cameras.json");
  const lightsJson = zip.file("lights.json");

  const sceneData: SceneData = sceneJson
    ? JSON.parse(await sceneJson.async("text"))
    : { objects: [] };
  const cameras: CameraData[] = camerasJson
    ? JSON.parse(await camerasJson.async("text"))
    : [];
  const lights: LightData[] = lightsJson
    ? JSON.parse(await lightsJson.async("text"))
    : [];

  // HDR environment (Radiance RGBE format — decoded via HDRLoader inside Canvas)
  let hdrBytes: ArrayBuffer | null = null;
  let hdrIntensity = 1.0;

  const hdrConfigFile = zip.file("hdr/config.json");
  if (hdrConfigFile) {
    const hdrConfig = JSON.parse(await hdrConfigFile.async("text"));
    hdrIntensity = hdrConfig.intensity ?? 1.0;
  }

  const hdrBinFile = zip.file("hdr/data.bin");
  if (hdrBinFile) {
    hdrBytes = await hdrBinFile.async("arraybuffer");
  }

  // Pre-load textures into a Map (keyed by texture name)
  const texManifestFile = zip.file("textures/manifest.json");
  const texEntries: { name: string; mime: string }[] = texManifestFile
    ? JSON.parse(await texManifestFile.async("text"))
    : [];

  // Keep the encoded bytes — the colour space depends on how each object
  // uses the texture, so decoding is deferred to `resolveTexture`.
  const textureData = new Map<string, TextureData>();

  for (const entry of texEntries) {
    const ext = entry.mime.split("/")[1] || "webp";
    const texFile = zip.file(`textures/${entry.name}.${ext}`);
    if (!texFile) continue;

    textureData.set(entry.name, {
      mime: entry.mime,
      bytes: await texFile.async("arraybuffer"),
    });
  }

  // Decode geometries into GeoBuffer format (raw typed arrays)
  const geoManifestFile = zip.file("geometry/manifest.json");
  const geoEntries: { name: string }[] = geoManifestFile
    ? JSON.parse(await geoManifestFile.async("text"))
    : [];

  const geometryMap = new Map<string, GeoBuffer>();

  for (const entry of geoEntries) {
    try {
      const safeName = entry.name.replace(/[<>:"/\\|?*]/g, "_");

      // Try Draco first, fall back to raw
      const dracoFile = zip.file(`geometry/${safeName}/draco.bin`);
      if (dracoFile) {
        const dracoBuf = await dracoFile.async("arraybuffer");
        const decoded = await decodeDraco(dracoBuf, entry.name);

        geometryMap.set(entry.name, {
          version: "1",
          vertices: decoded.vertices,
          indices: decoded.indices,
          // Draco decodes to float32 — promote to float64 to match the GeoBuffer type
          uvs: decoded.uvs ? new Float64Array(decoded.uvs) : undefined,
        });
        continue;
      }

      // Fallback: raw vertices + indices
      const vertsFile = zip.file(`geometry/${safeName}/vertices.bin`);
      const idxsFile = zip.file(`geometry/${safeName}/indices.bin`);
      const uvsFile = zip.file(`geometry/${safeName}/uvs.bin`);

      if (vertsFile && idxsFile) {
        const verts = new Float32Array(await vertsFile.async("arraybuffer"));
        const idxs = new Uint32Array(await idxsFile.async("arraybuffer"));
        // Raw fallback UVs are persisted at full float64 precision
        const uvs = uvsFile
          ? new Float64Array(await uvsFile.async("arraybuffer"))
          : undefined;

        geometryMap.set(entry.name, {
          version: "1",
          vertices: verts,
          indices: idxs,
          uvs,
        });
      }
    } catch (err) {
      console.warn(`[ProductionViewer] Geometry "${entry.name}" skipped:`, err);
    }
  }

  return {
    objects: sceneData.objects,
    geometryMap,
    textureData,
    lights,
    cameras,
    hdrBytes,
    hdrIntensity,
  };
}

// ---------------------------------------------------------------------------
// Three.js scene content (rendered inside R3F Canvas)
// ---------------------------------------------------------------------------

function SceneContent({ scene }: { scene: ProductionScene }) {
  const gl = useThree((s) => s.gl);
  const threeScene = useThree((s) => s.scene);

  // Apply HDR environment map (shared hook — same as SyncViewer)
  useEnvironmentMap({
    scene: threeScene,
    renderer: gl,
    hdrPixels: scene.hdrBytes,
    intensity: scene.hdrIntensity,
    background: false,
    fallbackColor: "#000000",
  });

  // Sync meshes via the shared hook — handles caching, InstancedMesh
  // batching, incremental updates, and cleanup.
  useMeshSync({
    scene: threeScene,
    objects: scene.objects,
    resolveTextures: (obj: BlenderObject) => ({
      map: resolveTexture(scene, obj.texture, "color"),
      roughnessMap: resolveTexture(scene, obj.roughnessMap, "noncolor"),
      metalnessMap: resolveTexture(scene, obj.metalnessMap, "noncolor"),
      normalMap: resolveTexture(scene, obj.normalMap, "noncolor"),
      emissiveMap: resolveTexture(scene, obj.emissiveMap, "color"),
    }),
    computeCacheKey: (obj: BlenderObject, textures) => {
      // Geometry in the zip is deduplicated and re-versioned to "1", so key
      // off the canonical geometry name rather than the object name.
      const geoName: string = (obj as any).geometry ?? obj.name;
      return computeMeshCacheKey(
        geoName,
        obj.version,
        scene.geometryMap.get(geoName)?.version,
        textures.map,
        textures.roughnessMap,
        textures.metalnessMap,
        textures.normalMap,
        textures.emissiveMap,
      );
    },
    buildGeometryMaterial: (obj: BlenderObject, textures) => {
      const geoName: string = (obj as any).geometry ?? obj.name;
      const geoBuf = scene.geometryMap.get(geoName);
      if (!geoBuf) return null;

      // Same builder as SyncViewer — a MeshPhysicalNodeMaterial carrying
      // emissive, the Blender TSL shader graph and the physical properties,
      // so both viewers shade identically under the shared HDRI.
      return buildGeometryFromBuffer({
        buf: geoBuf,
        color: obj.color,
        roughness: obj.roughness ?? 0.5,
        metalness: obj.metalness ?? 0.0,
        emissiveColor: obj.emissiveColor ?? [0, 0, 0],
        emissiveIntensity: obj.emissiveIntensity ?? 0.0,
        map: textures.map,
        roughnessMap: textures.roughnessMap,
        metalnessMap: textures.metalnessMap,
        normalMap: textures.normalMap,
        emissiveMap: textures.emissiveMap,
        transparent: obj.transparent,
        opacity: obj.opacity,
        alphaTest: obj.alphaTest,
        flatShading: obj.flatShading,
        doubleSided: obj.doubleSided,
        graph: obj.graph,
      });
    },
  });

  // Sync empty objects (named transform nodes — no geometry)
  useEmptySync({
    scene: threeScene,
    objects: scene.objects,
  });

  return (
    <>
      {/* Lights from Blender */}
      {scene.lights.map((light) => (
        <LightFromData key={light.name} light={light} />
      ))}

      {/* Fallback lighting if no scene lights */}
      {scene.lights.length === 0 && (
        <>
          <ambientLight intensity={0.4} />
          <directionalLight
            position={[5, 10, 5]}
            intensity={1.5}
            castShadow
            shadow-mapSize-width={1024}
            shadow-mapSize-height={1024}
          />
        </>
      )}

      {/* <ContactShadows
        position={[0, -0.01, 0]}
        scale={20}
        blur={2}
        far={4}
        opacity={0.4}
      /> */}

      {/* <OrbitControls makeDefault /> */}
      {/* <gridHelper args={[20, 20, "#333", "#222"]} /> */}
    </>
  );
}

// ---------------------------------------------------------------------------
// Loading / Error / Empty states
// ---------------------------------------------------------------------------

function LoadingView() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-surface-primary text-text-muted text-xs font-mono">
      <div className="flex flex-col items-center gap-2">
        <svg
          className="animate-spin h-6 w-6 text-accent"
          viewBox="0 0 24 24"
          fill="none"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
        <span>Loading production scene…</span>
      </div>
    </div>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-surface-primary text-status-red text-xs font-mono">
      <div className="flex flex-col items-center gap-2 max-w-[320px] text-center">
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="15" y1="9" x2="9" y2="15" />
          <line x1="9" y1="9" x2="15" y2="15" />
        </svg>
        <span>Failed to load scene</span>
        <span className="text-text-muted/60 text-[10px]">{message}</span>
      </div>
    </div>
  );
}

function EmptyView() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-surface-primary text-text-muted text-xs font-mono">
      <span>No scene data in zip.</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProductionViewer({
  zipBuffer,
  children,
}: {
  zipBuffer: ArrayBuffer;
  children?: ReactNode;
}) {
  const [state, setState] = useState<{
    status: "loading" | "loaded" | "error" | "empty";
    scene?: ProductionScene;
    error?: string;
  }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setState({ status: "loading" });
      try {
        const scene = await loadProductionScene(zipBuffer);
        if (cancelled) return;
        if (scene.objects.length === 0 && !scene.hdrBytes) {
          setState({ status: "empty" });
        } else {
          setState({ status: "loaded", scene });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [zipBuffer]);

  if (state.status === "loading") return <LoadingView />;
  if (state.status === "error") return <ErrorView message={state.error!} />;
  if (state.status === "empty") return <EmptyView />;

  return (
    <div className="h-full w-full relative">
      <CanvasGPU>
        <Suspense fallback={null}>
          <SceneContent scene={state.scene!} />
          {children}
        </Suspense>
      </CanvasGPU>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ProductionScene({
  zipBuffer,
  onStatus = () => null,
  noSuspense = false,
}: {
  zipBuffer: ArrayBuffer;
  onStatus?: any;
  noSuspense?: boolean;
}) {
  const [state, setState] = useState<{
    status: "loading" | "loaded" | "error" | "empty";
    scene?: ProductionScene;
    error?: string;
  }>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    if (!zipBuffer) {
      return;
    }

    async function load() {
      setState({ status: "loading" });
      try {
        const scene = await loadProductionScene(zipBuffer);
        if (cancelled) return;
        if (scene.objects.length === 0 && !scene.hdrBytes) {
          setState({ status: "empty" });
        } else {
          setState({ status: "loaded", scene });
        }
      } catch (err) {
        if (cancelled) return;
        setState({
          status: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [zipBuffer]);

  useEffect(() => {
    onStatus(state);
  }, [state]);

  if (state.status === "loading") return null;
  if (state.status === "error") return null;
  if (state.status === "empty") return null;

  if (noSuspense) {
    return <SceneContent scene={state.scene!} />;
  }

  return (
    <Suspense fallback={null}>
      <SceneContent scene={state.scene!} />
    </Suspense>
  );
}
