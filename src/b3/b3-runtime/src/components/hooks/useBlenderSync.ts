"use client";

import { useEffect } from "react";
import { useBlenderSyncStore } from "../stores/blenderSyncStore";

// ---------------------------------------------------------------------------
// Thin compatibility hook — calls the Zustand store's connect() on mount
// and disconnect() on unmount.  The real sync logic lives in blenderSyncStore.
//
// All shared types have moved to ../types/blenderTypes so existing imports
// from this file will break.  Update them to point to ../types/blenderTypes.
// ---------------------------------------------------------------------------

export function useBlenderSync(): void {
  const connect = useBlenderSyncStore((s) => s.connect);
  const disconnect = useBlenderSyncStore((s) => s.disconnect);

  useEffect(() => {
    connect();
    return () => {
      disconnect();
    };
  }, [connect, disconnect]);
}

// Re-export types for any straggler consumers that haven't migrated yet
export type {
  BlenderObject,
  GeoBuffer,
  SceneData,
  ImageData,
  TextureData,
  CameraData,
  LightData,
  ConnectionState,
} from "../types/blenderTypes";
