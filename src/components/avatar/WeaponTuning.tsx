import { useNavRigStore } from '../../b3/b3-runtime/src/components/stores/navRigStore'
import { MONO, Section, SliderRow, SUB, ToggleRow } from './panel'

/**
 * Weapon tab of the DevPage sidebar — the water gun the NPC crowd carries.
 *
 * Every control writes through `patchSettings`, which mutates the shared
 * settings object in place. That is not a shortcut: the nav rig captures that
 * object once at mount and hands it to the crowd as its per-frame tunables, so
 * replacing it (as the plain `set` does) would leave the running crowd reading
 * a detached copy and the sliders would appear to do nothing until a respawn.
 *
 * The gun hangs off the hand bone, so this is *placement*, not animation: the
 * offset is a nudge off the grip in centimetres, read in the avatar's own axes
 * — the frame the barrel alignment targets — which is why the same numbers
 * read the same way on every NPC whatever pose it is in.
 */

/**
 * Placement nudge range, in **centimetres** (see `GunTuning.offX` — the rig's
 * own unit, normalised so it means the same distance on any body). ±10 cm is
 * the working range for seating a gun in a hand; the number field still takes
 * an exact value for anything finer than the 1 mm step.
 */
const OFFSET_LIMIT = 25
const OFFSET_STEP = 0.1

export function WeaponTuning() {
    // Subscribe to the revision so an in-place write re-runs the selectors below.
    useNavRigStore((s) => s.revision)
    const settings = useNavRigStore((s) => s.settings)
    const patchSettings = useNavRigStore((s) => s.patchSettings)

    return (
        <div className='flex flex-1 flex-col gap-3 overflow-y-auto p-3'>
            <Section title='Gun Offset' hint='NPC crowd'>
                <p className={`${SUB} leading-relaxed`}>
                    Where the water gun sits in the hand, in centimetres off the grip. <span className={MONO}>X</span>{' '}
                    is the character&apos;s left/right, <span className={MONO}>Y</span> up,{' '}
                    <span className={MONO}>Z</span> forward. Applies live to every armed NPC.
                </p>

                <ToggleRow
                    label='Water gun'
                    on={settings.npcGunEnabled}
                    onToggle={() => patchSettings({ npcGunEnabled: !settings.npcGunEnabled })}
                />

                <div className='mt-1 flex flex-col gap-1.5'>
                    {(['X', 'Y', 'Z'] as const).map((axis) => (
                        <SliderRow
                            key={axis}
                            label={`Off ${axis}`}
                            min={-OFFSET_LIMIT}
                            max={OFFSET_LIMIT}
                            step={OFFSET_STEP}
                            value={
                                axis === 'X'
                                    ? settings.npcGunOffX
                                    : axis === 'Y'
                                      ? settings.npcGunOffY
                                      : settings.npcGunOffZ
                            }
                            decimals={2}
                            onChange={(v) =>
                                patchSettings(
                                    axis === 'X'
                                        ? { npcGunOffX: v }
                                        : axis === 'Y'
                                          ? { npcGunOffY: v }
                                          : { npcGunOffZ: v },
                                )
                            }
                        />
                    ))}
                </div>
            </Section>

            <Section title='Gun Rotation' hint='degrees'>
                <p className={`${SUB} leading-relaxed`}>
                    Nudge on top of the computed alignment, which already cancels the hand bone&apos;s frame so the
                    barrel follows the character&apos;s forward.
                </p>
                <div className='flex flex-col gap-1.5'>
                    {(['X', 'Y', 'Z'] as const).map((axis) => (
                        <SliderRow
                            key={axis}
                            label={`Rot ${axis}`}
                            min={-180}
                            max={180}
                            step={1}
                            value={
                                axis === 'X'
                                    ? settings.npcGunRotX
                                    : axis === 'Y'
                                      ? settings.npcGunRotY
                                      : settings.npcGunRotZ
                            }
                            decimals={0}
                            onChange={(v) =>
                                patchSettings(
                                    axis === 'X'
                                        ? { npcGunRotX: v }
                                        : axis === 'Y'
                                          ? { npcGunRotY: v }
                                          : { npcGunRotZ: v },
                                )
                            }
                        />
                    ))}
                </div>
            </Section>

            <Section title='Gun Size' hint='metres'>
                <SliderRow
                    label='Scale'
                    min={0.1}
                    max={1.5}
                    step={0.01}
                    value={settings.npcGunScale}
                    decimals={2}
                    onChange={(v) => patchSettings({ npcGunScale: v })}
                />
                <p className={`${SUB} leading-relaxed`}>
                    The model is about 1 m long, drawn against a ~1.7 m avatar. The value is a real-world length — the
                    skeleton&apos;s own centimetre scale is divided out for you.
                </p>
            </Section>
        </div>
    )
}
