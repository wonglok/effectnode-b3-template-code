import type { Application, NextFunction, Request, Response } from 'express'
import type { Server as HTTPServerType } from 'http'
import { Server as SocketServer } from 'socket.io'
import {
    EDITOR_QUERY_TIMEOUT_MS,
    EDITOR_ROOM,
    MUTATION_ROUTES,
    PROTOCOL_VERSION,
    QUERY_ROUTES,
    REPLY_EVENT,
    REQUEST_EVENT,
    type EditorReply,
    type FacetKind,
    type MutationKind,
    type MutationParams,
    type QueryKind,
    type QueryParams,
} from '../protocol'

/**
 * The server half of the agent bridge.
 *
 * It owns no scene state: every request is forwarded to a connected editor
 * (a browser tab running `IntelligenceScan`) over socket.io, and whatever that
 * editor computes comes straight back. The server's whole job is transport,
 * timeouts, and keeping the mutation routes off the network.
 */

/** A request that is still waiting for an editor to answer. */
type PendingRequest = {
    res: Response
    kind: FacetKind
    timer: ReturnType<typeof setTimeout>
}

let reqCounter = 0

function makeReqID(kind: FacetKind): string {
    reqCounter = (reqCounter + 1) % 1_000_000
    return `${kind}_${reqCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * True when the caller is on this machine. `runSetup` binds `0.0.0.0`, so the
 * port is reachable from the LAN; the route handlers below are for a local
 * agent only.
 */
function isLoopback(req: Request): boolean {
    const address = req.socket.remoteAddress ?? ''
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Reject browser requests that came from another origin.
 *
 * A loopback check alone does not stop a malicious page running in the same
 * browser: its fetch to 127.0.0.1 originates from the loopback interface too.
 * Checking `Origin` does — a cross-origin page cannot forge it. Requests with
 * no `Origin` at all (curl, a local agent) are allowed, which is the whole
 * point of the tool.
 */
function isLocalOrigin(req: Request): boolean {
    const origin = req.get('origin')
    if (!origin) {
        return true
    }
    try {
        const { hostname } = new URL(origin)
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
    } catch {
        return false
    }
}

/** Read the optional query params off a GET query string. */
function queryParamsOf(req: Request): QueryParams {
    const params: QueryParams = {}
    const object = req.query.object
    if (typeof object === 'string' && object.length > 0) {
        params.object = object
    }
    const maxDepth = Number(req.query.maxDepth)
    if (Number.isFinite(maxDepth) && maxDepth > 0) {
        params.maxDepth = Math.floor(maxDepth)
    }
    const maxChars = Number(req.query.maxChars)
    if (Number.isFinite(maxChars) && maxChars > 0) {
        params.maxChars = Math.floor(maxChars)
    }
    return params
}

export type WSRoutesHandle = {
    /** how many editors are currently connected and able to answer */
    editorCount: () => number
}

export async function createWSRoutes({
    app,
    server,
}: {
    app: Application
    server: HTTPServerType
}): Promise<WSRoutesHandle> {
    const io = new SocketServer(server, {
        // engine.io handles /socket.io BEFORE the express middleware stack, so the
        // express `cors()` in runSetup never applies to it. CORS must be enabled here.
        cors: {
            // reflect the request origin instead of '*' — the client connects with
            // `withCredentials: true`, and browsers reject wildcard + credentials.
            origin: true,
            credentials: true,
        },
        // a full scene.toJSON() snapshot (IntelligenceScan) is ~147MB — far over the
        // engine.io default 1MB maxPayload, which silently drops the reply.
        maxHttpBufferSize: 512 * 1024 * 1024,
    })

    // reqID -> the HTTP request waiting on it. One entry per in-flight request;
    // removed as soon as an editor answers, the request times out, or the last
    // editor goes away.
    const pending = new Map<string, PendingRequest>()

    const editorCount = () => io.sockets.adapter.rooms.get(EDITOR_ROOM)?.size ?? 0

    /** Resolve the pending request `reqID` exactly once. */
    const settle = (reqID: string, onPending: (p: PendingRequest) => void) => {
        const entry = pending.get(reqID)
        if (!entry) {
            return
        }
        clearTimeout(entry.timer)
        pending.delete(reqID)
        onPending(entry)
    }

    /** End every in-flight request — used when the last editor disconnects. */
    const failAllPending = (status: number, error: string) => {
        for (const [reqID, entry] of pending) {
            clearTimeout(entry.timer)
            pending.delete(reqID)
            entry.res.status(status).json({ reqID, ok: false, error })
        }
    }

    io.on('connection', (socket) => {
        // A stale bundle that still listens for an old event name would otherwise
        // hang every request until the 15s timeout. Refuse it up front instead.
        const version = (socket.handshake.auth as { protocol?: unknown } | undefined)?.protocol
        if (version !== PROTOCOL_VERSION) {
            console.warn(
                `[editor] ${socket.id} speaks protocol ${String(version)}, expected ${PROTOCOL_VERSION} — refusing`,
            )
            socket.emit('protocol-mismatch', { expected: PROTOCOL_VERSION, received: version ?? null })
            socket.disconnect(true)
            return
        }

        console.log('connected: ', socket.id)
        socket.join(EDITOR_ROOM)

        // Editors answer by emitting back on this fixed channel, carrying the
        // reqID that identifies which pending request to resolve.
        socket.on(REPLY_EVENT, (payload: EditorReply) => {
            const reqID = payload?.reqID
            if (!reqID) {
                console.warn(`[editor] reply without reqID from ${socket.id}`)
                return
            }
            if (!pending.has(reqID)) {
                // Already settled (timed out, or another editor won the race).
                console.warn(`[editor ${reqID}] late reply from ${socket.id} ignored`)
                return
            }
            settle(reqID, (entry) => {
                if (payload.ok) {
                    entry.res.json({ reqID, ok: true, result: payload.result })
                } else {
                    // 502: the request was fine, the editor could not fulfil it.
                    entry.res.status(502).json({ reqID, ok: false, error: payload.error })
                }
            })
        })

        socket.on('disconnect', () => {
            console.log('disconnected: ', socket.id)
            // Any request still in flight was addressed to the pool of editors.
            // With the pool empty, nothing can answer — fail fast rather than
            // leaving the caller to wait out the timeout.
            if (editorCount() === 0) {
                failAllPending(503, 'editor disconnected before answering')
            }
        })
    })

    /** Forward one request to the editor pool and wait for the reply. */
    const dispatch = (kind: FacetKind, params: QueryParams | MutationParams, res: Response) => {
        const reqID = makeReqID(kind)

        // Fast-fail when no editor is connected to answer — don't make the caller
        // (query-runtime) wait out the full timeout.
        if (editorCount() === 0) {
            res.status(503).json({ reqID, ok: false, error: 'no editor connected' })
            return
        }

        // Backstop: if no connected editor answers in time, end the request
        // instead of leaving the socket hanging forever.
        const timer = setTimeout(() => {
            settle(reqID, (entry) => {
                entry.res.status(504).json({ reqID, ok: false, error: `${kind} request timed out` })
            })
        }, EDITOR_QUERY_TIMEOUT_MS)

        pending.set(reqID, { res, kind, timer })

        io.to(EDITOR_ROOM).emit(REQUEST_EVENT, { reqID, kind, params })
    }

    // One GET route per queryable facet — they share the WS round-trip and
    // differ only in which facet the editor collects.
    for (const kind of Object.keys(QUERY_ROUTES) as QueryKind[]) {
        app.get(QUERY_ROUTES[kind], (req, res) => {
            dispatch(kind, queryParamsOf(req), res)
        })
    }

    // Mutation routes share the same round-trip but are POST, and are the only
    // ones that change state — so they are the only ones guarded.
    const guardMutation = (req: Request, res: Response, next: NextFunction) => {
        if (!isLoopback(req) || !isLocalOrigin(req)) {
            res.status(403).json({
                ok: false,
                error: 'mutation routes are restricted to local callers',
            })
            return
        }
        next()
    }

    for (const kind of Object.keys(MUTATION_ROUTES) as MutationKind[]) {
        app.post(MUTATION_ROUTES[kind], guardMutation, (req, res) => {
            // express 5 leaves `req.body` undefined when no parser matched
            // (unlike v4's `{}`), so never destructure it unguarded.
            dispatch(kind, (req.body ?? {}) as MutationParams, res)
        })
    }

    return { editorCount }
}
