"use client";

import { useEffect, useState } from "react";
import { ProductionViewer } from "../b3/b3-runtime/src";
import { BloomRender } from "../b3/b3-runtime/src/components/blender/canvas-units/BloomRender";
import { SiteMenu } from "../components/SiteMenu";
import { NavMeshRig } from "../components/NavMeshRig";
import { VirtualJoystick } from "../components/VirtualJoystick";

const DEPLOY_URL = "/deploy/scene.zip";

/**
 * Deployed — renders a packaged deployment zip served statically.
 *
 * Fetches `/deploy/place.zip` and plays it through the production viewer, with
 * the in-canvas navmesh + character rig layered on top so the deployed scene
 * can be walked on (the rig falls back to the deployed scene's *collider*
 * meshes when no live Blender sync is present).
 */
export function DeployedPage() {
  const [zipBuffer, setZipBuffer] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(DEPLOY_URL);
        if (!res.ok) {
          throw new Error(`Failed to load deployment (${res.status})`);
        }
        const buf = await res.arrayBuffer();
        if (cancelled) return;
        setZipBuffer(buf);
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Failed to load deployment",
        );
        setZipBuffer(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="w-full h-full flex flex-col bg-studio-950">
      <SiteMenu active="deployment" />

      {/* On-screen joystick to walk the deployed scene's character */}
      {zipBuffer ? <VirtualJoystick /> : null}

      <div className="flex-1 min-h-0 relative">
        {/* Fetching the deployment zip */}
        {loading && !zipBuffer && (
          <div className="h-full w-full flex items-center justify-center bg-surface-primary/50 text-text-muted text-xs font-mono">
            <span>Loading deployment…</span>
          </div>
        )}

        {/* Fetch failed */}
        {error && (
          <div className="h-full w-full flex items-center justify-center bg-surface-primary/50 text-status-red text-xs font-mono">
            <span>{error}</span>
          </div>
        )}

        {/* No file served */}
        {!loading && !error && !zipBuffer && (
          <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-surface-primary/50 text-text-muted text-xs font-mono">
            <span className="opacity-60">
              No deployment zip at {DEPLOY_URL}
            </span>
          </div>
        )}

        {/* Ready — render the deployed scene with the character rig */}
        {zipBuffer && (
          <ProductionViewer zipBuffer={zipBuffer}>
            <NavMeshRig />
            <BloomRender />
          </ProductionViewer>
        )}
      </div>
    </div>
  );
}
