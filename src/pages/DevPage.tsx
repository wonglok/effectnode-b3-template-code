"use client";

import { useCallback } from "react";
import {
  OpfsBrowser,
  Sidebar,
  BlenderConnection,
  CanvasGPU,
  SyncViewer,
  CameraSync,
  useBlenderStore,
} from "../b3/b3-runtime/src";
import { BloomRender } from "../b3/b3-runtime/src/components/blender/canvas-units/BloomRender";
import { SiteMenu } from "../components/SiteMenu";
import { NavMeshDemoButton } from "../components/NavMeshDemoButton";
import { buildWalkableMeshesFromStore } from "../components/blenderWalkableMeshes";

/**
 * Dev — live Blender receiver.
 *
 * Connects to the Blender addon over WebSocket, renders the synced scene on a
 * WebGPU canvas, and offers snapshot → OPFS → optimiser controls in the sidebar.
 */
export function DevPage() {
  // Bumped by every snapshot — re-reads the OPFS tree so the space freed by
  // pruning is actually visible after pressing save.
  const deploymentVersion = useBlenderStore((s) => s.deploymentVersion);

  // Navmesh walkable collider = the live Blender-synced geometry. Stable
  // reference: the navmesh playground reads the store at generation time.
  const getWalkableMeshes = useCallback(buildWalkableMeshesFromStore, []);

  return (
    <div className="relative w-full h-full flex flex-col bg-studio-950">
      <SiteMenu active="dev" />

      <div className="flex-1 min-h-0 flex">
        {/* Starts / stops the WebSocket connection to Blender */}
        <BlenderConnection />

        {/* Live synced canvas */}
        <div className="flex-1 min-w-0 relative">
          <CanvasGPU>
            <SyncViewer />
            <CameraSync />
            <BloomRender />
          </CanvasGPU>
        </div>

        {/* Sync controls + snapshot + OPFS browser */}
        <Sidebar
          bottomRow={
            <div className="px-3.5 py-2.5 border-t border-border h-[400px] overflow-y-scroll">
              <OpfsBrowser refreshKey={deploymentVersion} />
            </div>
          }
        />
      </div>

      {/* Navmesh playground — walks on the Blender-synced mesh */}
      <NavMeshDemoButton getWalkableMeshes={getWalkableMeshes} />
    </div>
  );
}
