// ---------------------------------------------------------------------------
// OPFS File System Core — raw read/write operations
// ---------------------------------------------------------------------------
// Provides a thin, typed wrapper around the Origin Private File System API.
// All methods operate on the root OPFS handle and use the directory layout
// defined in ./types.ts.
//
// Usage:
//   import { opfs } from "../utils/opfs";
//   await opfs.writeScene(sceneData);
//   await opfs.writeHDR(hdrPixels, width, height, intensity);
//   const scene = await opfs.readScene();
// ---------------------------------------------------------------------------

import type {
  HdrConfig,
  TextureEntry,
  GeometryEntry,
  GeometryConfig,
  OpfsCapabilities,
  OpfsTreeNode,
  OpfsTree,
} from "./types";
import type { SceneData, ImageData, TextureData, GeoBuffer, CameraData, LightData } from "../../types/blenderTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Walk a path like "current-rawdata-view/hdr" into nested directories, creating as needed. */
async function ensureDir(root: FileSystemDirectoryHandle, path: string): Promise<FileSystemDirectoryHandle> {
  const parts = path.split("/").filter(Boolean);
  let handle = root;
  for (const part of parts) {
    handle = await handle.getDirectoryHandle(part, { create: true });
  }
  return handle;
}

/** Write a string as UTF-8 JSON file. */
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

