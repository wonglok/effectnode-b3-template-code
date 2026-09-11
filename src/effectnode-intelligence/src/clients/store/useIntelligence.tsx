import { io, Socket } from 'socket.io-client'
import { create } from 'zustand'
import { PROTOCOL_VERSION } from '../../protocol'

type IntelligenceStore = {
    socket: null | Socket
    makeSocket: () => () => void
}

export const useIntelligence = create<IntelligenceStore>((set) => {
    return {
        socket: null,
        makeSocket: () => {
            const socket = io({
                withCredentials: true,
                // The server refuses a mismatch outright. Without this, a stale
                // bundle listening for an old event name fails silently — every
                // request would hang until the 15s timeout with no explanation.
                auth: { protocol: PROTOCOL_VERSION },
            })

            socket.on('connect', () => console.log('[intelligence] connected', socket.id))
            socket.on('connect_error', (error) => {
                console.warn('[intelligence] connect error:', error.message)
            })
            socket.on('protocol-mismatch', (info) => {
                console.error(
                    '[intelligence] the backend speaks a different protocol version — reload the page.',
                    info,
                )
            })

            set({ socket })

            return () => {
                socket.disconnect()
                // Clear the store rather than leaving it pointing at a socket
                // that is already disconnected.
                set((state) => (state.socket === socket ? { socket: null } : state))
            }
        },
    }
})
