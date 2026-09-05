"use client";

import { useEffect, useState } from "react";
import { opfs, ProductionViewer, useBlenderStore } from "../b3/b3-runtime/src";
import { BloomRender } from "../b3/b3-runtime/src/components/blender/canvas-units/BloomRender";
import { SiteMenu } from "../components/SiteMenu";
import { NavMeshRig } from "../components/NavMeshRig";
import { VirtualJoystick } from "../components/VirtualJoystick";
import { EmotionButtons } from "../components/EmotionButtons";

/**
 * Production — optimised deployment preview.
 *
 * Loads the deployment zip produced by the dev page's snapshot pipeline from
 * OPFS and renders it through the production viewer.
 */
export function ProductionPage() {
  const deploymentVersion = useBlenderStore((s) => s.deploymentVersion);
  const [zipBuffer, setZipBuffer] = useState<ArrayBuffer | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const buf = await opfs.readDeployment();
        if (cancelled) return;
        setZipBuffer(buf);
        if (!buf) setError(null); // not an error — nothing deployed yet
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
  }, [deploymentVersion]);

  return (
    <div className="w-full h-full flex flex-col bg-studio-950">
      <SiteMenu active="production" />

      {/* On-screen joystick + emotion buttons to drive the deployed character */}
      {zipBuffer ? (
        <>
          <VirtualJoystick />
          <EmotionButtons />
        </>
      ) : null}

      <div className="flex-1 min-h-0 relative">
        {/* Loading the deployment zip */}
        {loading && !zipBuffer && (
          <div className="h-full w-full flex items-center justify-center bg-surface-primary/50 text-text-muted text-xs font-mono">
            <span>Loading deployment…</span>
          </div>
        )}

        {/* Reading failed */}
        {error && (
          <div className="h-full w-full flex items-center justify-center bg-surface-primary/50 text-status-red text-xs font-mono">
            <span>{error}</span>
          </div>
        )}

        {/* Nothing deployed yet */}
        {!loading && !error && !zipBuffer && (
          <div className="h-full w-full flex flex-col items-center justify-center gap-2 bg-surface-primary/50 text-text-muted text-xs font-mono">
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="opacity-40"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="21" x2="9" y2="9" />
            </svg>
            <span className="opacity-60">
              No deployment yet — connect Blender and save a snapshot on the Dev
              page.
            </span>
          </div>
        )}

        {/* Ready — render the optimised deployment */}
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