/** Read a JSON file and parse it. Returns null if the file doesn't exist. */
async function readJSON<T>(dir: FileSystemDirectoryHandle, name: string): Promise<T | null> {
  try {
    const file = await dir.getFileHandle(name);
    const f = await file.getFile();
    const text = await f.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Write raw bytes to a file. */
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

/** Read raw bytes from a file. Returns null if the file doesn't exist. */
async function readBinary(dir: FileSystemDirectoryHandle, name: string): Promise<ArrayBuffer | null> {
  try {
    const file = await dir.getFileHandle(name);
    const f = await file.getFile();
    return await f.arrayBuffer();
  } catch {
    return null;
  }
}

/** Check if a directory exists. */
async function dirExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getDirectoryHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Remove a file if it exists. */
async function removeFile(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch {
    // Ignore — file didn't exist
  }
}

/** Remove a directory recursively if it exists. */
async function removeDir(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch {
    // Ignore — dir didn't exist
  }
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/** Detect browser support for OPFS and AVIF encoding/decoding. */
export async function detectCapabilities(): Promise<OpfsCapabilities> {
  const opfs = "storage" in navigator && "getDirectory" in navigator.storage;

  let avifEncode = false;
  if (typeof OffscreenCanvas !== "undefined" || typeof HTMLCanvasElement !== "undefined") {
    try {
      const c = new OffscreenCanvas(1, 1);
      const ctx = c.getContext("2d");
      if (ctx) {
        const blob = await c.convertToBlob({ type: "image/avif", quality: 0.8 });
        avifEncode = blob.type === "image/avif";
      }
    } catch {
      avifEncode = false;
    }
  }

  let avifDecode = false;
  try {
    // Create a minimal AVIF (1px black) to test decode
    if (avifEncode) {
      const c = new OffscreenCanvas(1, 1);
      const blob = await c.convertToBlob({ type: "image/avif" });
      const bmp = await createImageBitmap(blob);
      avifDecode = bmp.width === 1;
      bmp.close();
    }
  } catch {
    avifDecode = false;
  }

  return { opfs, avifEncode, avifDecode };
}

// ---------------------------------------------------------------------------
// OpfsFS — raw storage class
// ---------------------------------------------------------------------------

export class OpfsFS {
  private root: FileSystemDirectoryHandle | null = null;

  /** Lazy-init the OPFS root handle. Must be called before any read/write. */
  async init(): Promise<FileSystemDirectoryHandle> {
    if (!this.root) {
      this.root = await navigator.storage.getDirectory();
    }
    return this.root;
  }

  /** Check if OPFS is available and the root handle is initialised. */
  get ready(): boolean {
    return this.root !== null;
  }

  // ------------------------------------------------------------------
  // Scene
  // ------------------------------------------------------------------

  async writeScene(data: SceneData): Promise<void> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view");
    await writeJSON(dir, "scene.json", data);
  }

  async readScene(): Promise<SceneData | null> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view");
    return readJSON<SceneData>(dir, "scene.json");
  }

  // ------------------------------------------------------------------
  // HDR
  // ------------------------------------------------------------------

  async writeHDR(pixels: ArrayBuffer, width: number, height: number, intensity: number): Promise<void> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view/hdr");
    await writeBinary(dir, "data.bin", pixels);
    await writeJSON(dir, "config.json", { width, height, intensity } satisfies HdrConfig);
  }

  async readHDRBinary(): Promise<ArrayBuffer | null> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view/hdr");
    return readBinary(dir, "data.bin");
  }

  async readHDRConfig(): Promise<HdrConfig | null> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view/hdr");
    return readJSON<HdrConfig>(dir, "config.json");
  }

  async readHDR(): Promise<(ImageData & { intensity: number }) | null> {
    const pixels = await this.readHDRBinary();
    const config = await this.readHDRConfig();
    if (!pixels || !config) return null;
    return { width: config.width, height: config.height, pixels, intensity: config.intensity };
  }

  // ------------------------------------------------------------------
  // Textures
  // ------------------------------------------------------------------

  async writeTexture(name: string, data: TextureData): Promise<void> {
    const root = await this.init();
    const texDir = await ensureDir(root, "current-rawdata-view/textures");

    // Extract extension from mime type
    const ext = mimeToExt(data.mime);

    // Write raw bytes
    await writeBinary(texDir, `${name}.${ext}`, data.bytes);

    // Update manifest
    const manifest = (await readJSON<TextureEntry[]>(texDir, "manifest.json")) ?? [];
    const existing = manifest.findIndex((e) => e.name === name);
    const entry: TextureEntry = { name, mime: data.mime };
    if (existing >= 0) {
      manifest[existing] = entry;
    } else {
      manifest.push(entry);
    }
    await writeJSON(texDir, "manifest.json", manifest);
  }

  async readTexture(name: string): Promise<TextureData | null> {
    const root = await this.init();
    const texDir = await ensureDir(root, "current-rawdata-view/textures");
    const manifest = await readJSON<TextureEntry[]>(texDir, "manifest.json");
    const entry = manifest?.find((e) => e.name === name);
    if (!entry) return null;

    const ext = mimeToExt(entry.mime);
    const bytes = await readBinary(texDir, `${name}.${ext}`);
    if (!bytes) return null;
    return { mime: entry.mime, bytes };
  }

  async readAllTextures(): Promise<Map<string, TextureData>> {
    const result = new Map<string, TextureData>();
    const root = await this.init();
    const texDir = await ensureDir(root, "current-rawdata-view/textures");
    const manifest = await readJSON<TextureEntry[]>(texDir, "manifest.json");
    if (!manifest) return result;

    for (const entry of manifest) {
      const ext = mimeToExt(entry.mime);
      const bytes = await readBinary(texDir, `${entry.name}.${ext}`);
      if (bytes) {
        result.set(entry.name, { mime: entry.mime, bytes });
      }
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Geometry
  // ------------------------------------------------------------------

  async writeGeometry(name: string, geo: GeoBuffer): Promise<void> {
    const root = await this.init();
    const geoDir = await ensureDir(root, `current-rawdata-view/geometry/${sanitiseName(name)}`);

    await writeBinary(geoDir, "vertices.bin", geo.vertices.buffer.slice(
      geo.vertices.byteOffset,
      geo.vertices.byteOffset + geo.vertices.byteLength,
    ) as ArrayBuffer);
    await writeBinary(geoDir, "indices.bin", geo.indices.buffer.slice(
      geo.indices.byteOffset,
      geo.indices.byteOffset + geo.indices.byteLength,
    ) as ArrayBuffer);

    if (geo.uvs) {
      await writeBinary(geoDir, "uvs.bin", geo.uvs.buffer.slice(
        geo.uvs.byteOffset,
        geo.uvs.byteOffset + geo.uvs.byteLength,
      ) as ArrayBuffer);
    } else {
      await removeFile(geoDir, "uvs.bin");
    }

    const config: GeometryConfig = {
      version: geo.version,
      vCount: geo.vertices.length / 3,
      iCount: geo.indices.length,
      hasUVs: !!geo.uvs,
    };
    await writeJSON(geoDir, "config.json", config);

    // Update manifest
    const manifestDir = await ensureDir(root, "current-rawdata-view/geometry");
    const manifest = (await readJSON<GeometryEntry[]>(manifestDir, "manifest.json")) ?? [];
    if (!manifest.find((e) => e.name === name)) {
      manifest.push({ name });
    }
    await writeJSON(manifestDir, "manifest.json", manifest);
  }

  async readGeometry(name: string): Promise<GeoBuffer | null> {
    const root = await this.init();
    const geoDir = await ensureDir(root, `current-rawdata-view/geometry/${sanitiseName(name)}`);

    const config = await readJSON<GeometryConfig>(geoDir, "config.json");
    const vertsRaw = await readBinary(geoDir, "vertices.bin");
    const idxsRaw = await readBinary(geoDir, "indices.bin");

    if (!config || !vertsRaw || !idxsRaw) return null;

    const vertices = new Float32Array(vertsRaw);
    const indices = new Uint32Array(idxsRaw);

    let uvs: Float64Array | undefined;
    if (config.hasUVs) {
      const uvsRaw = await readBinary(geoDir, "uvs.bin");
      // UVs are persisted at full float64 precision (matches the Blender wire format)
      if (uvsRaw) uvs = new Float64Array(uvsRaw);
    }

    return { version: config.version, vertices, indices, uvs };
  }

  async readAllGeometry(): Promise<Map<string, GeoBuffer>> {
    const result = new Map<string, GeoBuffer>();
    const root = await this.init();
    const manifestDir = await ensureDir(root, "current-rawdata-view/geometry");
    const manifest = await readJSON<GeometryEntry[]>(manifestDir, "manifest.json");
    if (!manifest) return result;

    for (const entry of manifest) {
      const geo = await this.readGeometry(entry.name);
      if (geo) result.set(entry.name, geo);
    }
    return result;
  }

  // ------------------------------------------------------------------
  // Cameras
  // ------------------------------------------------------------------

  async writeCameras(cameras: CameraData[]): Promise<void> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view");
    await writeJSON(dir, "cameras.json", cameras);
  }

  async readCameras(): Promise<CameraData[]> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view");
    return (await readJSON<CameraData[]>(dir, "cameras.json")) ?? [];
  }

  // ------------------------------------------------------------------
  // Lights
  // ------------------------------------------------------------------

  async writeLights(lights: LightData[]): Promise<void> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view");
    await writeJSON(dir, "lights.json", lights);
  }

  async readLights(): Promise<LightData[]> {
    const root = await this.init();
    const dir = await ensureDir(root, "current-rawdata-view");
    return (await readJSON<LightData[]>(dir, "lights.json")) ?? [];
  }

  // ------------------------------------------------------------------
  // Pruning
  // ------------------------------------------------------------------

  /**
   * Delete raw-view binaries the given scene no longer references, and drop
   * their manifest entries.
   *
   * Writes are additive — `writeTexture` / `writeGeometry` only ever create
   * or overwrite — and the Blender store's texture/geometry maps are
   * append-only for the life of a WebSocket session. Without this, every
   * object or material deleted or renamed in Blender leaves its binaries in
   * OPFS forever.
   *
   * Returns the file and directory names that were removed.
   */
  async pruneUnused(
    scene: SceneData,
  ): Promise<{ textures: string[]; geometry: string[] }> {
    const root = await this.init();
    const removed = { textures: [] as string[], geometry: [] as string[] };

    // ---- Textures ----
    const keepTextures = referencedTextures(scene);
    const texDir = await ensureDir(root, "current-rawdata-view/textures");

    const texManifest =
      (await readJSON<TextureEntry[]>(texDir, "manifest.json")) ?? [];
    const keptTexEntries = texManifest.filter((e) => keepTextures.has(e.name));

    // Every file the kept manifest expects on disk. Anything else is an
    // orphan — a texture that left the scene, or a stale extension left
    // behind when a texture's format changed (foo.png → foo.webp).
    const expectedTexFiles = new Set(
      keptTexEntries.map((e) => `${e.name}.${mimeToExt(e.mime)}`),
    );
    expectedTexFiles.add("manifest.json");

    for (const fileName of await listChildren(texDir, "file")) {
      if (expectedTexFiles.has(fileName)) continue;
      await removeFile(texDir, fileName);
      removed.textures.push(fileName);
    }

    if (keptTexEntries.length !== texManifest.length) {
      await writeJSON(texDir, "manifest.json", keptTexEntries);
    }

    // ---- Geometry ----
    const keepGeometry = referencedGeometry(scene);
    const geoRoot = await ensureDir(root, "current-rawdata-view/geometry");

    const geoManifest =
      (await readJSON<GeometryEntry[]>(geoRoot, "manifest.json")) ?? [];
    const keptGeoEntries = geoManifest.filter((e) => keepGeometry.has(e.name));

    // Derive the keep set from the scene rather than the manifest, so a
    // manifest that has drifted out of sync can't delete live geometry.
    // Directory names are sanitised on write, so compare in that space.
    const expectedGeoDirs = new Set([...keepGeometry].map(sanitiseName));

    for (const dirName of await listChildren(geoRoot, "directory")) {
      if (expectedGeoDirs.has(dirName)) continue;
      await removeDir(geoRoot, dirName);
      removed.geometry.push(dirName);
    }

    if (keptGeoEntries.length !== geoManifest.length) {
      await writeJSON(geoRoot, "manifest.json", keptGeoEntries);
    }

    return removed;
  }

  // ------------------------------------------------------------------
  // Snapshot — write everything from the blender store at once
  // ------------------------------------------------------------------

  async writeSnapshot(params: {
    scene: SceneData;
    hdrPixels?: ArrayBuffer | null;
    hdrWidth?: number;
    hdrHeight?: number;
    hdrIntensity?: number;
    textures?: Map<string, TextureData>;
    geoBuffers?: Map<string, GeoBuffer>;
    cameras?: CameraData[];
    lights?: LightData[];
  }): Promise<void> {
    const {
      scene,
      hdrPixels,
      hdrWidth = 0,
      hdrHeight = 0,
      hdrIntensity = 1.0,
      textures,
      geoBuffers,
      cameras,
      lights,
    } = params;

    await this.writeScene(scene);

    // NOTE: a stale hdr/ is deliberately left alone. The store can't tell
    // "Blender has no world HDR" apart from "the HDR message hasn't arrived
    // yet" — both are `hdrData: null` — so removing it here could silently
    // drop a good HDRI on an early snapshot. It's a single file, unlike the
    // per-object textures and geometry below.
    if (hdrPixels && hdrWidth > 0 && hdrHeight > 0) {
      await this.writeHDR(hdrPixels, hdrWidth, hdrHeight, hdrIntensity);
    }

    // The store's maps are append-only across a session, so they can hold
    // entries for objects that have since left the scene. Skip those rather
    // than writing bytes only to prune them a moment later.
    const keepTextures = referencedTextures(scene);
    const keepGeometry = referencedGeometry(scene);

    if (textures) {
      for (const [name, data] of textures) {
        if (!keepTextures.has(name)) continue;
        await this.writeTexture(name, data);
      }
    }

    if (geoBuffers) {
      for (const [name, buf] of geoBuffers) {
        if (!keepGeometry.has(name)) continue;
        await this.writeGeometry(name, buf);
      }
    }

    if (cameras) await this.writeCameras(cameras);
    if (lights) await this.writeLights(lights);

    // Sweep anything left over from earlier snapshots.
    await this.pruneUnused(scene);
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /** Remove the entire ./current-rawdata-view subtree. */
  async clearCurrentView(): Promise<void> {
    const root = await this.init();
    await removeDir(root, "current-rawdata-view");
  }

  /** Remove the entire ./current-optimised-view subtree. */
  async clearOptimisedView(): Promise<void> {
    const root = await this.init();
    await removeDir(root, "current-optimised-view");
  }

  // ------------------------------------------------------------------
  // Deployment (zipped bundle)
  // ------------------------------------------------------------------

  /** Read the packaged deployment zip as an ArrayBuffer. Returns null if not found. */
  async readDeployment(): Promise<ArrayBuffer | null> {
    const root = await this.init();
    try {
      const deployDir = await root.getDirectoryHandle("current-deployment");
      return await readBinary(deployDir, "scene.zip");
    } catch {
      return null;
    }
  }

  /** Remove the ./current-deployment subtree. */
  async clearDeployment(): Promise<void> {
    const root = await this.init();
    await removeDir(root, "current-deployment");
  }

  /** Remove both current-rawdata-view and current-optimised-view. */
  async clearAll(): Promise<void> {
    await this.clearCurrentView();
    await this.clearOptimisedView();
  }

  // ------------------------------------------------------------------
  // Tree enumeration — for the OPFS browser UI
  // ------------------------------------------------------------------

  /**
   * Walk the OPFS directory tree and return a structured listing.
   * Includes total byte counts for raw and optimised views.
   */
  async listTree(): Promise<OpfsTree> {
    const root = await this.init();
    const tree: OpfsTreeNode = {
      name: "OPFS",
      kind: "dir",
      size: 0,
      children: [],
    };

    let rawTotal = 0;
    let optimisedTotal = 0;
    let deploymentTotal = 0;

    // Walk current-rawdata-view
    if (await dirExists(root, "current-rawdata-view")) {
      const cvDir = await root.getDirectoryHandle("current-rawdata-view");
      const cvNode = await walkDir(cvDir, "current-rawdata-view");
      rawTotal = cvNode.size;
      tree.children!.push(cvNode);
    }

    // Walk current-optimised-view
    if (await dirExists(root, "current-optimised-view")) {
      const ovDir = await root.getDirectoryHandle("current-optimised-view");
      const ovNode = await walkDir(ovDir, "current-optimised-view");
      optimisedTotal = ovNode.size;
      tree.children!.push(ovNode);
    }

    // Walk current-deployment
    if (await dirExists(root, "current-deployment")) {
      const depDir = await root.getDirectoryHandle("current-deployment");
      const depNode = await walkDir(depDir, "current-deployment");
      deploymentTotal = depNode.size;
      tree.children!.push(depNode);
    }

    return { root: tree, rawTotal, optimisedTotal, deploymentTotal };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/bmp": "bmp",
    "image/tiff": "tiff",
  };
  return map[mime] ?? "bin";
}

