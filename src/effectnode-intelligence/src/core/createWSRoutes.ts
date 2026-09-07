import type { Application, Response } from 'express'
import type { Server as HTTPServerType } from 'http'
import { Server as SocketServer } from 'socket.io'

/** Editor sockets join this room so editor-queries target only them. */
const EDITOR_ROOM = 'editor-room'

/** Fixed reply channel — editors answer a query here with their reqID. */
const REPLY_EVENT = 'res:scene'

/** How long a GET /api/query/* waits for an editor to answer before giving up. */
const EDITOR_QUERY_TIMEOUT_MS = 15_000

/**
 * One queryable facet of the editor's scene. Each key maps to a GET route and
 * to the slice of the editor's full bundle (`{ sceneGraph, performance }`) that
 * the route replies with — a scene query never ships the perf report and vice
 * versa, so payloads stay proportional to what was asked for.
 */
const QUERY_ROUTES = {
    /** Scene graph digest — every node with name/type/material(s). */
    scene: '/api/query/scene',
    /** Performance insight — geometry / per-object cost + live frame runtime. */
    performance: '/api/query/performance',
} as const

type QueryKind = keyof typeof QUERY_ROUTES

/**
 * A GET /api/query/* that is still waiting for an editor to answer over WS.
 * The reply from the editor resolves `res`, ending the request that started it.
 */
type PendingEditorQuery = {
    res: Response
    kind: QueryKind
    timer: ReturnType<typeof setTimeout>
}

/** The full bundle an editor answers a `req:scene` request with. */
type EditorBundle = { sceneGraph?: unknown; performance?: unknown }

export async function createWSRoutes({ app, server }: { app: Application; server: HTTPServerType }) {
    //

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

    // reqID -> the GET that is waiting on that request. One entry per in-flight
    // query; removed as soon as the editor answers or the request times out.
    const pendingQueries = new Map<string, PendingEditorQuery>()

    /** Resolve or reject the pending request `reqID` exactly once. */
    const settle = (reqID: string, onPending: (pending: PendingEditorQuery) => void) => {
        const pending = pendingQueries.get(reqID)
        if (!pending) {
            return
        }
        clearTimeout(pending.timer)
        pendingQueries.delete(reqID)
        onPending(pending)
    }

    const rejectQuery = (reqID: string, status: number, error: string) => {
        settle(reqID, (pending) => pending.res.status(status).json({ reqID, error }))
    }

    io.on('connection', (socket) => {
        console.log('connected: ', socket.id)

        socket.join(EDITOR_ROOM)

        // Editors answer a query by emitting back on this fixed channel, carrying
        // the reqID that identifies which pending GET to resolve. The server cuts
        // the full bundle down to the slice the waiting route asked for.
        socket.on(REPLY_EVENT, (payload: EditorBundle & { reqID?: string }) => {
            const reqID = payload?.reqID
            if (!reqID) {
                console.warn(`[editor-query] missing reqID from ${socket.id}`)
                return
            }
            console.log(`[editor-query ${reqID}] answered by ${socket.id}`)
            settle(reqID, (pending) => {
                const { sceneGraph, performance } = payload
                const reply =
                    pending.kind === 'scene'
                        ? { reqID, sceneGraph }
                        : // 'performance'
                          { reqID, performance }
                pending.res.json(reply)
            })
        })

        socket.on('disconnect', () => {
            socket.leave(EDITOR_ROOM)
            console.log('disconnected: ', socket.id)
        })
    })

    // One GET route per queryable facet — they share the WS round-trip and only
    // differ in which slice of the editor's bundle they respond with.
    for (const kind of Object.keys(QUERY_ROUTES) as QueryKind[]) {
        const path = QUERY_ROUTES[kind]

        app.get(path, (_req, res) => {
            const reqID = `query_${Math.random().toString(36).slice(2, 9)}`

            // Fast-fail when no editor is connected to answer — don't make the caller
            // (query-runtime) wait out the full timeout.
            const editorCount = io.sockets.adapter.rooms.get(EDITOR_ROOM)?.size ?? 0
            if (editorCount === 0) {
                res.status(503).json({ reqID, error: 'no editor connected' })
                return
            }

            // Backstop: if no connected editor answers in time, end the GET instead
            // of leaving the socket hanging forever.
            const timer = setTimeout(() => {
                rejectQuery(reqID, 504, `${kind} query timed out`)
            }, EDITOR_QUERY_TIMEOUT_MS)

            pendingQueries.set(reqID, { res, kind, timer })

            io.to(EDITOR_ROOM).emit('req:scene', { reqID })
        })
    }

    //
    //
}
