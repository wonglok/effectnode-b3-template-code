"use client";

import { useEffect, useState } from "react";
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
import { NavMeshRig } from "../components/NavMeshRig";

/**
 * Dev — live Blender receiver.
 *
 * Connects to the Blender addon over WebSocket, renders the synced scene on a
 * WebGPU canvas, and offers snapshot → OPFS → optimiser controls in the sidebar.
 *
 * "Navmesh Mode" (sidebar toggle) swaps the camera-sync for an in-canvas
 * navmesh + character rig: the character walks the synced *collider* mesh
 * inside the same CanvasGPU.
 */
export function DevPage() {
  // Bumped by every snapshot — re-reads the OPFS tree so the space freed by
  // pruning is actually visible after pressing save.
  const deploymentVersion = useBlenderStore((s) => s.deploymentVersion);

  // Navmesh mode renders the character rig inside CanvasGPU (instead of the
  // live camera sync) so the Blender content is experienced in the same canvas.
  const [navmeshMode, setNavmeshMode] = useState(false);

  // TEMP DEBUG — expose store for inspection
  useEffect(() => {
    (window as any).__blenderStore = useBlenderStore;
  }, []);

  return (
    <div className="relative w-full h-full flex flex-col bg-studio-950">
      <SiteMenu active="dev" />

      <div className="flex-1 min-h-0 flex">
        {/* Starts / stops the WebSocket connection to Blender */}
        <BlenderConnection />

        {/* Live synced canvas — navmesh rig swaps the camera sync while active */}
        <div className="flex-1 min-w-0 relative">
          <CanvasGPU>
            <SyncViewer />
            {navmeshMode ? <NavMeshRig /> : <CameraSync />}
            <BloomRender />
          </CanvasGPU>
        </div>

        {/* Sync controls + snapshot + OPFS browser */}
        <Sidebar
          moreButtons={
            <div className="space-y-1.5">
              <div className="text-[10px] uppercase tracking-widest text-text-muted">
                Experience
              </div>
              <button
                onClick={() => setNavmeshMode((m) => !m)}
                className={`
                  w-full px-2.5 py-1.5 rounded flex items-center justify-center
                  bg-surface-secondary border border-border
                  text-text-secondary text-[11px] font-semibold
                  hover:bg-surface-tertiary hover:text-text-primary
                  transition-colors
                  ${navmeshMode ? "border-accent/40 text-accent" : ""}
                `}
              >
                {navmeshMode ? "Navmesh Mode: ON" : "Navmesh Mode: OFF"}
              </button>
            </div>
          }
          bottomRow={
            <div className="px-3.5 py-2.5 border-t border-border h-[400px] overflow-y-scroll">
              <OpfsBrowser refreshKey={deploymentVersion} />
            </div>
          }
        />
      </div>
    </div>
  );
}
