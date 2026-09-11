import { create } from 'zustand'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One measured post-processing pipeline. ms are wall-clock per render() call. */
export type PipelineTrack = {
    name: string
    /** exponential moving average of render() wall-time per frame */
    avgMs: number
    lastMs: number
    maxMs: number
    frames: number
}

/** Free frame time remaining vs a target fps, as a % of that target's budget. */
export type BudgetReport = {
    target: number
    /** 1000/target ms per frame */
    budgetMs: number
    /** % of the budget that is free — negative means the frame is over budget */
    headroomPct: number
    overBudget: boolean
}

/**
 * Live GPU-side resource levels from `renderer.info.memory`. Unlike the render
 * counters these are instantaneous levels, not per-frame deltas.
 *
 * `geometries` / `textures` are counts; the `*Size` fields are bytes. This is
 * what makes a leak visible at all — a resource whose buffers were never
 * disposed keeps showing up here after it has left the scene graph.
 */
export type GpuMemory = {
    textures: number
    geometries: number
    programs: number
    /** bytes held by vertex attribute buffers */
    attributesSize: number
    /** bytes held by index buffers */
    indexAttributesSize: number
    /** bytes held by textures */
    texturesSize: number
    /** bytes held by compiled programs */
    programsSize: number
    /** bytes held by uniform buffers */
    uniformBuffersSize: number
    /** total bytes across every category */
    totalBytes: number
}

/**
 * The slice of `renderer.info` this store reads. R3F types `gl` as a
 * `WebGLRenderer`, so callers hand-cast — see `IntelligenceScan`.
 */
/** `renderer.info.memory` as the renderer reports it — note `total`, not `totalBytes`. */
export type RendererMemoryLike = {
    textures?: number
    geometries?: number
    programs?: number
    attributesSize?: number
    indexAttributesSize?: number
    texturesSize?: number
    programsSize?: number
    uniformBuffersSize?: number
    /** the renderer's grand total, in bytes */
    total?: number
}

export type RendererInfoLike = {
    render?: {
        /** draw calls issued this frame, across every pass */
        drawCalls?: number
        /** how many `render()` invocations this frame — i.e. pass count */
        frameCalls?: number
        /** draw calls since the app started (page-lifetime total) */
        calls?: number
        triangles?: number
        points?: number
        lines?: number
    }
    memory?: RendererMemoryLike
}

/** Last-frame renderer load (from renderer.info). */
export type FrameLoad = {
    /**
     * Draw calls issued in the last frame — shadow and post-processing passes
     * included. This is a whole-frame total, not a delta; see `recordLoad`.
     */
    drawCalls: number
    /** how many `render()` invocations made up that frame (shadow, bloom, …) */
    frameCalls: number
    /** draw calls since the app started — the page-lifetime counter */
    calls: number
    triangles: number
    points: number
    lines: number
    /** live resource levels, not per-frame */
    textures: number
    geometries: number
    totalBytes: number
    /** the same levels plus the byte breakdown, for the memory query */
    memory: GpuMemory
}

export type RuntimePerfSnapshot = {
    /** false until at least a couple of frames have been sampled */
    sampling: boolean
    frames: number
    uptimeMs: number
    framerate: {
        fps: number
        /** mean frame time over the trailing ~1s window */
        frameMs: number
        /** 95th percentile frame time over the window */
        p95FrameMs: number
        /** worst single frame in the window (1000/max(dt)) */
        minFps: number
        /** frames in the window that took longer than ~33ms (< 30fps) */
        slowFrames: number
    }
    /** Free frame-time headroom vs 60 / 120 fps budgets (see frameMs). */
    budgetTargets: BudgetReport[]
    load: FrameLoad
    /** Post-processing pipelines by measured render time, slowest first. */
    slowEffects: PipelineTrack[]
}

export interface RuntimePerfStore {
    /** Clear all accumulated samples (call when a new canvas/scene mounts). */
    reset: () => void
    /** Feed one frame boundary. `nowMs` is performance.now() at the frame. */
    recordFrame: (nowMs: number) => void
    /** Feed `renderer.info` once per frame, read at the end of the frame. */
    recordLoad: (info?: RendererInfoLike) => void
    /** A pipeline.render() finished — feed its wall-time in ms. */
    recordPipeline: (name: string, ms: number) => void
    snapshot: () => RuntimePerfSnapshot
}

