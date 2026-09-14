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

    // Registered before the health route, because the handler reports on the
    // editors. `createWSRoutes` also mounts `/api/editors`, which needs the same
    // registry.
    const { editorCount, listEditors } = await createWSRoutes({ app, server })

    app.get('/api/health', (_req, res) => {
        const editors = editorCount()
        const { editors: list, duplicates } = listEditors()
        const identified = list.filter((editor) => editor.identified).length
        res.json({
            uptime: new Date().getTime() - start,
            /** how many editors can answer a request right now */
            editors,
            /** how many of those announced themselves and can be named */
            identified,
            /** joined without a hello — still answerable, just not addressable */
            unidentified: editors - identified,
            /**
             * Editor ids presented by more than one live tab. A duplicated tab
             * copies `sessionStorage`, so `?editor=<that id>` is ambiguous and is
             * refused with a 400 rather than guessed at.
             */
            duplicates,
            warning:
                duplicates.length > 0
                    ? `${duplicates.length} editor id(s) are presented by more than one tab — ?editor= on those is ambiguous.`
                    : undefined,
        })
    })

    server.listen(port, '0.0.0.0')

    return server
}

//
