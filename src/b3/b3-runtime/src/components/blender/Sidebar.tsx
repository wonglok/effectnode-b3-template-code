"use client";

import { useState, type ReactNode } from "react";
import { useBlenderStore } from "../stores/blenderStore";
import { useSettingsStore } from "../stores/settingsStore";
import { useBlenderSyncStore } from "../stores/blenderSyncStore";
import { opfs, opfsOptimiser } from "../utils/opfs";
import type { ConnectionState } from "../types/blenderTypes";

// ---------------------------------------------------------------------------
// Sidebar — left panel with sync controls, port config, and status info
// ---------------------------------------------------------------------------

const stateConfig: Record<ConnectionState, { color: string; label: string }> = {
  disconnected: { color: "bg-gray-500", label: "Disconnected" },
  connecting: { color: "bg-yellow-500", label: "Connecting…" },
  connected: { color: "bg-green-500", label: "Connected" },
  error: { color: "bg-red-500", label: "Error" },
};

// ---------------------------------------------------------------------------
// SVG icons
// ---------------------------------------------------------------------------

function CubeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function RadioIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="2" />
      <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="23 4 23 10 17 10" />
      <polyline points="1 20 1 14 7 14" />
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
    </svg>
  );
}

function SaveIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
      <polyline points="17 21 17 13 7 13 7 21" />
      <polyline points="7 3 7 8 15 8" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------
