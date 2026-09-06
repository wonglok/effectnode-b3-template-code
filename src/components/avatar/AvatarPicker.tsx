"use client";

import { useEffect, useRef, useState } from "react";
import {
  createMotionCatalog,
  partsFor,
  variantForUrl,
} from "../../b3/b3-runtime/src/components/AvatarSDK";
import type { PartKind } from "../../b3/b3-runtime/src/components/AvatarSDK";
import { useAvatarStore } from "./useAvatarStore";
import { Chip } from "./panel";
import { AvatarPreviewCanvas } from "./AvatarPreviewCanvas";

/**
 * Avatar picker — floating button in the bottom-right of a 3D canvas that opens
 * a popup to restyle the character.
 *
 * Gender / body / head chips **live-apply** to the avatar store (the same store
 * NavMeshRig subscribes to), so the walking character updates in real time —
 * exactly like the Dev-page tuning sidebar. The "stay motion" chips are
 * **preview-only**: they loop that `/char/motion-2/fbx/stay` clip inside the
 * popup's own preview canvas and never touch the main character.
 *
 * Mounted inside each page's (relative) canvas container; the trigger is
 * absolutely placed bottom-right and the modal floats fixed over the whole app.
 */

/** The 8 stay clips served from `/char/motion-2/fbx/stay`. */
const STAY_MOTIONS = createMotionCatalog("/char/motion-2/fbx/stay");

/** Default clip the popup preview starts on. */
const DEFAULT_MOTION = "idle-breathing";

/** Readable chip label for a clip name (`idle-breathing` → `idle breathing`). */
function labelOf(name: string): string {
  return name.replace(/-/g, " ");
}

/** Head-and-shoulders glyph for the floating trigger. */
function PersonIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="8" r="4" />
      <path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

/** Keyboard events land on the modal wrapper (it holds focus); stopping them
 * here keeps WASD / Space from reaching the NavMeshRig's document listeners
 * while the popup is open. */
type KeyHandler = {
  key: string;
  stopPropagation: () => void;
};

export function AvatarPicker() {
  const [open, setOpen] = useState(false);
  const [motion, setMotion] = useState(DEFAULT_MOTION);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Focus the dialog on open so keystrokes target it (and are stopped below)
  // instead of the body — otherwise WASD would still drive the walking rig.
  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  const handleKeyDown = (e: KeyHandler) => {
    if (e.key === "Escape") setOpen(false);
    e.stopPropagation();
  };
  const stopKeyUp = (e: KeyHandler) => e.stopPropagation();

  return (
    <>
      {/* Floating trigger — bottom-right of the 3D canvas area */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Customize avatar"
        title="Customize avatar"
        className="pointer-events-auto absolute right-4 bottom-4 z-40 flex h-12 w-12 items-center justify-center rounded-full border border-tiffany-400/30 bg-studio-900/80 text-tiffany-300 shadow-[0_6px_18px_rgba(0,0,0,0.4)] backdrop-blur-sm transition hover:scale-105 hover:border-tiffany-300 hover:text-white active:scale-95"
      >
        <PersonIcon className="h-6 w-6" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          {/* Backdrop — click to close */}
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
          />

          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Avatar picker"
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            onKeyUp={stopKeyUp}
            onContextMenu={(e) => e.stopPropagation()}
            className="relative flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-studio-600 bg-studio-900 shadow-2xl outline-none"
          >
            {/* Header */}
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-studio-700 px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ice-50">
                  Avatar picker
                </h2>
                <p className="text-[11px] text-ice-600">
                  Gender, body and head apply to the character instantly — stay
                  motions preview here only.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="grid h-8 w-8 shrink-0 place-items-center rounded-md text-ice-400 transition hover:bg-studio-800 hover:text-ice-50"
              >
                ✕
              </button>
            </div>

            {/* Body: preview canvas + pickers */}
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row">
              {/* Preview canvas */}
              <div className="relative h-[320px] shrink-0 overflow-hidden border-b border-studio-700 bg-studio-950 sm:h-[380px] md:h-auto md:w-[380px] md:border-r md:border-b-0">
                <AvatarPreviewCanvas motion={motion} />
                <div className="pointer-events-none absolute right-2 bottom-2 rounded-md bg-black/45 px-2 py-0.5 font-mono text-[10px] tracking-wide text-ice-300 backdrop-blur-sm">
                  {labelOf(motion)}
                </div>
              </div>

              {/* Pickers */}
              <div className="flex min-w-0 flex-1 flex-col gap-3 p-4">
                <GenderRow />

                <div className="flex flex-col gap-2">
                  <RowLabel>Body</RowLabel>
                  <ChipRow kind="body" />
                </div>

                <div className="flex flex-col gap-2">
                  <RowLabel>Head</RowLabel>
                  <ChipRow kind="face" />
                </div>

                <div className="flex flex-col gap-2">
                  <RowLabel hint="preview only">Stay motion</RowLabel>
                  <div className="flex flex-wrap gap-0.5 rounded-md border border-studio-700 bg-studio-900/60 p-0.5">
                    {STAY_MOTIONS.map((m) => (
                      <Chip
                        key={m.name}
                        on={motion === m.name}
                        onClick={() => setMotion(m.name)}
                      >
                        {labelOf(m.name)}
                      </Chip>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Small uppercase section label for a picker row. */
function RowLabel({ children, hint }: { children: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-[10px] font-semibold tracking-[0.28em] text-text-muted uppercase">
        {children}
      </span>
      {hint ? (
        <span className="text-[10px] text-ice-600">{hint}</span>
      ) : null}
    </div>
  );
}

/** Male / Female segmented toggle — live-swaps the whole body+head set. */
function GenderRow() {
  const gender = useAvatarStore((s) => s.gender);
  const setGender = useAvatarStore((s) => s.setGender);
  return (
    <div className="flex flex-col gap-2">
      <RowLabel>Gender</RowLabel>
      <div className="grid grid-cols-2 gap-1 rounded-lg border border-studio-700 bg-studio-900/60 p-1">
        {(["male", "female"] as const).map((value) => {
          const active = gender === value;
          return (
            <button
              key={value}
              type="button"
              onClick={() => setGender(value)}
              aria-pressed={active}
              className={`rounded-md px-2 py-1.5 text-[11px] font-semibold capitalize transition ${
                active
                  ? "bg-tiffany-400/15 text-tiffany-200 ring-1 ring-tiffany-400/40"
                  : "text-ice-400 hover:text-ice-200"
              }`}
            >
              {value}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Body / Head remix chips within the active gender pool (live-applied). */
function ChipRow({ kind }: { kind: PartKind }) {
  const gender = useAvatarStore((s) => s.gender);
  const url = useAvatarStore((s) =>
    kind === "body" ? s.assets.body : s.assets.face,
  );
  const setAsset = useAvatarStore((s) => s.setAsset);

  const variants = partsFor(gender, kind);
  if (variants.length <= 1) return null;
  const active = variantForUrl(gender, kind, url);

  return (
    <div className="flex flex-wrap gap-0.5 rounded-md border border-studio-700 bg-studio-900/60 p-0.5">
      {variants.map((v) => (
        <Chip
          key={v.id}
          on={active?.id === v.id}
          onClick={() => setAsset(kind, v.url)}
        >
          {v.label}
        </Chip>
      ))}
    </div>
  );
}
