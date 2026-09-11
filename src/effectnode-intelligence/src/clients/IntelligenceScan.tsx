import { useEffect } from 'react'
import { useThree, useFrame } from '@react-three/fiber'
import type { Object3D } from 'three'
import {
    REPLY_EVENT,
    REQUEST_EVENT,
    type MutationKind,
    type MutationParams,
    type QueryKind,
    type QueryParams,
} from '../protocol'
import { useIntelligence } from './store/useIntelligence'
import { useRuntimePerf } from './store/useRuntimePerf'
import { useAssetRegistry } from './store/useAssetRegistry'
import { collectSceneGraph } from './collectSceneGraph'
import { collectScenePerformance } from './collectScenePerformance'
import { collectMemory } from './collectMemory'
import { collectDrawCalls } from './collectDrawCalls'
import { collectShader, installShaderCapture } from './collectShader'
import { runDispose, runEval, runPatch } from './applyMutation'
import { indexScene, labelOf, resolveSelector } from './resolveObject'
import { asIntelligenceGL } from './glTypes'

/**
 * The editor half of the agent bridge: lives inside the R3F Canvas, answers
 * `req:query`, and applies mutations. One instance per canvas.
 *
 * Requests are dispatched through the two registries below, so adding a facet is
 * one entry in one place rather than another branch in a growing `if`.
 */
export function IntelligenceScan() {
    const makeSocket = useIntelligence((r) => r.makeSocket)
    const socket = useIntelligence((r) => r.socket)
    const scene = useThree((r) => r.scene)
    const camera = useThree((r) => r.camera)
    const gl = useThree((r) => r.gl)

    // Live runtime-perf monitor. IntelligenceScan answers scene queries about this
    // exact canvas, so it samples the loop it renders on: frame times → fps/frame
    // budget, renderer.info → per-frame draw/triangle load.
    //
    // ⚠ The `useFrame` priority below is LOAD-BEARING beyond perf sampling. R3F
    // adds 1 to its internal priority counter for every subscriber with
    // `priority > 0`, and skips its own automatic `gl.render(scene, camera)`
    // whenever that counter is non-zero. This subscription is what keeps R3F from
    // rendering the scene a second time — the scene pass belongs to the
    // post-processing pipelines (BloomRender's `pass(scene, camera)`).
    //
    // Removing this subscription (or giving it priority 0) silently re-enables
    // R3F's auto-render, so the scene is drawn twice per frame and every
    // draw-call number this tool reports changes. Keep a priority > 0 subscriber
    // alive for as long as this component is mounted.
    useEffect(() => {
        useRuntimePerf.getState().reset()
        useAssetRegistry.getState().reset()
    }, [])

    useFrame(() => {
        const now = performance.now()
        const perf = useRuntimePerf.getState()
        perf.recordFrame(now)
        // Read at the very end of the frame, after the post-processing
        // pipelines, so `info` holds this frame's totals across every pass.
        perf.recordLoad(asIntelligenceGL(gl).info)
    }, 1_000_000)

    useEffect(() => {
        return makeSocket()
    }, [makeSocket])

    // Capture node builders as they are created. This is what makes §4 possible
    // without recompiling: the compiled source and the live TSL uniform values
    // are both reachable from the captured render object.
    useEffect(() => {
        return installShaderCapture(asIntelligenceGL(gl))
    }, [gl])

    useEffect(() => {
        if (!socket) {
            return
        }

        const glc = asIntelligenceGL(gl)
        const mutationsEnabled = import.meta.env.DEV

        /** Resolve a selector to a subtree root, or throw so the caller sees why. */
        const rootFor = (selector?: string): Object3D => {
            if (!selector) {
                return scene
            }
            const index = indexScene(scene)
            const resolved = resolveSelector(index, selector, useAssetRegistry.getState().focus)
            if (!resolved.object) {
                throw new Error(resolved.error)
            }
            useAssetRegistry.getState().setFocus(resolved.object, labelOf(resolved.object, index))
            return resolved.object
        }

        const queryHandlers: Record<QueryKind, (params: QueryParams) => unknown | Promise<unknown>> = {
            scene: (params) => collectSceneGraph(rootFor(params.object), { maxDepth: params.maxDepth }),

            performance: (params) => collectScenePerformance(rootFor(params.object)),

            memory: (params) =>
                collectMemory(rootFor(params.object), useRuntimePerf.getState().snapshot().load.memory),

            drawcalls: (params) =>
                collectDrawCalls(rootFor(params.object), useRuntimePerf.getState().snapshot().load.drawCalls),

            shader: async (params) => {
                // Single-target by design: a scene-wide shader dump would be tens
                // of MB and would stall the main thread assembling it.
                const index = indexScene(scene)
                const resolved = resolveSelector(index, params.object ?? '$0', useAssetRegistry.getState().focus)
                if (!resolved.object) {
                    throw new Error(resolved.error)
                }
                useAssetRegistry.getState().setFocus(resolved.object, labelOf(resolved.object, index))
                return await collectShader({
                    gl: glc,
                    scene,
                    camera,
                    object: resolved.object,
                    maxChars: params.maxChars,
                })
            },
        }

        const mutationHandlers: Record<MutationKind, (params: MutationParams) => unknown | Promise<unknown>> = {
            patch: (params) => {
                if (!Array.isArray(params.patch) || params.patch.length === 0) {
                    throw new Error('body must include a non-empty "patch" array of RFC 6902 operations')
                }
                return runPatch({ scene, ops: params.patch, selector: params.object })
            },

            eval: async (params) => {
                if (typeof params.code !== 'string' || !params.code.trim()) {
                    throw new Error('body must include a non-empty "code" string')
                }
                return await runEval({ code: params.code, scene, camera, gl: glc, selector: params.object })
            },

            dispose: (params) => runDispose({ scene, selector: params.object }),
        }

        const onRequest = async (arg?: { reqID?: string; kind?: string; params?: unknown }) => {
            const reqID = arg?.reqID
            const kind = arg?.kind
            if (!reqID || !kind) {
                console.warn('[IntelligenceScan] request missing reqID/kind', arg)
                return
            }
            if (!socket.connected) {
                console.warn('[IntelligenceScan] socket not connected — cannot answer', reqID)
                return
            }

            // Every await lives inside this try, so a collector that throws or
            // rejects still produces a reply. Without it the request would hang
            // until the server's 15s timeout and report nothing useful.
            try {
                let result: unknown
                if (kind in queryHandlers) {
                    result = await queryHandlers[kind as QueryKind]((arg?.params ?? {}) as QueryParams)
                } else if (kind in mutationHandlers) {
                    if (!mutationsEnabled) {
                        throw new Error('mutations are disabled in a production build')
                    }
                    result = await mutationHandlers[kind as MutationKind]((arg?.params ?? {}) as MutationParams)
                } else {
                    throw new Error(`unknown request kind "${kind}"`)
                }
                socket.emit(REPLY_EVENT, { reqID, ok: true, result })
            } catch (error) {
                const message = (error as Error)?.message ?? String(error)
                console.warn(`[IntelligenceScan] ${kind} failed:`, message)
                socket.emit(REPLY_EVENT, { reqID, ok: false, error: `${kind}: ${message}` })
            }
        }

        socket.on(REQUEST_EVENT, onRequest)

        return () => {
            socket.off(REQUEST_EVENT, onRequest)
        }
    }, [socket, scene, camera, gl])

    return <></>
}

//
