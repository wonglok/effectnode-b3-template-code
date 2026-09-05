"use client";

import {
  useNavRigStore,
  type EmotionDef,
} from "../../b3/b3-runtime/src/components/stores/navRigStore";
import { EMOTION_GROUPS } from "./emotionCatalog";
import { Section } from "./panel";

/**
 * Emotion tester tab for the DevPage sidebar.
 *
 * Lists every one-shot clip across the `/char/motion-2/fbx` emotion libraries
 * (pro-magic · breakdance · gesture · gun · longbow · shooter) grouped by
 * folder. Clicking an item plays it once on the walking character through the
 * exact same store → NavMeshRig → AvatarRig path as the on-screen emotion
 * buttons, then the rig returns to idle.
 */
export function EmotionTester() {
  const lastId = useNavRigStore((s) => s.emotionRequest?.def?.id);

  const fire = (def: EmotionDef) =>
    useNavRigStore.getState().requestEmotion(def);

  return (
    <div className="flex flex-1 flex-col overflow-y-auto p-3">
      <p className="mb-3 text-[10px] leading-relaxed text-ice-600">
        Play any clip once — the character performs it in place, then settles
        back to idle. Same engine as the on-screen emotion buttons.
      </p>

      {EMOTION_GROUPS.map((group) => (
        <Section key={group.folder} title={group.title}>
          <div className="flex flex-col gap-0.5">
            {group.items.map((def) => {
              const active = lastId === def.id;
              return (
                <button
                  key={def.id}
                  type="button"
                  onClick={() => fire(def)}
                  title={`${def.label} — play once`}
                  className={[
                    "flex items-center gap-2 rounded-md px-2 py-1 text-left transition",
                    "text-[11px]",
                    active
                      ? "bg-tiffany-400/15 font-medium text-tiffany-200 ring-1 ring-tiffany-400/40"
                      : "text-ice-400 hover:bg-studio-800 hover:text-ice-200",
                  ].join(" ")}
                >
                  <span className="shrink-0 opacity-70" aria-hidden>
                    ▶
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px]">
                    {def.label}
                  </span>
                </button>
              );
            })}
          </div>
        </Section>
      ))}
    </div>
  );
}
