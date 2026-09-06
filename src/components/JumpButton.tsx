'use client'

import { useNavRigStore } from '../b3/b3-runtime/src/components/stores/navRigStore'

/**
 * Bottom-right on-screen jump button.
 *
 * Pressing it fires a single jump request through the nav rig store
 * (`requestJump`, nonce advances each tap). NavMeshRig consumes the request once
 * per nonce in its frame loop — identical to pressing Space — so the jump only
 * happens while grounded and not mid-gesture. Rendered as a fixed overlay so it
 * floats above the 3D canvas on whichever page mounts it.
 */
export function JumpButton() {
    const jump = () => useNavRigStore.getState().requestJump()

    return (
        <div className='pointer-events-none absolute bottom-6 left-6 z-40 select-none'>
            <button
                type='button'
                aria-label='Jump'
                title='Jump (Space)'
                onPointerDown={jump}
                className='pointer-events-auto flex h-14 w-[132px] touch-none items-center justify-center rounded-full border border-tiffany-400/30 bg-studio-900/80 text-tiffany-300 shadow-[0_6px_18px_rgba(0,0,0,0.4)] backdrop-blur-sm transition hover:scale-105 hover:border-tiffany-300 hover:text-white active:scale-95'
            >
                {/* Upward arrow — reads as "jump up" at a glance */}
                <svg
                    viewBox='0 0 24 24'
                    fill='none'
                    stroke='currentColor'
                    strokeWidth='2.2'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                    className='h-7 w-7'
                    aria-hidden='true'
                >
                    <path d='M12 19V6' />
                    <path d='m5 12 7-7 7 7' />
                </svg>
            </button>
        </div>
    )
}
