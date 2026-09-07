import { useEffect } from 'react'
import { useIntelligence } from './store/useIntelligence'
import { useThree } from '@react-three/fiber'
import { collectSceneGraph } from './collectSceneGraph'

export function IntelligenceScan() {
    const makeSocket = useIntelligence((r) => r.makeSocket)
    const socket = useIntelligence((r) => r.socket)
    const scene = useThree((r) => r.scene)

    useEffect(() => {
        return makeSocket()
    }, [makeSocket])

    useEffect(() => {
        if (!socket) {
            return
        }

        const onReqScene = (arg?: { reqID?: string }) => {
            const reqID = arg?.reqID
            if (!reqID) {
                console.warn('[IntelligenceScan] req:scene missing reqID', arg)
                return
            }
            if (!socket.connected) {
                console.warn('[IntelligenceScan] socket not connected — cannot answer', reqID)
                return
            }

            // Collect the actual scene content the server asked for, then reply on
            // the fixed res:scene channel; the server matches by reqID.
            const sceneGraph = collectSceneGraph(scene)
            console.log('[IntelligenceScan] answering', reqID, sceneGraph)
            socket.emit('res:scene', { reqID, sceneGraph })
        }

        socket.on('req:scene', onReqScene)

        return () => {
            socket.off('req:scene', onReqScene)
        }
    }, [socket, scene])

    return <></>
}

//
