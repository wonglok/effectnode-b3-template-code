import type { Application, Response } from 'express'
import type { Server as HTTPServerType } from 'http'
import { Server as SocketServer } from 'socket.io'

// import { fileURLToPath } from 'node:url'
// const __filename = fileURLToPath(import.meta.url)

/** Editor sockets join this room so scene queries target only them. */
const EDITOR_ROOM = 'editor-room'

/** Fixed reply channel — editors answer a scene request here with their reqID. */
const REPLY_EVENT = 'res:scene'

/** How long a GET /api/scene/query waits for an editor to answer before giving up. */
const SCENE_QUERY_TIMEOUT_MS = 15_000

/**
 * A GET /api/scene/query that is still waiting for an editor to answer over WS.
 * The reply from the editor resolves `res`, ending the request that started it.
 */
type PendingSceneQuery = {
    res: Response
    timer: ReturnType<typeof setTimeout>
}

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
    const pendingQueries = new Map<string, PendingSceneQuery>()

    const resolveQuery = (reqID: string, payload: unknown) => {
        const pending = pendingQueries.get(reqID)
        if (!pending) {
            return
        }
        clearTimeout(pending.timer)
        pendingQueries.delete(reqID)
        pending.res.json(payload)
    }

    const rejectQuery = (reqID: string, status: number, error: string) => {
        const pending = pendingQueries.get(reqID)
        if (!pending) {
            return
        }
        clearTimeout(pending.timer)
        pendingQueries.delete(reqID)
        pending.res.status(status).json({ reqID, error })
    }

    io.on('connection', (socket) => {
        console.log('connected: ', socket.id)

        socket.join(EDITOR_ROOM)

        // Editors answer a scene request by emitting back on this fixed channel,
        // carrying the reqID that identifies which pending GET to resolve.
        socket.on(REPLY_EVENT, (payload: { reqID?: string; summary?: unknown }) => {
            const reqID = payload?.reqID
            if (!reqID) {
                console.warn(`[${REPLY_EVENT}] missing reqID from ${socket.id}`)
                return
            }
            console.log(`[scene/query ${reqID}] answered by ${socket.id}`)
            resolveQuery(reqID, payload)
        })

        socket.on('disconnect', () => {
            socket.leave(EDITOR_ROOM)
            console.log('disconnected: ', socket.id)
        })
    })

    app.get('/api/scene/query', (_req, res) => {
        //
        const reqID = `event_${Math.random().toString(36).slice(2, 9)}`

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
            rejectQuery(reqID, 504, 'scene query timed out')
        }, SCENE_QUERY_TIMEOUT_MS)

        pendingQueries.set(reqID, { res, timer })

        io.to(EDITOR_ROOM).emit('req:scene', { reqID })
    })

    //
    //
}
