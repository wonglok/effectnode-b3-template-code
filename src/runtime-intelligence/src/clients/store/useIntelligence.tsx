import { io, Socket } from 'socket.io-client'
import { create } from 'zustand'
import { EDITOR_HELLO, PROTOCOL_VERSION } from '../../protocol'
import { getEditorIdentity } from '../deviceIdentity'

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

            // Announce this tab so the server can label its answers and address
            // it with `?editor=`. Registered on the `connect` event rather than
            // sent once here, because socket.io reuses the Socket object across
            // reconnects and only reassigns `socket.id` — a hello emitted at
            // construction would be lost on the first reconnect. The server
            // upserts, so re-sends are harmless.
            socket.on('connect', () => {
                console.log('[intelligence] connected', socket.id)
                const identity = getEditorIdentity()
                socket.emit(EDITOR_HELLO, identity)
            })
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
