// ---------------------------------------------------------------------------
// OPFS File System SDK — public API
// ---------------------------------------------------------------------------
// Usage:
//   import { opfs, opfsOptimiser, detectCapabilities } from "../utils/opfs";
//
//   // Store raw data from the Blender receiver
//   await opfs.writeSnapshot({
//     scene: useBlenderStore.getState().sceneData,
//     hdrPixels: useBlenderStore.getState().hdrData?.pixels,
//     hdrWidth: useBlenderStore.getState().hdrData?.width,
//     hdrHeight: useBlenderStore.getState().hdrData?.height,
//     hdrIntensity: useBlenderStore.getState().hdrIntensity,
//     textures: useBlenderStore.getState().texData,
//     geoBuffers: useBlenderStore.getState().geoBuffers,
//     cameras: useBlenderStore.getState().cameras,
//     lights: useBlenderStore.getState().lights,
//   });
//
//   // Run optimisation
//   await opfsOptimiser.optimise((p) => console.log(p.stage, p.current, "/", p.total));
//
//   // Read back later
//   const scene = await opfs.readScene();
//   const textures = await opfs.readAllTextures();
//   const geometry = await opfs.readAllGeometry();
// ---------------------------------------------------------------------------

export { opfs, OpfsFS, detectCapabilities } from "./core";
export { opfsOptimiser, OpfsOptimiser } from "./optimizer";
export type { OptimiserProgress, OptimiserCallback } from "./optimizer";
export type {
  HdrConfig,
  TextureEntry,
  GeometryEntry,
  GeometryConfig,
  OpfsCapabilities,
  OpfsTreeNode,
  OpfsTree,
} from "./types";
