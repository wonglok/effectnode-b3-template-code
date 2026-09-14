'use client'

import { useNavRigStore } from '../b3/b3-runtime/src/components/stores/navRigStore'

/**
 * Bottom-left Peaceful/Attack toggle — the touch equivalent of the X key.
 *
 * Switches the whole scene's combat state in one write: the nav rig store's
 * `attackMode` flag drives the player's gun and clip set from NavMeshRig's
 * subscription, and the crowd reads the same flag every frame through its
 * `getHostile` getter. So there is exactly one source of truth, and a phone —
 * which has no keyboard — gets the same toggle as a desktop.
 *
 * Rendered as a fixed overlay (absolute) docked to the bottom-left of the 3D
 * canvas, stacked above the Walk/Run pill to keep that column reading as one.
 */
export function AttackModeButton() {
    const attackMode = useNavRigStore((s) => s.attackMode)
    const setAttackMode = useNavRigStore((s) => s.setAttackMode)

    const segment = (active: boolean, label: string, turnOn: boolean, title: string) => (
        <button
            type='button'
            aria-pressed={active}
            title={title}
            onClick={() => setAttackMode(turnOn)}
            className={[
                // flex-1 splits the pill 50/50; width is shared with the Run and
                // Jump buttons (all pinned to the same fixed `w-[132px]`) so the
                // bottom-left dock lines up as one clean column.
                'pointer-events-auto flex h-8 flex-1 items-center justify-center rounded-full',
                'text-[11px] font-semibold uppercase tracking-wider',
                'transition-colors duration-150',
                active
                    ? 'bg-tiffany-400 text-studio-950 shadow-[0_2px_10px_rgba(129,216,208,0.45)]'
                    : 'text-ice-600 hover:text-ice-200',
            ].join(' ')}
        >
            {label}
        </button>
    )

    return (
        <div className='pointer-events-none absolute bottom-40 left-6 z-40 select-none'>
            {/* Segmented pill: the lit segment shows the current combat mode. */}
            <div className='pointer-events-auto flex w-[132px] items-center gap-0.5 rounded-full border border-tiffany-400/25 bg-studio-900/80 p-1 shadow-[0_6px_18px_rgba(0,0,0,0.4)] backdrop-blur-sm'>
                {segment(!attackMode, 'Peace', false, 'Peaceful — the crowd ignores you (X)')}
                {segment(attackMode, 'Attack', true, 'Attack — draw a gun and shoot the crowd (X)')}
            </div>
        </div>
    )
}
