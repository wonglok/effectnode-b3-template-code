"use client";

import { useRef, useState } from "react";
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
export function DeployedPage() {
  // Bumped by every snapshot — re-reads the OPFS tree so the space freed by
  // pruning is actually visible after pressing save.
  const deploymentVersion = useBlenderStore((s) => s.deploymentVersion);

  // Navmesh mode renders the character rig inside CanvasGPU (instead of the
  // live camera sync) so the Blender content is experienced in the same canvas.
  // Defaults to ON so the character rig is active immediately on this page.
  const [navmeshMode, setNavmeshMode] = useState(true);

  // lil-gui mounts into this div inside the sidebar when navmesh mode is on.
  const guiContainerRef = useRef<HTMLDivElement>(null);

  // Download the current deployment zip from OPFS.
  const [downloadStatus, setDownloadStatus] = useState<
    "idle" | "saving" | "done" | "empty" | "error"
  >("idle");

  const downloadDeployment = async () => {
    try {
      setDownloadStatus("saving");
      const res = await fetch("/deploy/place.zip");
      if (!res.ok) {
        setDownloadStatus("empty");
        setTimeout(() => setDownloadStatus("idle"), 2000);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "place.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadStatus("done");
      setTimeout(() => setDownloadStatus("idle"), 2000);
    } catch (err) {
      console.error("[DeployedPage] Failed to download deployment:", err);
      setDownloadStatus("error");
      setTimeout(() => setDownloadStatus("idle"), 2000);
    }
  };

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
            {navmeshMode ? (
              <NavMeshRig guiContainer={guiContainerRef} />
            ) : (
              <CameraSync />
            )}
            <BloomRender />
          </CanvasGPU>
        </div>

        {/* Sync controls + snapshot + OPFS browser */}
        <Sidebar
          moreButtons={
            <>
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

                {/* lil-gui mounts here when navmesh mode is active */}
                {navmeshMode && (
                  <div
                    ref={guiContainerRef}
                    className="b3-gui mt-2 max-h-80 overflow-y-auto"
                  />
                )}
              </div>

              <div className="space-y-1.5">
                <div className="text-[10px] uppercase tracking-widest text-text-muted">
                  Deployment
                </div>
                <button
                  onClick={downloadDeployment}
                  className={`
                    w-full px-2.5 py-1.5 rounded flex items-center justify-center
                    bg-surface-secondary border border-border
                    text-text-secondary text-[11px] font-semibold
                    hover:bg-surface-tertiary hover:text-text-primary
                    transition-colors
                    ${
                      downloadStatus === "done"
                        ? "border-status-green/40 text-status-green"
                        : ""
                    }
                    ${
                      downloadStatus === "error"
                        ? "border-status-red/40 text-status-red"
                        : ""
                    }
                  `}
                  title="Download the current deployment zip from OPFS"
                >
                  {downloadStatus === "saving"
                    ? "Preparing…"
                    : downloadStatus === "done"
                      ? "Downloaded"
                      : downloadStatus === "empty"
                        ? "No deployment yet"
                        : downloadStatus === "error"
                          ? "Failed"
                          : "Download scene.zip"}
                </button>
              </div>
            </>
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
