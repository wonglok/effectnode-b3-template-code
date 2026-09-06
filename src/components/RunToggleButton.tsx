'use client'

import { useNavRigStore } from '../b3/b3-runtime/src/components/stores/navRigStore'

/**
 * Bottom-left Walk/Run toggle.
 *
 * Switches the character's base locomotion between `walkingSpeed` (default)
 * and `runningSpeed`. Tapping a segment writes the nav rig store's `running`
 * flag; NavMeshRig's frame loop then moves at the run speed exactly as if
 * Shift were held — so it works with WASD, the on-screen joystick and
 * click-to-move alike, and matters most on touch where there is no Shift key.
 *
 * Rendered as a fixed overlay (absolute) docked to the bottom-left of the 3D
 * canvas, stacked just above the Jump button.
 */
export function RunToggleButton() {
    const running = useNavRigStore((s) => s.running)
    const setRunning = useNavRigStore((s) => s.setRunning)

    const segment = (active: boolean, label: string, turnOn: boolean) => (
        <button
            type='button'
            aria-pressed={active}
            title={label}
            onClick={() => setRunning(turnOn)}
            className={[
                'pointer-events-auto flex h-8 items-center justify-center rounded-full',
                'px-3.5 text-[11px] font-semibold uppercase tracking-wider',
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
        <div className='pointer-events-none absolute bottom-24 left-6 z-40 select-none'>
            {/* Segmented pill: the lit segment shows the current movement mode */}
            <div className='pointer-events-auto flex items-center gap-0.5 rounded-full border border-tiffany-400/25 bg-studio-900/80 p-1 shadow-[0_6px_18px_rgba(0,0,0,0.4)] backdrop-blur-sm'>
                {segment(!running, 'Walk', false)}
                {segment(running, 'Run', true)}
            </div>
        </div>
    )
}
