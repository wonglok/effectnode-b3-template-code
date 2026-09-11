import { createBackendServer } from './index.js'

const port = Number(process.env.BACKEND_PORT ?? 4343)

async function main(): Promise<void> {
    //

    const server = await createBackendServer({ port })

    const shutdown = () => {
        try {
            server.close(() => process.exit(0))
        } catch (e) {
            console.error(e)
        }
    }

    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
}

main().catch((err: unknown) => {
    console.error(`[backend] failed to start: ${(err as Error).message}`)
    process.exit(1)
})
