"use client";

import { CameraSync } from "./components/blender/CameraSync";
import { CanvasGPU } from "./components/blender/CanvasGPU";
import { Sidebar } from "./components/blender/Sidebar";
import {
  BlenderConnection,
  RefreshButton,
  SyncViewer,
} from "./components/blender/viewers/SyncViewer";
import { OpfsBrowser } from "./components/blender/OpfsBrowser";
import {
  ProductionScene,
  ProductionViewer,
} from "./components/blender/viewers/ProductionViewer";
import { SSGIRender } from "./components/blender/canvas-units/SSGIRender";

import { useBlenderStore } from "./components/stores/blenderStore";
import { useBlenderSyncStore } from "./components/stores/blenderSyncStore";
import { useSettingsStore } from "./components/stores/settingsStore";
import {
  MAX_CAMERA_DISTANCE,
  MIN_CAMERA_DISTANCE,
  useNavRigStore,
} from "./components/stores/navRigStore";

export * from "./components/types/blenderTypes";

// stores
export {
  useSettingsStore,
  useBlenderSyncStore,
  useBlenderStore,
  useNavRigStore,
  MIN_CAMERA_DISTANCE,
  MAX_CAMERA_DISTANCE,
};

// components
export {
  Sidebar,
  BlenderConnection,
  CanvasGPU,
  SyncViewer,
  CameraSync,
  RefreshButton,
  OpfsBrowser,
  ProductionViewer,
  ProductionScene,
  SSGIRender,
};

// OPFS SDK
export {
  opfs,
  OpfsFS,
  opfsOptimiser,
  OpfsOptimiser,
  detectCapabilities,
} from "./components/utils/opfs";

// examples

// export function ProductionCanvas({ zipBuffer = null }) {
//   return (
//     <>
//       <div className="w-full h-full">
//         <CanvasGPU>
//           <CameraSync />
//           <SSGIRender
//             params={{
//               sliceCount: 2,
//               stepCount: 8,
//               giIntensity: 15,
//               radius: 50,
//               backfaceLighting: 1,
//             }}
//           />

//           {zipBuffer && (
//             <ProductionScene zipBuffer={zipBuffer}></ProductionScene>
//           )}
//         </CanvasGPU>
//       </div>
//     </>
//   );
// }

// export function ReceiverCanvas() {
//   return (
//     <div className="w-full h-full relative">
//       <div className="w-full h-full flex">
//         <Sidebar />
//         <BlenderConnection></BlenderConnection>
//         <CanvasGPU>
//           <SSGIRender
//             params={{
//               sliceCount: 2,
//               stepCount: 8,
//               giIntensity: 15,
//               radius: 50,
//               backfaceLighting: 1,
//             }}
//           />
//           <SyncViewer />
//           <CameraSync />
//         </CanvasGPU>
//       </div>
//     </div>
//   );
// }
