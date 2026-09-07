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

/** Last-frame renderer load (from renderer.info), as per-frame deltas. */
export type FrameLoad = {
    drawCalls: number
    triangles: number
    points: number
    lines: number
    /** live resource levels, not per-frame */
    textures: number
    geometries: number
    totalBytes: number
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
    /** Feed renderer.info once per frame; per-frame counters are diffed here. */
    recordLoad: (info?: {
        render?: { drawCalls?: number; triangles?: number; points?: number; lines?: number }
        memory?: { textures?: number; geometries?: number; total?: number }
    }) => void
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
let currentLoad: FrameLoad = {
    drawCalls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
    textures: 0,
    geometries: 0,
    totalBytes: 0,
}
// renderer.info may auto-reset per frame or accumulate; lastCounters lets us
// recover the per-frame value either way.
const lastCounters = { drawCalls: -1, triangles: -1, points: -1, lines: -1 }
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

/** Counters are cumulative-with-possible-per-frame-reset — always yield the delta. */
function frameDelta(counter: number, prev: number): number {
    if (prev < 0 || counter < prev) return counter
    return counter - prev
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
        lastCounters.drawCalls = -1
        lastCounters.triangles = -1
        lastCounters.points = -1
        lastCounters.lines = -1
        currentLoad = { drawCalls: 0, triangles: 0, points: 0, lines: 0, textures: 0, geometries: 0, totalBytes: 0 }
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
            const dc = r.drawCalls
            const tri = r.triangles
            const pt = r.points
            const ln = r.lines
            if (dc != null) {
                currentLoad.drawCalls = frameDelta(dc, lastCounters.drawCalls)
                lastCounters.drawCalls = dc
            }
            if (tri != null) {
                currentLoad.triangles = frameDelta(tri, lastCounters.triangles)
                lastCounters.triangles = tri
            }
            if (pt != null) {
                currentLoad.points = frameDelta(pt, lastCounters.points)
                lastCounters.points = pt
            }
            if (ln != null) {
                currentLoad.lines = frameDelta(ln, lastCounters.lines)
                lastCounters.lines = ln
            }
        }
        const m = info?.memory
        if (m) {
            if (m.textures != null) currentLoad.textures = m.textures
            if (m.geometries != null) currentLoad.geometries = m.geometries
            if (m.total != null) currentLoad.totalBytes = m.total
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
            load: { ...currentLoad },
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
