// import express, { Application } from "express";
// import cors from "cors";
// import { createServer, type Server } from "node:http";
// import { router } from "./routes/index.js";
// import { createWsServer } from "./ws/index.js";
import { runSetup } from './core/runSetup.js'

export interface BackendOptions {
    port?: number
}

/**
 * Create and start the Express backend: CORS + REST API (mounted at /api) and
 * a WebSocket server (at /ws) on the same HTTP server.
 */
export async function createBackendServer(options: BackendOptions = {}): Promise<any> {
    return await runSetup({ port: Number(options.port) })
}
