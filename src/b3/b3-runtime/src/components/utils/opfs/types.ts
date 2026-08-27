// ---------------------------------------------------------------------------
// OPFS File System SDK — Types
// ---------------------------------------------------------------------------
// Mirrors the data shapes from blenderTypes.ts. All binary data is stored as
// raw ArrayBuffer; config/metadata is stored as JSON.
//
// Directory layout in OPFS:
//
//   current-rawdata-view/
//     scene.json                 — SceneData (full objects array)
//     hdr/
//       data.bin                 — Float32 RGBA pixel buffer
//       config.json              — { width, height, intensity }
//     textures/
//       <name>.<ext>             — Raw texture bytes (original format)
//       manifest.json            — Array of { name, mime }
//     geometry/
//       <name>/
//         vertices.bin           — Float32Array raw bytes
//         indices.bin            — Uint32Array raw bytes
//         uvs.bin                — Float64Array raw bytes (optional, full precision)
//         config.json            — { version, vCount, iCount, hasUVs }
//       manifest.json            — Array of { name }
//     cameras.json               — CameraData[]
//     lights.json                — LightData[]
//
//   current-optimised-view/
//     scene.json
//     hdr/
//       data.avif                — Tonemapped AVIF preview
//       config.json
//     textures/
//       <name>.avif              — AVIF-compressed texture
//       manifest.json
//     geometry/
//       <name>/
//         draco.bin              — Draco-compressed geometry blob
//         config.json            — { version, vCount, iCount, hasUVs }
//       manifest.json
//     cameras.json
//     lights.json
// ---------------------------------------------------------------------------

/** Metadata stored alongside raw HDR binary. */
export interface HdrConfig {
  width: number;
  height: number;
  intensity: number;
}

/** Metadata for a single texture entry in the manifest. */
export interface TextureEntry {
  name: string;
  mime: string;
}

/** Metadata for a single geometry entry in the manifest. */
export interface GeometryEntry {
  name: string;
}

/** Extends GeoBuffer metadata for storage. */
export interface GeometryConfig {
  version: string;
  vCount: number;
  iCount: number;
  hasUVs: boolean;
}

/** Capability flags for the current browser's OPFS + codec support. */
export interface OpfsCapabilities {
  opfs: boolean;
  /** Canvas toBlob('image/avif') support. */
  avifEncode: boolean;
  /** createImageBitmap AVIF decode support. */
  avifDecode: boolean;
}

// ---------------------------------------------------------------------------
// Tree enumeration types — used by the OPFS browser UI
// ---------------------------------------------------------------------------

/** A single node in the OPFS directory tree. */
export interface OpfsTreeNode {
  name: string;
  kind: "file" | "dir";
  /** Size in bytes (0 for directories — use `size` on children via `totalSize`). */
  size: number;
  children?: OpfsTreeNode[];
}

/** Top-level summary returned by listTree(). */
export interface OpfsTree {
  root: OpfsTreeNode;
  /** Total bytes under current-rawdata-view (recursive). */
  rawTotal: number;
  /** Total bytes under current-optimised-view (recursive). */
  optimisedTotal: number;
  /** Total bytes under current-deployment (recursive). */
  deploymentTotal: number;
}
