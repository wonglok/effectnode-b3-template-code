import { useEffect } from 'react'
import { useIntelligence } from './store/useIntelligence'
import { useRuntimePerf } from './store/useRuntimePerf'
import { useThree, useFrame } from '@react-three/fiber'
import { collectSceneGraph } from './collectSceneGraph'
import { collectScenePerformance } from './collectScenePerformance'

export function IntelligenceScan() {
    const makeSocket = useIntelligence((r) => r.makeSocket)
    const socket = useIntelligence((r) => r.socket)
    const scene = useThree((r) => r.scene)
    const gl = useThree((r) => r.gl)

    // Live runtime-perf monitor. IntelligenceScan answers scene queries about this
    // exact canvas, so it samples the loop it renders on: frame times → fps/frame
    // budget, renderer.info → per-frame draw/triangle load. The very-high priority
    // runs this after the post-processing pipelines (BloomRender @10, SSGIRender @1)
    // so info reflects a fully rendered frame.
    useEffect(() => {
        useRuntimePerf.getState().reset()
    }, [])

    useFrame(() => {
        const now = performance.now()
        const perf = useRuntimePerf.getState()
        perf.recordFrame(now)
        const info = (
            gl as {
                info?: {
                    render?: { drawCalls?: number; triangles?: number; points?: number; lines?: number }
                    memory?: { textures?: number; geometries?: number; total?: number }
                }
            }
        ).info
        if (info) perf.recordLoad(info)
    }, 1_000_000)

    useEffect(() => {
        return makeSocket()
    }, [makeSocket])

    //

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
            const performance = collectScenePerformance(scene)
            console.log('[IntelligenceScan] answering', reqID, {
                objects: performance.totals.objects,
                geometries: performance.totals.uniqueGeometries,
                vertices: performance.totals.drawnVertices,
                triangles: performance.totals.drawnTriangles,
            })
            socket.emit('res:scene', { reqID, sceneGraph, performance })
        }

        socket.on('req:scene', onReqScene)

        return () => {
            socket.off('req:scene', onReqScene)
        }
    }, [socket, scene])

    return <></>
}

//
