'use client'

import { useNavRigStore } from '../b3/b3-runtime/src/components/stores/navRigStore'

/**
 * The player's health, as a HUD element.
 *
 * There is already a health bar floating above the player's avatar — this is the
 * same number a second time, on purpose. The camera trails the player from
 * behind at a distance the user controls, so a head-mounted bar sits small in
 * the middle of the scene and disappears entirely behind the avatar or a wall at
 * close range. The HUD is the copy that is always readable.
 *
 * Styled as a pill matching the Walk/Run and Peace/Attack controls it docks
 * above, so the bottom-left column reads as one group of player controls.
 */
export function HealthHud() {
    const hp = useNavRigStore((s) => s.playerHp)
    const maxHp = useNavRigStore((s) => s.settings.maxHp)

    const max = Math.max(1, maxHp)
    const fraction = Math.max(0, Math.min(1, hp / max))
    const down = hp <= 0

    return (
        <div className='pointer-events-none absolute bottom-[13.5rem] left-6 z-40 select-none'>
            <div className='pointer-events-auto flex w-[132px] flex-col gap-1 rounded-2xl border border-tiffany-400/25 bg-studio-900/80 px-3 py-2 shadow-[0_6px_18px_rgba(0,0,0,0.4)] backdrop-blur-sm'>
                <div className='flex items-baseline justify-between'>
                    <span className='text-[10px] font-semibold uppercase tracking-wider text-ice-600'>
                        {down ? 'Down' : 'Health'}
                    </span>
                    <span className='text-[11px] font-semibold tabular-nums text-ice-200'>
                        {hp}
                        <span className='text-ice-600'>/{max}</span>
                    </span>
                </div>
                {/* The track is the same pillar shape as the floating bars, so the
                    two readings of the same number look like the same thing. */}
                <div className='h-2 w-full overflow-hidden rounded-full bg-studio-950'>
                    <div
                        role='progressbar'
                        aria-valuenow={hp}
                        aria-valuemin={0}
                        aria-valuemax={max}
                        aria-label='Player health'
                        className={[
                            'h-full rounded-full transition-[width] duration-200 ease-out',
                            fraction > 0.5
                                ? 'bg-tiffany-400'
                                : fraction > 0.25
                                  ? 'bg-amber-400'
                                  : 'bg-red-500',
                        ].join(' ')}
                        style={{ width: `${fraction * 100}%` }}
                    />
                </div>
            </div>
        </div>
    )
}
