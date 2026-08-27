"use client";

import { Component, useCallback, useState, type ReactNode } from "react";
import type * as THREE from "three";
import { NavMeshPlayground } from "./NavMeshPlayground";

interface NavMeshDemoButtonProps {
  /** Supplies the walkable meshes for the navmesh (e.g. Blender-synced geometry). */
  getWalkableMeshes?: () => THREE.Mesh[];
}

/**
 * Keeps a crash inside the imperative playground from unmounting the whole
 * page — shows a closeable fallback instead.
 */
class PlaygroundErrorBoundary extends Component<
  { onClose: () => void; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="fixed inset-0 z-50 bg-studio-950 flex items-center justify-center">
          <div className="text-center space-y-3 max-w-md px-6">
            <p className="text-sm text-status-red font-mono">
              Navmesh playground crashed
            </p>
            <p className="text-xs text-text-muted font-mono break-all">
              {String(this.state.error.message ?? this.state.error)}
            </p>
            <button
              onClick={this.props.onClose}
              className="px-3 py-1.5 rounded-md bg-studio-800 border border-studio-700 text-ice-200 text-xs font-mono hover:bg-studio-700 transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export function NavMeshDemoButton({
  getWalkableMeshes,
}: NavMeshDemoButtonProps) {
  const [open, setOpen] = useState(false);
  const handleClose = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Open the navmesh playground"
        className="fixed bottom-4 left-4 z-40 inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-studio-800 border border-studio-700 text-ice-200 text-xs font-mono hover:bg-studio-700 hover:text-ice-50 transition-colors"
      >
        Navmesh Demo
      </button>

      {open && (
        <PlaygroundErrorBoundary onClose={handleClose}>
          <NavMeshPlayground
            onClose={handleClose}
            getWalkableMeshes={getWalkableMeshes}
          />
        </PlaygroundErrorBoundary>
      )}
    </>
  );
}
