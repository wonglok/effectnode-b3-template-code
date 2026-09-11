import { useAvatarStore } from './useAvatarStore'
import { MONO, Section, SliderRow, SUB, ToggleRow } from './panel'

/**
 * Weapon tab of the DevPage sidebar — the prop the NPC crowd carries.
 *
 * This edits the **avatar manifest**, not the nav-rig store: which model, which
 * hand and how it sits are facts about the character, so they belong with the
 * rest of the character's data and round-trip through export/import like
 * `motion.clips` does. The rig mirrors the active entry into the crowd, which
 * re-poses every gun the frame after a slider moves.
 *
 * The gun hangs off a hand bone, so this is *placement*, not animation: the
 * offset is a nudge off the grip in centimetres, read in the avatar's own axes
 * — the frame the barrel alignment targets — which is why the same numbers read
 * the same way on every NPC whatever pose it is in.
 *
 * `url` and `bone` are shown read-only, and deliberately so. They are baked into
 * every avatar at load, so changing either forces the crowd to rebuild; the
 * manifest is the place to edit them, where loading one already implies a fresh
 * crowd.
 */

/**
 * Placement nudge range, in **centimetres** — the rig's own unit, normalised so
 * it means the same distance on any body. ±25 cm covers seating a prop in a hand
 * with room to find it again if the offset is dialled somewhere silly; the
 * number field still takes an exact value for anything finer than the step.
 */
const OFFSET_LIMIT = 25
const OFFSET_STEP = 0.1

/** The entry the tab edits — the same one the crowd draws (see `pickWeapon`). */
const useActiveWeapon = () => useAvatarStore((s) => s.weapons.find((w) => w.enabled) ?? s.weapons[0] ?? null)

export function WeaponTuning() {
    const weapon = useActiveWeapon()
    const setWeaponField = useAvatarStore((s) => s.setWeaponField)

    if (!weapon) {
        return (
            <div className='flex flex-1 flex-col gap-3 overflow-y-auto p-3'>
                <Section title='Gun Offset' hint='NPC crowd'>
                    <p className={`${SUB} leading-relaxed`}>
                        This avatar&apos;s manifest lists no weapons, so the crowd carries none. Add a{' '}
                        <span className={MONO}>weapons</span> entry to the manifest and load it.
                    </p>
                </Section>
            </div>
        )
    }

    const setOffset = (axis: 0 | 1 | 2, value: number) => {
        const offset = [...weapon.offset] as [number, number, number]
        offset[axis] = value
        setWeaponField(weapon.id, { offset })
    }
    const setRotation = (axis: 0 | 1 | 2, value: number) => {
        const rotation = [...weapon.rotation] as [number, number, number]
        rotation[axis] = value
        setWeaponField(weapon.id, { rotation })
    }

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
                    on={weapon.enabled}
                    onToggle={() => setWeaponField(weapon.id, { enabled: !weapon.enabled })}
                />

                <div className='mt-1 flex flex-col gap-1.5'>
                    {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                        <SliderRow
                            key={axis}
                            label={`Off ${axis}`}
                            min={-OFFSET_LIMIT}
                            max={OFFSET_LIMIT}
                            step={OFFSET_STEP}
                            value={weapon.offset[i]}
                            decimals={2}
                            onChange={(v) => setOffset(i as 0 | 1 | 2, v)}
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
                    {(['X', 'Y', 'Z'] as const).map((axis, i) => (
                        <SliderRow
                            key={axis}
                            label={`Rot ${axis}`}
                            min={-180}
                            max={180}
                            step={1}
                            value={weapon.rotation[i]}
                            decimals={0}
                            onChange={(v) => setRotation(i as 0 | 1 | 2, v)}
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
                    value={weapon.scale}
                    decimals={2}
                    onChange={(v) => setWeaponField(weapon.id, { scale: v })}
                />
                <p className={`${SUB} leading-relaxed`}>
                    The model is about 1 m long, drawn against a ~1.7 m avatar. The value is a real-world length — the
                    skeleton&apos;s own centimetre scale is divided out for you.
                </p>
            </Section>

            <Section title='Weapon asset'>
                <div className='flex flex-col gap-1'>
                    {(
                        [
                            ['Id', weapon.id],
                            ['Name', weapon.name],
                            ['Model', weapon.url],
                            ['Bone', weapon.bone],
                        ] as const
                    ).map(([label, value]) => (
                        <div key={label} className='flex items-baseline justify-between gap-2'>
                            <span className={`${SUB} shrink-0`}>{label}</span>
                            <span className={`${MONO} truncate`} title={value}>
                                {value}
                            </span>
                        </div>
                    ))}
                </div>
                <p className={`${SUB} leading-relaxed`}>
                    Saved with the avatar manifest. The model and bone are set there rather than here because every NPC
                    bakes them in when its avatar loads — load a manifest with a different one and the crowd rebuilds.
                </p>
            </Section>
        </div>
    )
}