/** Replace characters that are invalid in file names. */
function sanitiseName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, "_");
}

/** Texture names referenced by any object in the scene. */
function referencedTextures(scene: SceneData): Set<string> {
  const names = new Set<string>();
  for (const obj of scene.objects) {
    for (const ref of [
      obj.texture,
      obj.roughnessMap,
      obj.metalnessMap,
      obj.normalMap,
      obj.emissiveMap,
    ]) {
      if (ref) names.add(ref);
    }
  }
  return names;
}

/** Geometry keys referenced by the scene. Raw-view geometry is keyed by
 *  object name — the optimiser is what later dedupes and rewrites these to
 *  canonical geometry names in the optimised view. */
function referencedGeometry(scene: SceneData): Set<string> {
  return new Set(scene.objects.map((o) => o.name));
}

/** List the immediate child names of a directory, by kind. Collected up front
 *  so callers can delete entries without mutating a live async iterator. */
async function listChildren(
  dir: FileSystemDirectoryHandle,
  kind: "file" | "directory",
): Promise<string[]> {
  const names: string[] = [];
  for await (const [name, handle] of (dir as any).entries()) {
    if (handle.kind === kind) names.push(name);
  }
  return names;
}

/** Recursively walk an OPFS directory, building a tree node with sizes. */
async function walkDir(
  handle: FileSystemDirectoryHandle,
  name: string,
): Promise<OpfsTreeNode> {
  const node: OpfsTreeNode = {
    name,
    kind: "dir",
    size: 0,
    children: [],
  };

  for await (const [childName, childHandle] of (handle as any).entries()) {
    if (childHandle.kind === "file") {
      const file = await (childHandle as FileSystemFileHandle).getFile();
      node.size += file.size;
      node.children!.push({
        name: childName,
        kind: "file",
        size: file.size,
      });
    } else {
      const childNode = await walkDir(
        childHandle as FileSystemDirectoryHandle,
        childName,
      );
      node.size += childNode.size;
      node.children!.push(childNode);
    }
  }

  // Sort: directories first, then files, each alphabetically
  node.children!.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return node;
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const opfs = new OpfsFS();
