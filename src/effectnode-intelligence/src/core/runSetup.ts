import express from 'express'
import cors from 'cors'

// import { homedir } from 'node:os'
// import { dirname, join } from 'node:path'
import { createServer } from 'node:http'
import { createWSRoutes } from './createWSRoutes'

export async function runSetup({ port = 4000 }) {
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

    app.get('/api/health', (req, res) => {
        res.json({ uptime: new Date().getTime() - start })
    })

    const server = createServer(app)

    await createWSRoutes({ app, server })

    server.listen(port, '0.0.0.0')

    return server
}

//