// ---------------------------------------------------------------------------
// Sampling constants
// ---------------------------------------------------------------------------

const BUDGET_TARGETS = [60, 120]
const MAX_SAMPLES = 480 // ~8s at 60fps of rolling history
/** rAF pauses (tab hidden / long stalls) aren't frames — ignore deltas above this. */
const GAP_MS = 250
/** 30fps floor: a frame slower than this counts as a "slow frame". */
const SLOW_MS = 1000 / 30
const EMA_ALPHA = 0.1

// ---------------------------------------------------------------------------
// Private accumulation — written imperatively each frame, read on snapshot().
// ---------------------------------------------------------------------------

const times: number[] = [] // frame timestamps (ms), aligned with dts
const dts: number[] = [] // frame wall deltas (ms)
let startTime = -1
let lastTime = -1
let acceptedFrames = 0
const emptyMemory = (): GpuMemory => ({
    textures: 0,
    geometries: 0,
    programs: 0,
    attributesSize: 0,
    indexAttributesSize: 0,
    texturesSize: 0,
    programsSize: 0,
    uniformBuffersSize: 0,
    totalBytes: 0,
})

const emptyLoad = (): FrameLoad => ({
    drawCalls: 0,
    frameCalls: 0,
    calls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
    textures: 0,
    geometries: 0,
    totalBytes: 0,
    memory: emptyMemory(),
})

let currentLoad: FrameLoad = emptyLoad()
const pipes = new Map<string, PipelineTrack>()

function round(n: number, dp = 2): number {
    const f = 10 ** dp
    return Math.round(n * f) / f
}

function mean(a: number[]): number {
    return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0
}

function pct(sorted: number[], p: number): number {
    if (!sorted.length) return 0
    const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)
    return sorted[Math.max(0, idx)]
}


// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useRuntimePerf = create<RuntimePerfStore>(() => ({
    reset: () => {
        times.length = 0
        dts.length = 0
        startTime = -1
        lastTime = -1
        acceptedFrames = 0
        pipes.clear()
        currentLoad = emptyLoad()
    },

    recordFrame: (nowMs) => {
        if (startTime < 0) {
            startTime = nowMs
            lastTime = nowMs
            return
        }
        const dt = nowMs - lastTime
        lastTime = nowMs
        if (dt > GAP_MS) return // tab hidden / long stall — not a real frame
        times.push(nowMs)
        dts.push(dt)
        acceptedFrames++
        if (times.length > MAX_SAMPLES) {
            times.shift()
            dts.shift()
        }
    },

    recordLoad: (info) => {
        const r = info?.render
        if (r) {
            // These are already whole-frame totals, so read them straight
            // through — never diff them against the previous frame.
            //
            // `info.autoReset` defaults to true, and WebGPURenderer's own
            // animation loop (started from inside `renderer.init()`, which
            // CanvasGPU awaits) calls `info.reset()` at the top of every frame.
            // A sample taken here — at the end of the R3F frame, after the
            // post-processing pipelines — is therefore this frame's total
            // across every pass. Diffing consecutive samples, which this store
            // used to do, yields ~0 for a static scene because consecutive
            // whole-frame totals are equal.
            if (r.drawCalls != null) currentLoad.drawCalls = r.drawCalls
            if (r.frameCalls != null) currentLoad.frameCalls = r.frameCalls
            if (r.calls != null) currentLoad.calls = r.calls
            if (r.triangles != null) currentLoad.triangles = r.triangles
            if (r.points != null) currentLoad.points = r.points
            if (r.lines != null) currentLoad.lines = r.lines
        }
        const m = info?.memory
        if (m) {
            const mem = currentLoad.memory
            if (m.textures != null) {
                mem.textures = m.textures
                currentLoad.textures = m.textures
            }
            if (m.geometries != null) {
                mem.geometries = m.geometries
                currentLoad.geometries = m.geometries
            }
            if (m.programs != null) mem.programs = m.programs
            if (m.attributesSize != null) mem.attributesSize = m.attributesSize
            if (m.indexAttributesSize != null) mem.indexAttributesSize = m.indexAttributesSize
            if (m.texturesSize != null) mem.texturesSize = m.texturesSize
            if (m.programsSize != null) mem.programsSize = m.programsSize
            if (m.uniformBuffersSize != null) mem.uniformBuffersSize = m.uniformBuffersSize
            if (m.total != null) {
                mem.totalBytes = m.total
                currentLoad.totalBytes = m.total
            }
        }
    },

    recordPipeline: (name, ms) => {
        const prev = pipes.get(name)
        if (prev) {
            prev.lastMs = ms
            prev.avgMs = prev.frames > 0 ? prev.avgMs * (1 - EMA_ALPHA) + ms * EMA_ALPHA : ms
            prev.maxMs = Math.max(prev.maxMs, ms)
            prev.frames++
        } else {
            pipes.set(name, { name, avgMs: ms, lastMs: ms, maxMs: ms, frames: 1 })
        }
    },

    snapshot: () => {
        const now = performance.now()
        // Trailing ~1s window of samples.
        const cutoff = now - 1000
        let startIdx = 0
        while (startIdx < times.length && times[startIdx] < cutoff) startIdx++
        const windowDts = dts.slice(startIdx)

        const frameMs = mean(windowDts)
        const fps = frameMs > 0 ? 1000 / frameMs : 0
        const sorted = [...windowDts].sort((a, b) => a - b)
        const p95FrameMs = pct(sorted, 0.95)
        const worstDt = sorted.length ? sorted[sorted.length - 1] : 0
        const minFps = worstDt > 0 ? 1000 / worstDt : 0
        const slowFrames = windowDts.filter((d) => d > SLOW_MS).length

        const budgetTargets: BudgetReport[] = BUDGET_TARGETS.map((target) => {
            const budgetMs = 1000 / target
            const headroomPct = frameMs > 0 ? round(((budgetMs - frameMs) / budgetMs) * 100, 1) : 100
            return { target, budgetMs: round(budgetMs, 2), headroomPct, overBudget: frameMs > budgetMs }
        })

        const slowEffects: PipelineTrack[] = [...pipes.values()].sort((a, b) => b.avgMs - a.avgMs)

        return {
            sampling: acceptedFrames >= 3,
            frames: acceptedFrames,
            uptimeMs: round(now - (startTime < 0 ? now : startTime)),
            framerate: {
                fps: round(fps, 1),
                frameMs: round(frameMs, 2),
                p95FrameMs: round(p95FrameMs, 2),
                minFps: round(minFps, 1),
                slowFrames,
            },
            budgetTargets,
            // Deep-copy `memory` too, so a caller cannot mutate the live
            // accumulator through the returned snapshot.
            load: { ...currentLoad, memory: { ...currentLoad.memory } },
            slowEffects,
        }
    },
}))

// ---------------------------------------------------------------------------
// Pipeline instrumentation — a tiny 2-line hook for post-processing components.
// ---------------------------------------------------------------------------

const TRACKED = Symbol('effectnode-perf-tracked')

/**
 * Wrap a RenderPipeline's render() so each call's wall-time is recorded against
 * `name`. Idempotent per instance. Call once right after the pipeline is built:
 *
 *     trackPipeline('bloom', postProcessing)
 *
 * Note: a pipeline that owns the scene pass (three's `pass(scene, camera)` is
 * part of its output node) includes the scene render in its measured time — so
 * slowEffects is the total cost of that effect chain, scene included.
 */
export function trackPipeline(name: string, pipeline: unknown): unknown {
    const p = pipeline as Record<PropertyKey, unknown> & { render?: (...args: unknown[]) => unknown }
    if (!p || typeof p.render !== 'function' || (p as Record<PropertyKey, unknown>)[TRACKED]) return pipeline
    ;(p as Record<PropertyKey, unknown>)[TRACKED] = true
    const original = p.render.bind(p)
    p.render = (...args: unknown[]) => {
        const t0 = performance.now()
        const result = original(...args)
        useRuntimePerf.getState().recordPipeline(name, performance.now() - t0)
        return result
    }
    return pipeline
}

//
