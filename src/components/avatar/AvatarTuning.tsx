import { useEffect, useRef, useState } from "react";
import {
  basenameOf,
  partsFor,
  variantForUrl,
} from "../../b3/b3-runtime/src/components/AvatarSDK";
import type { PartKind } from "../../b3/b3-runtime/src/components/AvatarSDK";
import {
  LOCOMOTION_STATES,
  RIG_STATE_CANDIDATES,
  useAvatarStore,
} from "./useAvatarStore";
import type { Axis, OffsetKey } from "./useAvatarStore";
import { Chip, MONO, Section, SliderRow, SUB, ToggleRow } from "./panel";

/**
 * Avatar-tuning sidebar for the DevPage nav-rig: two tabs only (Character +
 * Motion — no stage lighting). Every control writes straight into the avatar
 * store, which NavMeshRig consumes live, so the walker retunes in real time.
 *
 * Character  — body/head remix, head-insert + body-placement offsets, mesh
 *              layers, and manifest import/export.
 * Motion     — which `/char/motion-2/fbx/stay` clip feeds each of the rig's
 *              four locomotion states (idle / walk / run / jump) + playback.
 */

/** A remix picker for one body/head part slot (shown when >1 variant exists). */
function PartRow({ title, kind }: { title: string; kind: PartKind }) {
  const gender = useAvatarStore((s) => s.gender);
  const url = useAvatarStore((s) =>
    kind === "body" ? s.assets.body : s.assets.face,
  );
  const setAsset = useAvatarStore((s) => s.setAsset);

  const variants = partsFor(gender, kind);
  if (variants.length <= 1) return null;
  const active = variantForUrl(gender, kind, url);

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[12px] text-ice-200">{title}</span>
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
    </div>
  );
}

type OffsetKind = "head" | "body";

/** Slider ranges for one offset group; body placement gets wider latitude. */
function offsetMeta(kind: OffsetKind, keyName: OffsetKey) {
  if (keyName === "rotation") return { min: -180, max: 180, step: 1, dec: 0 };
  if (kind === "head") {
    return keyName === "position"
      ? { min: -0.4, max: 0.4, step: 0.005, dec: 3 }
      : { min: 0.02, max: 1.6, step: 0.01, dec: 3 };
  }
  return keyName === "position"
    ? { min: -2, max: 2, step: 0.005, dec: 3 }
    : { min: 0.1, max: 2, step: 0.01, dec: 3 };
}

function OffsetGroup({
  title,
  keyName,
  kind,
}: {
  title: string;
  keyName: OffsetKey;
  kind: OffsetKind;
}) {
  const group = useAvatarStore((s) => (kind === "head" ? s.head : s.body)[keyName]);
  const setAxis = useAvatarStore((s) =>
    kind === "head" ? s.setHeadAxis : s.setBodyAxis,
  );
  const meta = offsetMeta(kind, keyName);

  return (
    <div className="rounded-lg border border-studio-700 bg-studio-900/60 px-2.5 py-2">
      <p className={`${SUB} mb-1.5`}>{title}</p>
      <div className="flex flex-col gap-1.5">
        {(["X", "Y", "Z"] as const).map((axis, i) => (
          <SliderRow
            key={axis}
            label={axis}
            min={meta.min}
            max={meta.max}
            step={meta.step}
            value={group[i]}
            decimals={meta.dec}
            onChange={(v) => setAxis(keyName, i as Axis, v)}
          />
        ))}
      </div>
    </div>
  );
}

