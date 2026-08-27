"use client";

import { useEffect, useRef, useState } from "react";
import {
  OpfsBrowser,
  Sidebar,
  BlenderConnection,
  CanvasGPU,
  SyncViewer,
  CameraSync,
  opfs,
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

  // lil-gui mounts into this div inside the sidebar when navmesh mode is on.
  const guiContainerRef = useRef<HTMLDivElement>(null);

  // Download the current deployment zip from OPFS.
  const [downloadStatus, setDownloadStatus] = useState<
    "idle" | "saving" | "done" | "empty" | "error"
  >("idle");

  // Browser File System API — pick a folder to auto-export scene.zip after
  // every snapshot.
  const [dirHandle, setDirHandle] = useState<FileSystemDirectoryHandle | null>(
    null,
  );
  const [exportStatus, setExportStatus] = useState<
    "idle" | "writing" | "done" | "no-deployment" | "error"
  >("idle");

  const writeDeployment = async (dir: FileSystemDirectoryHandle) => {
    try {
      setExportStatus("writing");
      const buf = await opfs.readDeployment();
      if (!buf) {
        setExportStatus("no-deployment");
        return;
      }
      const fileHandle = await dir.getFileHandle("scene.zip", {
        create: true,
      });
      const writable = await fileHandle.createWritable();
      await writable.write(new Blob([buf], { type: "application/zip" }));
      await writable.close();
      setExportStatus("done");
    } catch (err) {
      console.error("[DevPage] Failed to write scene.zip to folder:", err);
      setExportStatus("error");
    }
  };

  const selectFolder = async () => {
    try {
      // File System Access API isn't in every TS lib version — cast it.
      const picker = (window as Window & {
        showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
      }).showDirectoryPicker;
      if (!picker) {
        console.warn(
          "[DevPage] File System Access API not supported in this browser",
        );
        return;
      }
      const handle = await picker();
      setDirHandle(handle);
    } catch {
      // user cancelled the picker — no-op
    }
  };

  // Auto-export scene.zip whenever a snapshot lands (deploymentVersion bumps
  // after packaging) and whenever a folder is first selected.
  useEffect(() => {
    if (!dirHandle) return;
    void writeDeployment(dirHandle);
  }, [deploymentVersion, dirHandle]);

  const downloadDeployment = async () => {
    try {
      setDownloadStatus("saving");
      const buf = await opfs.readDeployment();
      if (!buf) {
        setDownloadStatus("empty");
        setTimeout(() => setDownloadStatus("idle"), 2000);
        return;
      }
      const blob = new Blob([buf], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "scene.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDownloadStatus("done");
      setTimeout(() => setDownloadStatus("idle"), 2000);
    } catch (err) {
      console.error("[DevPage] Failed to download deployment:", err);
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

                {/* Browser File System API — auto-export scene.zip on snapshot */}
                <button
                  onClick={selectFolder}
                  className={`
                    w-full px-2.5 py-1.5 rounded flex items-center justify-center
                    bg-surface-secondary border border-border
                    text-text-secondary text-[11px] font-semibold
                    hover:bg-surface-tertiary hover:text-text-primary
                    transition-colors
                    ${dirHandle ? "border-accent/40 text-accent" : ""}
                  `}
                  title="Pick a folder to auto-save scene.zip on every snapshot"
                >
                  {dirHandle
                    ? `Export → ${dirHandle.name}`
                    : "Select Export Folder"}
                </button>
                {dirHandle && (
                  <div
                    className={`
                      text-[10px] pl-1 leading-relaxed
                      ${
                        exportStatus === "error"
                          ? "text-status-red"
                          : exportStatus === "done"
                            ? "text-status-green"
                            : "text-text-muted"
                      }
                    `}
                  >
                    {exportStatus === "writing"
                      ? "Writing scene.zip…"
                      : exportStatus === "done"
                        ? "scene.zip exported"
                        : exportStatus === "no-deployment"
                          ? "No deployment to export yet"
                          : exportStatus === "error"
                            ? "Export failed"
                            : "Auto-export on every snapshot"}
                  </div>
                )}
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
