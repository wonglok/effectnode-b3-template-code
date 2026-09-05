"use client";

import { useNavRigStore, type EmotionDef } from "../b3/b3-runtime/src/components/stores/navRigStore";

// ---------------------------------------------------------------------------
// EmotionButtons — one-shot gesture/dance buttons docked around the joystick.
//
// Each button requests a gesture from the shared nav rig store; NavMeshRig
// consumes the request, plays the gesture FBX once on the composed avatar, then
// the rig returns to the idle state. Icons are hand-drawn 24px line SVGs so the
// dock carries no extra icon dependency.
// ---------------------------------------------------------------------------

/** Catalog of the one-shot gestures behind the buttons. Kept in the same
 *  `/char/motion-2/fbx/gesture` library the avatar already animates from, so
 *  the clips remap onto the shared mixamorig skeleton cleanly. */
const GESTURES: EmotionDef[] = [
  {
    id: "happy-hand",
    name: "happy-hand-gesture",
    label: "Happy hand gesture",
    url: "/char/motion-2/fbx/gesture/happy-hand-gesture.fbx",
    startAt: 0.14,
  },
  {
    id: "lengthy-head-nod",
    name: "lengthy-head-nod",
    label: "Lengthy head nod",
    url: "/char/motion-2/fbx/gesture/lengthy-head-nod.fbx",
    startAt: 0.14,
  },
  {
    id: "dismissing-gesture",
    name: "dismissing-gesture",
    label: "Dismissing gesture",
    url: "/char/motion-2/fbx/gesture/dismissing-gesture.fbx",
    startAt: 0.14,
  },
  {
    id: "annoyed-head-shake",
    name: "annoyed-head-shake",
    label: "Annoyed head shake",
    url: "/char/motion-2/fbx/gesture/annoyed-head-shake.fbx",
    startAt: 0.14,
  },
];

/**
 * Button positions around the joystick ring (ring centre is the anchor; the
 * ring radius is ~84px). Each slot is outside the ring (radial ≈ 109–119px) so
 * buttons never sit on top of the drag zone. dy is measured upward from centre.
 */
const SLOTS: ReadonlyArray<{ dx: number; dy: number }> = [
  { dx: -96, dy: 52 },
  { dx: -42, dy: 112 },
  { dx: 42, dy: 112 },
  { dx: 96, dy: 52 },
];

/** Open palm (fingers up) reused by the wave + dismiss icons. */
const HAND_STROKES = [
  "M8.2 12.4V8.4a1.6 1.6 0 0 1 3.2 0v4",
  "M11.4 12.4V6.6a1.6 1.6 0 0 1 3.2 0v5.8",
  "M14.6 12.4V8.7a1.6 1.6 0 0 1 3.2 0v3.7",
  "M17.8 12.4v-1.4a1.6 1.6 0 0 1 3.2 0v1.6",
  "M8.2 12.3c0 3.8 1.5 6.3 4.2 6.3 3 0 4.7-2.7 4.7-5.7",
  "M5.1 13.4 3.3 14a1.8 1.8 0 0 0-.4 3c1.2.9 2.6.9 3.8 0",
];

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function EmotionIcon({ id, className }: { id: string; className?: string }) {
  return (
    <svg {...ICON_PROPS} className={className}>
      {id === "happy-hand" && (
        <>
          {HAND_STROKES.map((d) => (
            <path key={d} d={d} />
          ))}
          {/* wave motion arcs, top-right of the hand */}
          <path d="M20.3 4.6c1.6.3 2.8 1.6 2.9 3.3" />
          <path d="M19.8 8c1 .4 1.7 1.3 1.9 2.4" />
        </>
      )}

      {id === "dismissing-gesture" && (
        <>
          {HAND_STROKES.map((d) => (
            <path key={d} d={d} />
          ))}
          {/* "no / get away" slash across the open palm */}
          <path d="M4.5 20 20 4.5" />
        </>
      )}

      {(id === "lengthy-head-nod" || id === "annoyed-head-shake") && (
        <>
          {/* head + neck + shoulders */}
          <circle cx="10.5" cy="8.5" r="4.6" />
          <path d="M10.5 13.1v1.6" />
          <path d="M6.6 18.2c.5-1.5 2.1-2.2 3.9-2.2s3.4.7 3.9 2.2" />
          {/* eyes + mouth */}
          <path d="M8.8 7.7h1.2" />
          <path d="M11 7.7h1.2" />
          <path
            d={
              id === "annoyed-head-shake"
                ? "M8.2 10.7h4.6" // straight "meh" line while shaking
                : "M8.6 10.2c.6.7 1.5.9 2.4.6 1.2-.4 2.1-.1 2.7.6" // soft smile (nod)
            }
          />
        </>
      )}

      {id === "lengthy-head-nod" && (
        <>
          {/* repeated nod — stacked downward chevrons to the right */}
          <path d="M17 4.4l2.2 2.1-2.2 2.1" />
          <path d="M17 8.6l2.2 2.1-2.2 2.1" />
        </>
      )}

      {id === "annoyed-head-shake" && (
        <>
          {/* annoyed brows */}
          <path d="M6.9 6.9l1.6.3" />
          <path d="M14.1 7.2l1.6-.3" />
          {/* shaking — stacked horizontal arrows to the right */}
          <path d="M16.6 14.4l2.3-2.1-2.3-2.1" />
          <path d="M16.6 18.4l2.3-2.1-2.3-2.1" />
        </>
      )}
    </svg>
  );
}

/**
 * Fixed dock that arcs four emotion buttons around the bottom-centre joystick.
 * Anchored at the joystick ring's centre (the ring sits at bottom ≈104px), with
 * each button absolutely placed in a slot outside the ring.
 */
export function EmotionButtons() {
  const fire = (def: EmotionDef) =>
    useNavRigStore.getState().requestEmotion(def);

  return (
    <div
      className="pointer-events-none fixed left-1/2 z-40"
      style={{ bottom: 104, transform: "translateX(-50%)" }}
    >
      {GESTURES.map((g, i) => {
        const s = SLOTS[i % SLOTS.length];
        return (
          <button
            key={g.id}
            type="button"
            onClick={() => fire(g)}
            title={g.label}
            aria-label={g.label}
            style={{
              left: s.dx,
              top: -s.dy,
              width: 46,
              height: 46,
              transform: "translate(-50%, -50%)",
            }}
            className={[
              "pointer-events-auto absolute flex items-center justify-center rounded-full",
              "border border-tiffany-400/30 bg-studio-900/70 text-tiffany-300",
              "shadow-[0_6px_18px_rgba(0,0,0,0.35)] backdrop-blur-sm",
              "transition-all duration-150",
              "hover:border-tiffany-300 hover:text-white hover:scale-110",
              "active:scale-95 active:border-accent-strong active:text-accent",
            ].join(" ")}
          >
            <EmotionIcon id={g.id} className="h-[24px] w-[24px]" />
          </button>
        );
      })}
    </div>
  );
}
