import express from 'express'
import cors from 'cors'

import { createServer } from 'node:http'
import { createWSRoutes } from './createWSRoutes'

export async function runSetup({ port = 4343 }) {
    //
    //
    const start = new Date().getTime()

    const app = express()
    app.use(
        cors({
            origin: '*',
            credentials: true,
        }),
    )
    app.use(express.json({ limit: '100gb' }))

    const server = createServer(app)

    // Registered before the health route, because the handler reports how many
    // editors are attached.
    const { editorCount } = await createWSRoutes({ app, server })

    app.get('/api/health', (_req, res) => {
        const editors = editorCount()
        res.json({
            uptime: new Date().getTime() - start,
            /** how many editors can answer a request right now */
            editors,
            /**
             * Requests are broadcast to every connected editor and the first
             * reply wins, so with more than one tab open a result — or a
             * mutation landing — is not deterministic. Surfaced here so a
             * confusing response has a visible cause.
             */
            warning:
                editors > 1
                    ? `${editors} editors are connected and the first reply wins — close the extra tabs for deterministic results.`
                    : undefined,
        })
    })

    server.listen(port, '0.0.0.0')

    return server
}

//
