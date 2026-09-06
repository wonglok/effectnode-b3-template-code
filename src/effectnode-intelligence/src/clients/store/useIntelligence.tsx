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
            let socket = io('http://localhost:4000', {
                withCredentials: true,
            })

            set({ socket: socket })

            return () => {
                socket.disconnect()
            }
        },
        //
    }
})