export function Sidebar({
  bottomRow = null,
  moreButtons = null,
}: {
  bottomRow?: ReactNode;
  moreButtons?: ReactNode;
}) {
  const connectionState = useBlenderStore((s) => s.connectionState);
  const objectCount = useBlenderStore((s) => s.sceneData.objects.length);
  const cameraData = useBlenderStore((s) => s.cameraData);
  const sceneCameras = useBlenderStore((s) => s.cameras);
  const selectedCamera = useBlenderStore((s) => s.selectedCamera);
  const selectCamera = useBlenderStore((s) => s.selectCamera);

  const port = useSettingsStore((s) => s.port);
  const setPort = useSettingsStore((s) => s.setPort);

  const connect = useBlenderSyncStore((s) => s.connect);
  const disconnect = useBlenderSyncStore((s) => s.disconnect);
  const hardRefresh = useBlenderSyncStore((s) => s.hardRefresh);

  const [portInput, setPortInput] = useState(String(port));
  const [portDirty, setPortDirty] = useState(false);

  const handlePortSave = () => {
    const num = parseInt(portInput, 10);
    if (num > 0 && num <= 65535) {
      setPort(num);
      setPortDirty(false);
    } else {
      setPortInput(String(port));
      setPortDirty(false);
    }
  };

  const handlePortKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handlePortSave();
    if (e.key === "Escape") {
      setPortInput(String(port));
      setPortDirty(false);
    }
  };

  const config = stateConfig[connectionState];
  const isConnected = connectionState === "connected";
  const isConnecting = connectionState === "connecting";

  // Snapshot state
  const [snapshotStatus, setSnapshotStatus] = useState<
    "idle" | "saving" | "optimising" | "packaging" | "done" | "error"
  >("idle");

  const takeSnapshot = async () => {
    if (!isConnected) return;
    try {
      setSnapshotStatus("saving");

      const store = useBlenderStore.getState();
      await opfs.writeSnapshot({
        scene: store.sceneData,
        hdrPixels: store.hdrData?.pixels,
        hdrWidth: store.hdrData?.width,
        hdrHeight: store.hdrData?.height,
        hdrIntensity: store.hdrIntensity,
        textures: store.texData,
        geoBuffers: store.geoBuffers,
        cameras: store.cameras,
        lights: store.lights,
      });

      setSnapshotStatus("optimising");
      await opfsOptimiser.optimise();

      setSnapshotStatus("packaging");
      await opfsOptimiser.packageDeployment();

      setSnapshotStatus("done");
      useBlenderStore.getState().bumpDeploymentVersion();
      setTimeout(() => setSnapshotStatus("idle"), 2000);
    } catch (err) {
      console.error("[B3Sync] Snapshot failed:", err);
      setSnapshotStatus("error");
      setTimeout(() => setSnapshotStatus("idle"), 3000);
    }
  };

  return (
    <div
      className="
        h-full w-[300px]
        bg-surface-primary/95 backdrop-blur-md
        border-r border-border
        text-text-primary text-xs font-mono
        flex flex-col
        overflow-hidden
      "
    >
      {/* ---- Header ---- */}
      <div className="flex items-center gap-2 px-3.5 py-3 border-b border-border">
        <span className="text-text-muted">
          <RadioIcon />
        </span>
        <span className="text-sm font-semibold tracking-wide text-text-primary flex-1">
          Blender System
        </span>
      </div>

      {/* ---- Body ---- */}
      <div className="flex-1 flex flex-col gap-3 px-3.5 py-3 overflow-y-auto">
        {/* Port configuration */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Port
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="number"
              value={portInput}
              onChange={(e) => {
                setPortInput(e.target.value);
                setPortDirty(e.target.value !== String(port));
              }}
              onKeyDown={handlePortKeyDown}
              onBlur={handlePortSave}
              disabled={isConnected}
              className="
                w-full px-2 py-1.5 rounded
                bg-surface-secondary border border-border
                text-text-primary text-xs font-mono
                focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent/20
                disabled:opacity-50 disabled:cursor-not-allowed
                transition-colors
                [appearance:textfield]
                [&::-webkit-outer-spin-button]:appearance-none
                [&::-webkit-inner-spin-button]:appearance-none
              "
              placeholder="8765"
            />
            {portDirty && !isConnected && (
              <button
                onClick={handlePortSave}
                className="shrink-0 px-2 py-1.5 rounded bg-accent text-studio-900 text-[10px] font-semibold hover:bg-accent-strong transition-colors"
              >
                Apply
              </button>
            )}
          </div>
        </div>

        {/* Connection controls */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Connection
          </div>

          {/* Status indicator */}
          <div className="flex items-center gap-2">
            <span
              className={`inline-block w-2 h-2 rounded-full shrink-0 ${config.color}`}
            />
            <span className="text-text-secondary">{config.label}</span>
          </div>

          {/* Connect / Disconnect + Hard Refresh */}
          <div className="flex gap-1.5">
            {!isConnected ? (
              <button
                onClick={connect}
                disabled={isConnecting}
                className="
                  flex-1 px-2.5 py-1.5 rounded flex items-center justify-center
                  bg-accent text-studio-900 text-xs
                  hover:bg-accent-strong
                  disabled:opacity-50 disabled:cursor-not-allowed
                  transition-colors
                "
              >
                {isConnecting ? "Connecting…" : "Connect"}
              </button>
            ) : (
              <button
                onClick={disconnect}
                className="
                  flex-1 px-2.5 py-1.5 rounded flex items-center justify-center
                  bg-status-red text-white text-xs
                  hover:bg-status-red/80
                  transition-colors
                "
              >
                Disconnect
              </button>
            )}
            <button
              onClick={hardRefresh}
              disabled={!isConnected}
              className="
                shrink-0 px-2 py-1.5 rounded
                bg-surface-secondary border border-border
                text-text-secondary text-[11px]
                hover:bg-surface-tertiary hover:text-text-primary
                disabled:opacity-40 disabled:cursor-not-allowed
                transition-colors
              "
              title="Disconnect, clear all scene data, reconnect"
            >
              <RefreshIcon />
            </button>
          </div>
        </div>

        {/* Object count */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Scene
          </div>
          <div className="flex items-center gap-2 text-text-secondary">
            <CubeIcon />
            <span>
              {isConnected ? (
                <>
                  <span className="text-text-primary font-semibold">
                    {objectCount}
                  </span>{" "}
                  objects
                </>
              ) : (
                "—"
              )}
            </span>
          </div>
        </div>

        {/* Snapshot */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Snapshot
          </div>
          <button
            onClick={takeSnapshot}
            disabled={
              !isConnected ||
              snapshotStatus === "saving" ||
              snapshotStatus === "optimising" ||
              snapshotStatus === "packaging"
            }
            className={`
              w-full px-2.5 py-1.5 rounded flex items-center justify-center gap-1.5
              bg-surface-secondary border border-border
              text-text-secondary text-[11px] font-semibold
              hover:bg-surface-tertiary hover:text-text-primary
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-colors
              ${
                snapshotStatus === "done"
                  ? "border-status-green/40 text-status-green"
                  : ""
              }
              ${
                snapshotStatus === "error"
                  ? "border-status-red/40 text-status-red"
                  : ""
              }
            `}
            title="Save raw scene data to OPFS, then run AVIF+Draco optimiser"
          >
            <SaveIcon />
            {snapshotStatus === "saving"
              ? "Saving…"
              : snapshotStatus === "optimising"
                ? "Optimising…"
                : snapshotStatus === "packaging"
                  ? "Packaging…"
                  : snapshotStatus === "done"
                    ? "Saved"
                    : snapshotStatus === "error"
                      ? "Failed"
                      : "Save Snapshot"}
          </button>
        </div>

        {moreButtons}

        {/* Camera Sync */}
        <div className="space-y-1.5">
          <div className="text-[10px] uppercase tracking-widest text-text-muted">
            Camera
          </div>

          {isConnected && !cameraData && (
            <div className="text-[10px] text-status-yellow/80 pl-2">
              Waiting for viewport data…
            </div>
          )}

          {/* Scene cameras list */}
          {isConnected && sceneCameras.length > 0 && (
            <div className="mt-2 pt-2 border-t border-border space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">
                Scene Cameras ({sceneCameras.length})
              </div>
              {sceneCameras.map((cam) => {
                const isSelected = selectedCamera?.name === cam.name;
                return (
                  <button
                    key={cam.name}
                    onClick={() => selectCamera(isSelected ? null : cam)}
                    className={`
                      w-full text-left pl-2 pr-1.5 py-1.5 rounded
                      text-[10px] leading-relaxed
                      transition-all duration-150
                      ${
                        isSelected
                          ? "bg-accent-subtle border border-accent/30"
                          : cam.isActive
                            ? "bg-status-green/10 border border-status-green/20 hover:bg-status-green/15"
                            : "bg-surface-secondary border border-transparent hover:bg-surface-tertiary hover:border-border"
                      }
                    `}
                  >
                    <div className="flex items-center gap-1.5">
                      {cam.isActive && (
                        <span className="w-1.5 h-1.5 rounded-full bg-status-green shrink-0" />
                      )}
                      {isSelected && (
                        <span className="w-1.5 h-1.5 rounded-full bg-accent shrink-0" />
                      )}
                      {!cam.isActive && !isSelected && (
                        <span className="w-1.5 h-1.5 shrink-0" />
                      )}
                      <span
                        className={`truncate ${
                          isSelected ? "text-accent" : "text-text-secondary"
                        }`}
                      >
                        {cam.name}
                      </span>
                    </div>
                    <div className="flex justify-between text-text-muted mt-0.5">
                      <span>{cam.ortho ? "Ortho" : `${cam.fov}°`}</span>
                      <span>
                        {cam.position[0].toFixed(1)},{" "}
                        {cam.position[1].toFixed(1)},{" "}
                        {cam.position[2].toFixed(1)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {isConnected && sceneCameras.length === 0 && (
            <div className="text-[10px] text-text-muted/60 pl-2 mt-1">
              No scene cameras
            </div>
          )}

          {/* Camera detail when syncing */}
          {/* {isConnected && cameraData && (
            <div className="mt-1 space-y-0.5 pl-2 text-[10px] text-text-muted leading-relaxed">
              <div className="flex justify-between">
                <span>FOV</span>
                <span className="text-text-secondary tabular-nums">
                  {cameraData.ortho ? "ortho" : `${cameraData.fov}°`}
                </span>
              </div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted/70 mt-1">
                Position
              </div>
              <div className="flex justify-between">
                <span>X</span>
                <span className="text-text-secondary tabular-nums">
                  {cameraData.position[0].toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Y</span>
                <span className="text-text-secondary tabular-nums">
                  {cameraData.position[1].toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Z</span>
                <span className="text-text-secondary tabular-nums">
                  {cameraData.position[2].toFixed(2)}
                </span>
              </div>
              <div className="text-[10px] uppercase tracking-wider text-text-muted/70 mt-1">
                Rotation
              </div>
              <div className="flex justify-between">
                <span>X</span>
                <span className="text-text-secondary tabular-nums">
                  {((cameraData.euler[0] * 180) / Math.PI).toFixed(1)}°
                </span>
              </div>
              <div className="flex justify-between">
                <span>Y</span>
                <span className="text-text-secondary tabular-nums">
                  {((cameraData.euler[1] * 180) / Math.PI).toFixed(1)}°
                </span>
              </div>
              <div className="flex justify-between">
                <span>Z</span>
                <span className="text-text-secondary tabular-nums">
                  {((cameraData.euler[2] * 180) / Math.PI).toFixed(1)}°
                </span>
              </div>
            </div>
          )} */}
        </div>
      </div>

      {bottomRow}

      {/* ---- Footer ---- */}
      <div className="px-3.5 py-2.5 border-t border-border text-[10px] text-text-muted/60">
        B3Sync :{port}
      </div>

      {/*  */}
    </div>
  );
}
