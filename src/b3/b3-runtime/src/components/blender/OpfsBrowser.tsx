"use client";

import { useState, useEffect, useCallback } from "react";
import { opfs } from "../utils/opfs";
import type { OpfsTree, OpfsTreeNode } from "../utils/opfs/types";

// ---------------------------------------------------------------------------
// OPFS Browser — collapsible tree view of the OPFS file system
// ---------------------------------------------------------------------------

// ---- SVG icons ----

function FolderIcon({ open }: { open?: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          <line x1="9" y1="13" x2="22" y2="13" />
        </>
      ) : (
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      )}
    </svg>
  );
}

function FileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <polyline points="13 2 13 9 20 9" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      width="12"
      height="12"
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

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform ${expanded ? "rotate-90" : ""}`}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// ---- Helpers ----

function fmtSize(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function pct(saved: number, original: number): string | null {
  if (original === 0) return null;
  const p = ((1 - saved / original) * 100).toFixed(0);
  if (parseInt(p) <= 0) return null;
  return `${p}%`;
}

// ---- Tree node component ----

function TreeNode({
  node,
  depth,
  defaultOpen,
}: {
  node: OpfsTreeNode;
  depth: number;
  defaultOpen?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultOpen ?? depth < 2);
  const isDir = node.kind === "dir";
  const hasChildren = isDir && node.children && node.children.length > 0;

  return (
    <div>
      <button
        onClick={() => isDir && setExpanded(!expanded)}
        disabled={!isDir}
        className={`
          flex items-center gap-1 w-full text-left py-0.5
          text-[10px] leading-relaxed
          ${isDir ? "cursor-pointer hover:text-text-primary" : "cursor-default"}
          ${depth === 0 ? "text-text-primary font-semibold" : "text-text-muted"}
          transition-colors
        `}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {/* Chevron */}
        {isDir && (
          <span className="shrink-0 opacity-40">
            <ChevronIcon expanded={expanded} />
          </span>
        )}
        {!isDir && <span className="w-2.5 shrink-0" />}

        {/* Icon */}
        <span className="shrink-0 opacity-60">
          {isDir ? <FolderIcon open={expanded && hasChildren} /> : <FileIcon />}
        </span>

        {/* Name */}
        <span className="truncate flex-1">{node.name}</span>

        {/* Size */}
        <span className="shrink-0 tabular-nums text-text-muted/60">
          {isDir && hasChildren
            ? fmtSize(node.size)
            : !isDir
              ? fmtSize(node.size)
              : null}
        </span>
      </button>

      {/* Children */}
      {expanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <TreeNode key={child.name} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Main component ----

export function OpfsBrowser({ refreshKey = 0 }: { refreshKey?: number }) {
  const [tree, setTree] = useState<OpfsTree | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const t = await opfs.listTree();
      setTree(t);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to read OPFS");
      setTree(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const handleClear = async () => {
    if (!window.confirm("Delete all OPFS snapshots?")) return;
    try {
      await opfs.clearAll();
      await refresh();
    } catch (err) {
      console.error("[OPFS Browser] Clear failed:", err);
    }
  };

  const isEmpty =
    !tree ||
    (tree.rawTotal === 0 &&
      tree.optimisedTotal === 0 &&
      tree.deploymentTotal === 0);
  const savingsPct = tree ? pct(tree.optimisedTotal, tree.rawTotal) : null;

  return (
    <div className="space-y-1.5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-widest text-text-muted">
          OPFS Storage
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={refresh}
            disabled={loading}
            className="p-1 rounded text-text-muted hover:text-text-primary hover:bg-surface-secondary transition-colors disabled:opacity-40"
            title="Refresh"
          >
            <RefreshIcon />
          </button>
          {!isEmpty && (
            <button
              onClick={handleClear}
              className="p-1 rounded text-text-muted hover:text-status-red hover:bg-status-red/10 transition-colors"
              title="Clear all snapshots"
            >
              <TrashIcon />
            </button>
          )}
        </div>
      </div>

      {/* Loading / Error / Empty */}
      {loading && tree === null && (
        <div className="text-[10px] text-text-muted/60 pl-1">Reading OPFS…</div>
      )}
      {error && (
        <div className="text-[10px] text-status-red/80 pl-1">{error}</div>
      )}
      {!loading && isEmpty && (
        <div className="text-[10px] text-text-muted/60 pl-1">
          No snapshots — save one to see files here.
        </div>
      )}

      {/* Size summary */}
      {tree && !isEmpty && (
        <>
          <div className="flex gap-3 text-[10px] text-text-muted/70 pl-1">
            <span>
              Raw:{" "}
              <span className="text-text-secondary tabular-nums font-semibold">
                {fmtSize(tree.rawTotal)}
              </span>
            </span>
            {tree.optimisedTotal > 0 && (
              <>
                <span>
                  Opt:{" "}
                  <span className="text-text-secondary tabular-nums font-semibold">
                    {fmtSize(tree.optimisedTotal)}
                  </span>
                </span>
                {savingsPct && (
                  <span className="text-status-green/80 font-semibold">
                    −{savingsPct}
                  </span>
                )}
              </>
            )}
            {tree.deploymentTotal > 0 && (
              <span>
                Zip:{" "}
                <span className="text-text-secondary tabular-nums font-semibold">
                  {fmtSize(tree.deploymentTotal)}
                </span>
              </span>
            )}
          </div>

          {/* Tree */}
          <div className="bg-surface-secondary/50 rounded border border-border/50 p-1.5">
            {tree.root.children?.map((child) => (
              <TreeNode
                key={child.name}
                node={child}
                depth={0}
                defaultOpen={true}
              />
            ))}
          </div>
        </>
      )}

      {/* Quick indicator when loading after initial load */}
      {loading && tree !== null && (
        <div className="text-[9px] text-text-muted/40 pl-1">Refreshing…</div>
      )}
    </div>
  );
}
