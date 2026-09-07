import { io, Socket } from 'socket.io-client'
import { create } from 'zustand'

type IntelligenceStore = {
    socket: null | Socket
    makeSocket: () => () => void
}

export const useIntelligence = create<IntelligenceStore>((set) => {
    return {
        socket: null,
        makeSocket: () => {
            let socket = io({
                withCredentials: true,
            })

            socket.on('connected', (data) => {
                console.log(socket.id, 'connected', data)
            })

            set({ socket: socket })

            return () => {
                socket.disconnect()
            }
        },
    }
})
