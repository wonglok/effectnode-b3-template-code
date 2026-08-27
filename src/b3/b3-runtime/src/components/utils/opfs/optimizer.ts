// ---------------------------------------------------------------------------
// OPFS Optimizer — compress raw buffers/textures to AVIF + Draco
// ---------------------------------------------------------------------------
// Reads from ./current-rawdata-view/* and writes optimised assets to
// ./current-optimised-view/*.
//
// Optimisation pipeline:
//   1. Textures    → AVIF re-encode (WebP fallback, via OffscreenCanvas)
//   2. HDR         → Raw copy (no compression — preserves float precision)
//   3. Geometry    → Deduplicate + Draco-compress (via draco3d WASM)
//   4. Scene JSON  → Copy-through with instance groups + updated references
// ---------------------------------------------------------------------------

import draco3d from "draco3d";
import JSZip from "jszip";

import type {
  TextureEntry,
  GeometryEntry,
  GeometryConfig,
  OpfsCapabilities,
} from "./types";
import { opfs } from "./core";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureDir(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<FileSystemDirectoryHandle> {
  const parts = path.split("/").filter(Boolean);
  let handle = root;
  for (const part of parts) {
    handle = await handle.getDirectoryHandle(part, { create: true });
  }
  return handle;
}

async function writeJSON(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: unknown,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(new TextEncoder().encode(JSON.stringify(data, null, 2)));
  await writable.close();
}

async function readJSON<T>(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<T | null> {
  try {
    const file = await dir.getFileHandle(name);
    const f = await file.getFile();
    return JSON.parse(await f.text()) as T;
  } catch {
    return null;
  }
}

async function writeBinary(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

// ---------------------------------------------------------------------------
// Texture encode — AVIF, with WebP fallback (via OffscreenCanvas)
// ---------------------------------------------------------------------------

interface TextureEncodeOptions {
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
}

const DEFAULT_TEXTURE_OPTIONS: TextureEncodeOptions = {
  quality: 0.5,
  maxWidth: 1024,
  maxHeight: 1024,
};

/** Cached capability check — can OffscreenCanvas encode AVIF? */
let avifEncodeSupported: boolean | null = null;

async function supportsAvifEncode(): Promise<boolean> {
  if (avifEncodeSupported !== null) return avifEncodeSupported;

  if (typeof OffscreenCanvas === "undefined") {
    avifEncodeSupported = false;
    return avifEncodeSupported;
  }

  try {
    const canvas = new OffscreenCanvas(2, 2);
    const blob = await canvas.convertToBlob({
      type: "image/avif",
      quality: 0.5,
    });
    avifEncodeSupported = blob.type === "image/avif";
  } catch {
    avifEncodeSupported = false;
  }
  return avifEncodeSupported;
}

async function encodeTexture(
  source: ImageBitmap | Blob,
  sourceMime: string,
  options: TextureEncodeOptions = {},
): Promise<{ blob: Blob; mime: string }> {
  const {
    quality = 0.5,
    maxWidth = 4096,
    maxHeight = 4096,
  } = {
    ...DEFAULT_TEXTURE_OPTIONS,
    ...options,
  };

  let bitmap: ImageBitmap;
  if (source instanceof Blob) {
    bitmap = await createImageBitmap(source);
  } else {
    bitmap = source;
  }

  const { width, height } = computeScaledSize(
    bitmap.width,
    bitmap.height,
    maxWidth,
    maxHeight,
  );

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  if (await supportsAvifEncode()) {
    // Lossy AVIF preserves the alpha channel — no separate lossless path needed.
    const blob = await canvas.convertToBlob({ type: "image/avif", quality });
    return { blob, mime: "image/avif" };
  }

  // WebP fallback — lossy WebP (VP8) discards alpha, so use lossless for
  // sources that may carry transparency.
  const hasAlpha = sourceMime === "image/png" || sourceMime === "image/webp";
  const blob = await canvas.convertToBlob(
    hasAlpha
      ? { type: "image/webp" } // lossless (preserves alpha)
      : { type: "image/webp", quality }, // lossy (JPEG source, no alpha)
  );
  return { blob, mime: "image/webp" };
}

function computeScaledSize(
  w: number,
  h: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (w <= maxW && h <= maxH) return { width: w, height: h };
  const scale = Math.min(maxW / w, maxH / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

// ---------------------------------------------------------------------------
// Geometry fingerprinting — for deduplication / instancing
// ---------------------------------------------------------------------------

/**
 * Generate a lightweight fingerprint for a geometry buffer.
 * Uses vertex/index counts, bounding box, and sampled values so identical
 * meshes produce the same hash without hashing every byte.
 */
function hashGeometry(
  vertices: Float32Array,
  indices: Uint32Array,
  uvs?: Float64Array,
): string {
  // Bounding box
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < vertices.length; i += 3) {
    if (vertices[i] < minX) minX = vertices[i];
    if (vertices[i + 1] < minY) minY = vertices[i + 1];
    if (vertices[i + 2] < minZ) minZ = vertices[i + 2];
    if (vertices[i] > maxX) maxX = vertices[i];
    if (vertices[i + 1] > maxY) maxY = vertices[i + 1];
    if (vertices[i + 2] > maxZ) maxZ = vertices[i + 2];
  }

  // Sample first few vertices + indices for collision resistance
  const vSample: number[] = [];
  for (let i = 0; i < Math.min(24, vertices.length); i++) {
    vSample.push(vertices[i]);
  }
  const iSample: number[] = [];
  for (let i = 0; i < Math.min(24, indices.length); i++) {
    iSample.push(indices[i]);
  }

  const tokens = [
    vertices.length,
    indices.length,
    uvs ? uvs.length : 0,
    minX.toFixed(4),
    minY.toFixed(4),
    minZ.toFixed(4),
    maxX.toFixed(4),
    maxY.toFixed(4),
    maxZ.toFixed(4),
    ...vSample.map((v) => v.toFixed(4)),
    ...iSample,
  ];

  return tokens.join("|");
}

// ---------------------------------------------------------------------------
// Draco geometry compression — via draco3d WASM
// ---------------------------------------------------------------------------

const DRACO_WASM_URL = "/draco/";

async function compressGeometryDraco(
  vertices: Float32Array,
  indices: Uint32Array,
  uvs?: Float64Array,
): Promise<ArrayBuffer> {
  // Create the draco encoder WASM module
  const mod = await (draco3d as any).createEncoderModule({
    locateFile: (path: string) => DRACO_WASM_URL + path,
  });

  const encoder = new mod.Encoder();
  const meshBuilder = new mod.MeshBuilder();
  const mesh = new mod.Mesh();

  // POSITION
  const numVertices = vertices.length / 3;
  meshBuilder.AddFloatAttributeToMesh(
    mesh,
    mod.POSITION,
    numVertices,
    3,
    vertices,
  );

  // TEX_COORD — Draco only accepts Float32Array (its internal precision is
  // float32 anyway), so downcast the full-precision float64 UVs here.
  if (uvs) {
    meshBuilder.AddFloatAttributeToMesh(
      mesh,
      mod.TEX_COORD,
      uvs.length / 2,
      2,
      new Float32Array(uvs),
    );
  }

  // Faces (indices)
  const numFaces = indices.length / 3;
  meshBuilder.AddFacesToMesh(mesh, numFaces, new Uint32Array(indices));

  // Configure encoder — lossless, maximum compression (speed 0)
  encoder.SetSpeedOptions(0, 0);
  encoder.SetEncodingMethod(mod.MESH_EDGEBREAKER_ENCODING);

  // Encode
  const encodedData = new mod.DracoInt8Array();
  const encodedLen = encoder.EncodeMeshToDracoBuffer(mesh, encodedData);
  const output = new Uint8Array(encodedLen);
  for (let i = 0; i < encodedLen; i++) {
    output[i] = encodedData.GetValue(i) & 0xff;
  }

  // Cleanup
  mod.destroy(encodedData);
  mod.destroy(mesh);
  mod.destroy(encoder);
  mod.destroy(meshBuilder);

  // Return an exact-size buffer slice to avoid trailing slack bytes
  return output.buffer.slice(output.byteOffset, output.byteOffset + encodedLen);
}

// ---------------------------------------------------------------------------
// Optimiser — orchestrates the full pipeline
// ---------------------------------------------------------------------------

export interface OptimiserProgress {
  stage: string;
  current: number;
  total: number;
}

export type OptimiserCallback = (progress: OptimiserProgress) => void;

export class OpfsOptimiser {
  private caps: OpfsCapabilities | null = null;

  async init(): Promise<OpfsCapabilities> {
    if (!this.caps) {
      const { detectCapabilities } = await import("./core");
      this.caps = await detectCapabilities();
    }
    return this.caps;
  }

  /**
   * Run the full optimisation pipeline:
   *   1. Textures → AVIF
   *   2. HDR → KTX2 (UASTC, full HDR)
   *   3. Geometry → Draco
   *   4. Cameras, lights, scene JSON copy-through
   */
  async optimise(onProgress?: OptimiserCallback): Promise<void> {
    const root = await opfs["init"]();

    // -- Clear previous optimised output --
    await opfs.clearOptimisedView();
    const outRoot = await ensureDir(root, "current-optimised-view");

    // ---- Textures ----
    const texManifest = await (async () => {
      try {
        const d = await ensureDir(root, "current-rawdata-view/textures");
        return await readJSON<TextureEntry[]>(d, "manifest.json");
      } catch {
        return null;
      }
    })();

    const texEntries = texManifest ?? [];
    if (texEntries.length > 0) {
      onProgress?.({ stage: "textures", current: 0, total: texEntries.length });

      const texOutDir = await ensureDir(outRoot, "textures");
      const texOutManifest: TextureEntry[] = [];

      for (let i = 0; i < texEntries.length; i++) {
        const entry = texEntries[i];
        onProgress?.({
          stage: "textures",
          current: i,
          total: texEntries.length,
        });

        try {
          const texData = await opfs.readTexture(entry.name);
          if (!texData) continue;

          const blob = new Blob([texData.bytes], { type: texData.mime });
          const { blob: outBlob, mime } = await encodeTexture(
            blob,
            texData.mime,
            {
              quality: 0.5,
              maxHeight: 2048,
              maxWidth: 2048,
            },
          );
          const ext = mime.split("/")[1] ?? "avif";
          await writeBinary(
            texOutDir,
            `${entry.name}.${ext}`,
            await outBlob.arrayBuffer(),
          );
          texOutManifest.push({ name: entry.name, mime });
        } catch (err) {
          console.warn(
            `[OPFS Optimiser] Texture "${entry.name}" skipped:`,
            err,
          );
        }
      }

      await writeJSON(texOutDir, "manifest.json", texOutManifest);
      onProgress?.({
        stage: "textures",
        current: texEntries.length,
        total: texEntries.length,
      });
    }

    // ---- HDR ----
    const hdrPixels = await opfs.readHDRBinary();
    const hdrConfig = await opfs.readHDRConfig();

    if (hdrPixels && hdrConfig) {
      onProgress?.({ stage: "hdr", current: 0, total: 1 });

      try {
        const hdrOutDir = await ensureDir(outRoot, "hdr");
        // Copy raw Float32 HDR — no compression needed (preserves full precision)
        await writeBinary(hdrOutDir, "data.bin", hdrPixels);
        await writeJSON(hdrOutDir, "config.json", hdrConfig);
      } catch (err) {
        console.warn("[OPFS Optimiser] HDR skipped:", err);
      }

      onProgress?.({ stage: "hdr", current: 1, total: 1 });
    }

    // ---- Geometry (dedup + Draco) ----
    const geoManifest = await (async () => {
      try {
        const d = await ensureDir(root, "current-rawdata-view/geometry");
        return await readJSON<GeometryEntry[]>(d, "manifest.json");
      } catch {
        return null;
      }
    })();

    const geoEntries = geoManifest ?? [];

    // ----- Phase 1: deduplicate geometry via fingerprinting -----
    // hashGeo -> canonical name (first object with that geometry)
    const geoCanonical = new Map<string, string>();
    // object name -> canonical name
    const geoAlias = new Map<string, string>();
    // canonical name -> instance names[]
    const instanceGroups = new Map<string, string[]>();

    for (const entry of geoEntries) {
      const geo = await opfs.readGeometry(entry.name);
      if (!geo) continue;

      const hash = hashGeometry(geo.vertices, geo.indices, geo.uvs);

      if (geoCanonical.has(hash)) {
        const canon = geoCanonical.get(hash)!;
        geoAlias.set(entry.name, canon);
        instanceGroups.get(canon)!.push(entry.name);
      } else {
        geoCanonical.set(hash, entry.name);
        geoAlias.set(entry.name, entry.name);
        instanceGroups.set(entry.name, [entry.name]);
      }
    }

    const uniqueGeos = [...new Set(geoAlias.values())];
    const instanceGroupData: Record<
      string,
      { geometry: string; objects: string[] }
    > = {};

    for (const [canon, instances] of instanceGroups) {
      if (instances.length > 1) {
        instanceGroupData[canon] = { geometry: canon, objects: instances };
      }
    }

    // ----- Phase 2: compress only unique geometries -----
    if (uniqueGeos.length > 0) {
      onProgress?.({ stage: "geometry", current: 0, total: uniqueGeos.length });

      for (let i = 0; i < uniqueGeos.length; i++) {
        const name = uniqueGeos[i];
        onProgress?.({
          stage: "geometry",
          current: i,
          total: uniqueGeos.length,
        });

        try {
          const geo = await opfs.readGeometry(name);
          if (!geo) continue;

          const safeName = sanitiseName(name);
          const geoOutDir = await ensureDir(outRoot, `geometry/${safeName}`);

          try {
            const dracoBuf = await compressGeometryDraco(
              geo.vertices,
              geo.indices,
              geo.uvs,
            );
            await writeBinary(geoOutDir, "draco.bin", dracoBuf);
          } catch (err) {
            console.warn(
              `[OPFS Optimiser] Draco failed for "${name}", storing raw:`,
              err,
            );
            await writeBinary(
              geoOutDir,
              "vertices.bin",
              sliceBuffer(geo.vertices),
            );
            await writeBinary(
              geoOutDir,
              "indices.bin",
              sliceBuffer(geo.indices),
            );
            if (geo.uvs) {
              await writeBinary(geoOutDir, "uvs.bin", sliceBuffer(geo.uvs));
            }
          }

          const config: GeometryConfig = {
            version: geo.version,
            vCount: geo.vertices.length / 3,
            iCount: geo.indices.length,
            hasUVs: !!geo.uvs,
          };
          await writeJSON(geoOutDir, "config.json", config);
        } catch (err) {
          console.warn(`[OPFS Optimiser] Geometry "${name}" skipped:`, err);
        }
      }

      const geoOutManifestDir = await ensureDir(outRoot, "geometry");
      await writeJSON(
        geoOutManifestDir,
        "manifest.json",
        uniqueGeos.map((n) => ({ name: n })),
      );

      onProgress?.({
        stage: "geometry",
        current: uniqueGeos.length,
        total: uniqueGeos.length,
      });
    }

    // ----- Phase 3: update scene.json with alias + instance group info -----
    const rawScene = await opfs.readScene();
    if (rawScene) {
      // Rewrite object geometry references to canonical names
      const aliasedObjects = rawScene.objects.map((obj) => ({
        ...obj,
        geometry: geoAlias.get(obj.name) ?? obj.name,
      }));

      const scene = {
        ...rawScene,
        objects: aliasedObjects,
        instanceGroups:
          Object.keys(instanceGroupData).length > 0
            ? instanceGroupData
            : undefined,
      };
      await writeJSON(outRoot, "scene.json", scene);
    }

    // ---- Cameras, Lights (copy-through) ----
    onProgress?.({ stage: "meta", current: 0, total: 3 });

    const cameras = await opfs.readCameras();
    if (cameras.length > 0) {
      await writeJSON(outRoot, "cameras.json", cameras);
    }
    onProgress?.({ stage: "meta", current: 1, total: 3 });

    const lights = await opfs.readLights();
    if (lights.length > 0) {
      await writeJSON(outRoot, "lights.json", lights);
    }
    onProgress?.({ stage: "meta", current: 3, total: 3 });

    onProgress?.({ stage: "done", current: 1, total: 1 });
  }

  /**
   * Package everything in current-optimised-view into a single .zip and
   * save it to current-deployment/scene.zip.  Returns the zip ArrayBuffer
   * so callers can also pass it to ProductionViewer directly.
   */
  async packageDeployment(
    onProgress?: OptimiserCallback,
  ): Promise<ArrayBuffer> {
    onProgress?.({ stage: "package", current: 0, total: 1 });

    const root = await opfs["init"]();
    const zip = new JSZip();

    // Recursively add all files from an OPFS directory into a zip folder
    async function addDir(
      handle: FileSystemDirectoryHandle,
      zipFolder: JSZip,
    ): Promise<void> {
      for await (const [name, childHandle] of (handle as any).entries()) {
        if (childHandle.kind === "file") {
          const file = await (childHandle as FileSystemFileHandle).getFile();
          zipFolder.file(name, await file.arrayBuffer());
        } else {
          const sub = zipFolder.folder(name)!;
          await addDir(childHandle as FileSystemDirectoryHandle, sub);
        }
      }
    }

    // Walk current-optimised-view
    const ovExists = await (async () => {
      try {
        await root.getDirectoryHandle("current-optimised-view");
        return true;
      } catch {
        return false;
      }
    })();

    if (ovExists) {
      const ovDir = await root.getDirectoryHandle("current-optimised-view");
      await addDir(ovDir, zip);
    }

    // Write to current-deployment
    const deployDir = await ensureDir(root, "current-deployment");
    const zipBlob = await zip.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 9 },
    });
    const zipBuffer = await zipBlob.arrayBuffer();
    await writeBinary(deployDir, "scene.zip", zipBuffer);

    onProgress?.({ stage: "package", current: 1, total: 1 });

    return zipBuffer;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Safe slice of a TypedArray's underlying buffer. */
function sliceBuffer(arr: Float32Array | Float64Array | Uint32Array): ArrayBuffer {
  return arr.buffer.slice(
    arr.byteOffset,
    arr.byteOffset + arr.byteLength,
  ) as ArrayBuffer;
}

function sanitiseName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_");
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const opfsOptimiser = new OpfsOptimiser();
