import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/**
 * Small presentational primitives for the avatar-tuning sidebar, restyled with
 * the effectnode studio/ice/tiffany tokens (dark graphite surfaces + tiffany
 * accent). Counterpart to the mixamo-adapter `panelUi.tsx`.
 */

export const SECTION_TITLE =
  "text-[10px] font-semibold tracking-[0.28em] text-text-muted uppercase";
export const MONO = "font-mono text-[11px] text-ice-200";
export const SUB = "text-[11px] text-ice-400";

const SECTION = "rounded-xl border border-studio-700 bg-surface-secondary/60";

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className={`${SECTION} px-3 py-3`}>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className={SECTION_TITLE}>{title}</h3>
        {hint ? <span className={SUB}>{hint}</span> : null}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

export function ToggleRow({
  label,
  on,
  onToggle,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button onClick={onToggle} className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-ice-200">{label}</span>
      <span
        className={`relative h-4 w-8 rounded-full transition ${
          on ? "bg-tiffany-400/70" : "bg-studio-800 ring-1 ring-studio-700"
        }`}
      >
        <span
          className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
            on ? "left-4.5" : "left-0.5"
          }`}
        />
      </span>
    </button>
  );
}

/**
 * Small editable numeric field.
 * - Type a precise value → Enter / blur commits (clamped to the row range).
 * - Arrow ↑ / ↓ steps by 0.005; holding a key auto-repeats the step.
 * - Escape reverts to the current value.
 */
export function NumberField({
  value,
  min,
  max,
  decimals,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  decimals: number;
  onCommit: (value: number) => void;
}) {
  const STEP = 0.005;
  const [draft, setDraft] = useState<string | null>(null);
  const stepRef = useRef<number | null>(null);
  const [focused, setFocused] = useState(false);

  const formatted = value.toFixed(decimals);
  const clamp = (n: number): number => Math.min(max, Math.max(min, n));

  useEffect(() => {
    if (!focused && draft === null) stepRef.current = null;
  }, [value, focused, draft]);

  const display =
    draft ??
    (stepRef.current !== null ? stepRef.current.toFixed(decimals) : formatted);

  const commitNumber = (n: number): void => {
    const clamped = clamp(n);
    stepRef.current = clamped;
    setDraft(null);
    onCommit(clamped);
  };

  const step = (dir: 1 | -1): void => {
    let base: number;
    if (stepRef.current !== null) {
      base = stepRef.current;
    } else {
      const parsed = Number(draft ?? formatted);
      base = Number.isFinite(parsed) ? parsed : value;
    }
    commitNumber(base + dir * STEP);
  };

  const commitDraft = (): void => {
    const raw = draft;
    setDraft(null);
    stepRef.current = null;
    if (raw === null) return;
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) onCommit(clamp(parsed));
  };

  return (
    <input
      type="text"
      inputMode="decimal"
      value={display}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => {
        setFocused(true);
        e.currentTarget.select();
      }}
      onBlur={() => {
        setFocused(false);
        commitDraft();
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp") {
          e.preventDefault();
          step(1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          step(-1);
        } else if (e.key === "Enter") {
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(null);
          stepRef.current = null;
          e.currentTarget.blur();
        }
      }}
      aria-label="Numeric value"
      title="↑/↓ step by 0.005"
      className={`${MONO} w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 text-right outline-none transition hover:border-studio-700 focus:border-tiffany-400/40 focus:bg-studio-900/70`}
    />
  );
}

export function SliderRow({
  label,
  min,
  max,
  step,
  value,
  onChange,
  decimals,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (value: number) => void;
  decimals: number;
}) {
  return (
    <label className="grid grid-cols-[2rem_1fr_4.4rem] items-center gap-2">
      <span className={`${MONO} text-ice-400`}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1 w-full cursor-ew-resize accent-tiffany-400"
      />
      <NumberField
        value={value}
        min={min}
        max={max}
        decimals={decimals}
        onCommit={onChange}
      />
    </label>
  );
}

/** Reusable "chip" button used across the pickers (parts, clips, states). */
export function Chip({
  on,
  onClick,
  children,
  activeClass,
}: {
  on: boolean;
  onClick: () => void;
  children: ReactNode;
  activeClass?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition ${
        on
          ? activeClass ?? "bg-tiffany-400/15 text-tiffany-200 ring-1 ring-tiffany-400/40"
          : "text-ice-400 hover:text-ice-200"
      }`}
    >
      {children}
    </button>
  );
}
