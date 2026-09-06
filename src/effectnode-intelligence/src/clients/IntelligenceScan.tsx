import { useEffect } from 'react'
import { useIntelligence } from './store/useIntelligence'
import { useThree } from '@react-three/fiber'

export function IntelligenceScan() {
    const makeSocket = useIntelligence((r) => r.makeSocket)
    const socket = useIntelligence((r) => r.socket)
    const scene = useThree((r) => r.scene)

    useEffect(() => {
        return makeSocket()
    }, [])

    useEffect(() => {
        if (!socket) {
            return
        }

        socket.on('req:scene', (arg) => {
            console.log(arg)

            // TEMP DIAGNOSTIC
            try {
                const json = scene.toJSON()
                const raw = JSON.stringify(json)
                console.log('[scene json bytes]', raw.length, 'connected:', socket.connected)
                const ok = socket.emit(arg?.reqID, json)
                console.log('[emit returned]', ok)
            } catch (err) {
                console.error('[emit failed]', err)
            }
        })

        //
    }, [socket])

    return <></>
}
