import type { Application } from 'express'
import type { Server as HTTPServerType } from 'http'
import { Server as SocketServer } from 'socket.io'

// import { fileURLToPath } from 'node:url'
// const __filename = fileURLToPath(import.meta.url)

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

    io.on('connection', (socket) => {
        console.log('connected: ', socket.id)

        socket.on('disconnect', () => {
            console.log('disconnected: ', socket.id)
        })

        //
    })

    app.get('/api/scene/query', (req, res) => {
        //
        let reqID = `_${Math.random().toString(36).slice(2, 9)}`
        io.emit('req:scene', {
            //
            reqID: reqID,
        })

        io.once(reqID, (data) => {
            res.json(data)
        })
    })

    //
    //
}