export function AvatarTuning() {
  const [tab, setTab] = useState<"character" | "motion">("character");

  const name = useAvatarStore((s) => s.name);
  const assets = useAvatarStore((s) => s.assets);
  const detectedBone = useAvatarStore((s) => s.detectedBone);
  const playing = useAvatarStore((s) => s.playing);
  const speed = useAvatarStore((s) => s.speed);
  const notice = useAvatarStore((s) => s.notice);
  const rigClips = useAvatarStore((s) => s.rigClips);

  const setName = useAvatarStore((s) => s.setName);
  const setPlaying = useAvatarStore((s) => s.setPlaying);
  const setSpeed = useAvatarStore((s) => s.setSpeed);
  const setRigClip = useAvatarStore((s) => s.setRigClip);
  const setNotice = useAvatarStore((s) => s.setNotice);
  const exportManifest = useAvatarStore((s) => s.exportManifest);
  const copyManifest = useAvatarStore((s) => s.copyManifest);
  const importFromText = useAvatarStore((s) => s.importFromText);
  const importFromUrl = useAvatarStore((s) => s.importFromUrl);
  const resetAll = useAvatarStore((s) => s.resetAll);
  const pickManifestDir = useAvatarStore((s) => s.pickManifestDir);
  const writeManifestFile = useAvatarStore((s) => s.writeManifestFile);
  const exportDirName = useAvatarStore((s) => s.exportDirName);

  const fileRef = useRef<HTMLInputElement>(null);
  const [importUrl, setImportUrl] = useState("/char/avatar.manifest.json");

  // Auto-dismiss transient notices.
  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(id);
  }, [notice, setNotice]);

  return (
    <aside className="flex h-full w-full flex-col overflow-hidden bg-studio-900 text-ice-200">
      {/* tab switcher: character · motion */}
      <div className="flex shrink-0 gap-1 border-b border-studio-700 px-3 py-2">
        {(["character", "motion"] as const).map((value) => {
          const active = tab === value;
          return (
            <button
              key={value}
              onClick={() => setTab(value)}
              aria-pressed={active}
              className={`rounded-md px-3 py-1 text-[11px] font-semibold capitalize transition ${
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

      {tab === "motion" ? (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
          <Section
            title="Locomotion clips"
            hint="stay library"
          >
            <p className="text-[10px] leading-relaxed text-ice-600">
              Pick which{" "}
              <span className="font-mono text-ice-400">
                /char/motion-2/fbx/stay
              </span>{" "}
              clip feeds each rig state. The walking character crossfades these
              as it moves.
            </p>
            {LOCOMOTION_STATES.map((state) => (
              <div key={state} className="flex flex-col gap-1">
                <span className="text-[10px] font-medium tracking-wider text-ice-400 uppercase">
                  {state}
                </span>
                <div className="flex flex-wrap gap-0.5 rounded-md border border-studio-700 bg-studio-900/60 p-0.5">
                  {(RIG_STATE_CANDIDATES[state] ?? []).map((clipName) => (
                    <Chip
                      key={clipName}
                      on={rigClips[state]?.name === clipName}
                      onClick={() => setRigClip(state, clipName)}
                    >
                      {clipName}
                    </Chip>
                  ))}
                </div>
              </div>
            ))}
          </Section>

          <Section title="Playback" hint="character-wide">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPlaying(!playing)}
                className="grid h-8 w-8 place-items-center rounded-md bg-tiffany-400/15 text-[11px] text-tiffany-200 ring-1 ring-tiffany-400/40 transition hover:bg-tiffany-400/25"
                aria-label={playing ? "Pause" : "Play"}
                title={playing ? "Pause the character" : "Play the character"}
              >
                {playing ? "❚❚" : "▶"}
              </button>
              <label className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="shrink-0 text-[10px] tracking-wider text-ice-400 uppercase">
                  ×{speed.toFixed(2)}
                </span>
                <input
                  type="range"
                  min={0.1}
                  max={2}
                  step={0.05}
                  value={speed}
                  onChange={(e) => setSpeed(Number(e.target.value))}
                  className="h-1 min-w-0 flex-1 cursor-ew-resize accent-tiffany-400"
                />
              </label>
            </div>
          </Section>
        </div>
      ) : (
        <>
          {/* write the current manifest out to a folder as avatar.manifest.json */}
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-studio-700 px-3 py-2">
            <button
              onClick={() => void pickManifestDir()}
              title="Choose the folder where avatar.manifest.json will be written"
              className="rounded-md bg-studio-800 px-2 py-1.5 text-[11px] font-medium text-ice-200 ring-1 ring-studio-700 transition hover:text-ice-50 hover:ring-tiffany-400/40"
            >
              📁 Choose folder
            </button>
            <button
              onClick={() => void writeManifestFile()}
              disabled={!exportDirName}
              title="Write the current manifest as avatar.manifest.json into the chosen folder"
              className={`rounded-md px-2 py-1.5 text-[11px] font-medium ring-1 transition ${
                exportDirName
                  ? "bg-tiffany-400/15 text-tiffany-200 ring-tiffany-400/30 hover:bg-tiffany-400/25"
                  : "cursor-not-allowed bg-studio-800 text-ice-600 ring-studio-700"
              }`}
            >
              💾 Write avatar.manifest.json
            </button>
            {exportDirName ? (
              <span className="min-w-0 truncate text-[10px] tracking-wide text-ice-400">
                → {exportDirName}
              </span>
            ) : null}
          </div>

          {/* header */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-studio-700 px-4 py-3">
            <div className="min-w-0">
              <p className={SUB}>Avatar</p>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-0.5 w-full bg-transparent text-sm font-semibold text-ice-50 outline-none"
                aria-label="Avatar name"
              />
            </div>
            <span className="shrink-0 rounded-full border border-studio-700 bg-studio-800 px-2 py-0.5 text-[10px] tracking-wider text-ice-400">
              {basenameOf(assets.body)}
            </span>
          </div>

          <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3">
            <Section title="Character">
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-studio-700 bg-studio-900/60 p-1">
                {(["male", "female"] as const).map((value) => (
                  <GenderButton key={value} value={value} />
                ))}
              </div>
              <PartRow title="Body" kind="body" />
              <PartRow title="Head" kind="face" />
            </Section>

            <Section
              title="Head insert"
              hint={`${detectedBone ?? "auto"} · pos m / rot ° / scl ×`}
            >
              <OffsetGroup keyName="position" title="Position offset" kind="head" />
              <OffsetGroup keyName="rotation" title="Rotation offset" kind="head" />
              <OffsetGroup keyName="scale" title="Scale offset" kind="head" />
              <ResetButton label="Reset head" reset={() => useAvatarStore.getState().resetHead()} />
              <p className="text-[10px] leading-relaxed text-ice-600">
                Body &amp; head offsets are remembered per body × head pairing —
                switching either part recalls that combination's own tune.
              </p>
            </Section>

            <Section title="Body placement" hint="pos m / rot ° / scl ×">
              <OffsetGroup keyName="position" title="Position offset" kind="body" />
              <OffsetGroup keyName="rotation" title="Rotation offset" kind="body" />
              <OffsetGroup keyName="scale" title="Scale offset" kind="body" />
              <ResetButton label="Reset body" reset={() => useAvatarStore.getState().resetBody()} />
              <p className="text-[10px] leading-relaxed text-ice-600">
                Placement of the body on its motion root. Rigs export lying along
                +Z, so combos default to a −90° X rotation (the upright home).
              </p>
            </Section>

            <Section title="Layers">
              <LayersRow />
              <p className="text-[10px] leading-relaxed text-ice-600">
                Toggle which meshes of the composed avatar are drawn.
              </p>
            </Section>

            <Section title="Manifest">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={exportManifest}
                  className="rounded-md bg-tiffany-400/15 px-2 py-1.5 text-[11px] font-medium text-tiffany-200 ring-1 ring-tiffany-400/30 transition hover:bg-tiffany-400/25"
                >
                  ⤓ Export JSON
                </button>
                <button
                  onClick={copyManifest}
                  title="Copy the manifest JSON to the clipboard"
                  className="rounded-md bg-tiffany-400/15 px-2 py-1.5 text-[11px] font-medium text-tiffany-200 ring-1 ring-tiffany-400/30 transition hover:bg-tiffany-400/25"
                >
                  ⧉ Copy JSON
                </button>
              </div>
              <button
                onClick={() => fileRef.current?.click()}
                className="rounded-md bg-studio-800 px-2 py-1.5 text-[11px] font-medium text-ice-200 ring-1 ring-studio-700 transition hover:text-ice-50"
              >
                ⤒ Import file
              </button>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  placeholder="/char/avatar.manifest.json"
                  className={`${MONO} min-w-0 flex-1 rounded-md border border-studio-700 bg-studio-900/60 px-2 py-1.5 outline-none placeholder:text-ice-600 focus:border-tiffany-400/40`}
                />
                <button
                  onClick={() => void importFromUrl(importUrl)}
                  className="rounded-md border border-studio-700 px-2 py-1.5 text-[11px] text-ice-400 transition hover:border-tiffany-400/40 hover:text-ice-200"
                >
                  Load
                </button>
              </div>
              <button
                onClick={resetAll}
                className="self-start text-[10px] tracking-wider text-ice-600 uppercase transition hover:text-ice-400"
              >
                Reset all to defaults
              </button>

              {notice ? (
                <p className="rounded-md border border-studio-700 bg-studio-900/60 px-2 py-1.5 text-[11px] text-ice-400">
                  {notice}
                </p>
              ) : null}

              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    importFromText(String(reader.result ?? ""));
                  };
                  reader.readAsText(file);
                  e.target.value = "";
                }}
              />
            </Section>
          </div>
        </>
      )}
    </aside>
  );
}

/** Small in-file helpers that keep their own store subscriptions. */
function GenderButton({ value }: { value: "male" | "female" }) {
  const gender = useAvatarStore((s) => s.gender);
  const setGender = useAvatarStore((s) => s.setGender);
  const active = gender === value;
  return (
    <button
      onClick={() => setGender(value)}
      className={`rounded-md px-2 py-1.5 text-[11px] font-semibold capitalize transition ${
        active
          ? "bg-tiffany-400/15 text-tiffany-200 ring-1 ring-tiffany-400/40"
          : "text-ice-400 hover:text-ice-200"
      }`}
    >
      {value}
    </button>
  );
}

function ResetButton({ label, reset }: { label: string; reset: () => void }) {
  return (
    <button
      onClick={reset}
      className="self-start rounded-md border border-studio-700 px-2 py-1 text-[11px] text-ice-400 transition hover:border-tiffany-400/40 hover:text-ice-200"
    >
      {label}
    </button>
  );
}

function LayersRow() {
  const bodyVisible = useAvatarStore((s) => s.bodyVisible);
  const faceVisible = useAvatarStore((s) => s.faceVisible);
  const toggleBody = useAvatarStore((s) => s.toggleBody);
  const toggleFace = useAvatarStore((s) => s.toggleFace);
  return (
    <>
      <ToggleRow label="Body mesh" on={bodyVisible} onToggle={toggleBody} />
      <ToggleRow label="Face mesh" on={faceVisible} onToggle={toggleFace} />
    </>
  );
}
