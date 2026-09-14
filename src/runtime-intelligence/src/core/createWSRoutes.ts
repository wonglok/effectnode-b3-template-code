import type { Application, NextFunction, Request, Response } from 'express'
import type { Server as HTTPServerType } from 'http'
import { Server as SocketServer } from 'socket.io'
import {
    EDITOR_ANSWER_MAX_BYTES,
    EDITOR_HELLO,
    EDITOR_LIST_ROUTE,
    EDITOR_QUERY_TIMEOUT_MS,
    EDITOR_ROOM,
    MUTATION_ROUTES,
    PROTOCOL_VERSION,
    QUERY_ROUTES,
    REPLY_EVENT,
    REQUEST_EVENT,
    type EditorAnswer,
    type EditorIdentity,
    type EditorInfo,
    type EditorReply,
    type FacetKind,
    type MutationKind,
    type MutationParams,
    type QueryEnvelope,
    type QueryKind,
    type QueryParams,
} from '../protocol'

/**
 * The server half of the agent bridge.
 *
 * It owns no scene state: every request is forwarded to the connected editors
 * (browser tabs running `IntelligenceScan`) over socket.io, and whatever those
 * editors compute comes straight back. The server's job is transport, timeouts,
 * naming the editors, and keeping the mutation routes off the network.
 *
 * Every request fans out to the whole pool and returns **one answer per
 * editor** — that is how an iPhone, an Android and a laptop get compared against
 * the same scene in a single call. `?editor=` narrows the pool to one.
 */

/** A request that is still being collected from the editor pool. */
type PendingRequest = {
    res: Response
    kind: FacetKind
    timer: ReturnType<typeof setTimeout>
    /** sockets the request was addressed to, in order — fixes the reply order. */
    addressed: string[]
    /** sockets we are still waiting to hear from. */
    awaiting: Set<string>
    /** answers collected, keyed by socket id. */
    answers: Map<string, EditorAnswer>
    startedAt: number
    warnings: string[]
    /** guards `res.json` against a second call. */
    done: boolean
    /** one "late reply" warn per request, not per reply. */
    warnedLate: boolean
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

/** `?editor=` off the query string. Read on POSTs too — targeting is not a
 *  read-only concern, and a mutation is exactly what you most want to aim. */
function editorSelectorOf(req: Request): string | undefined {
    const editor = req.query.editor
    return typeof editor === 'string' && editor.length > 0 ? editor : undefined
}

// ---------------------------------------------------------------------------
// Editor identity
// ---------------------------------------------------------------------------

/** Caps on the untrusted hello payload — a buggy tab must not be able to bloat
 *  `/api/editors`, the responses, or the agent's context. */
const MAX_ID = 64
const MAX_LABEL = 80
const MAX_SHORT = 64
const MAX_PAGE = 200
const MAX_UA = 400

function cappedString(value: unknown, max: number): string {
    return typeof value === 'string' ? value.slice(0, max) : ''
}

/** Coerce a hello payload into a trustworthy {@link EditorIdentity}, or `null`
 *  when it is unusable. */
function sanitizeIdentity(raw: unknown): EditorIdentity | null {
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    // `id` is what `?editor=` resolves against; a hello without one cannot be
    // addressed, so treat it as no hello at all.
    const id = cappedString(r.id, MAX_ID)
    if (!id) return null

    const viewport = (r.viewport ?? {}) as Record<string, unknown>
    const width = Math.floor(Number(viewport.width))
    const height = Math.floor(Number(viewport.height))
    const dpr = Number(r.devicePixelRatio)

    return {
        id,
        loadId: cappedString(r.loadId, MAX_ID),
        label: cappedString(r.label, MAX_LABEL),
        platform: cappedString(r.platform, MAX_SHORT),
        browser: cappedString(r.browser, MAX_SHORT),
        page: cappedString(r.page, MAX_PAGE),
        viewport: {
            width: Number.isFinite(width) ? Math.max(0, width) : 0,
            height: Number.isFinite(height) ? Math.max(0, height) : 0,
        },
        devicePixelRatio: Number.isFinite(dpr) && dpr > 0 ? dpr : 1,
        userAgent: cappedString(r.userAgent, MAX_UA),
    }
}

/**
 * The request params that fan out to more than one tab, where `$0` is a trap.
 *
 * `$0` is "the object *this* editor last addressed" — a per-tab pointer, not a
 * scene address. Across a fan-out each tab resolves its own, so the results are
 * about different objects and a `patch` lands on a different subtree per device.
 * The request is still served (the answers are individually valid), but the
 * envelope says so rather than letting the caller assume they line up.
 */
function focusWarnings(kind: FacetKind, params: QueryParams | MutationParams, width: number): string[] {
    if (width < 2) return []
    const patch = kind === 'patch' ? (params as MutationParams).patch : undefined
    const paths = [params.object, ...(patch ?? []).map((op) => op.path?.split('/')[1])]
    if (!paths.some((p) => p === '$0')) return []
    return [
        '"$0" is resolved per editor: each tab answered about its own focused object, so these results do not necessarily describe the same object.',
    ]
}

export type WSRoutesHandle = {
    /** how many editors are currently connected and able to answer */
    editorCount: () => number
    /** the connected editors, with identity — see {@link EDITOR_LIST_ROUTE} */
    listEditors: () => { editors: EditorInfo[]; duplicates: string[] }
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

    // reqID -> the collection in flight. One entry per request; removed when the
    // last editor answers, the request times out, or every editor drops out.
    const pending = new Map<string, PendingRequest>()

    // socket.id -> who that socket is. Keyed by socket id rather than by the
    // stable editor id on purpose: a socket id is unique per connection, so a
    // reconnect is a *new* editor that nothing in flight is waiting on, and a
    // disconnect can never clobber a live entry.
    const editors = new Map<string, EditorInfo>()

    const roomSocketIds = () => [...(io.sockets.adapter.rooms.get(EDITOR_ROOM) ?? [])]

    /** Room size, not registry size — the two must agree, so an un-hello'd
     *  socket still counts as an editor and still gets reported. */
    const editorCount = () => roomSocketIds().length

    /**
     * The editor behind a socket, synthesising an "unlabeled" stand-in when the
     * socket never sent a hello. Such a socket can still answer a request — it
     * just cannot be named or targeted by `?editor=`.
     */
    const editorFor = (socketId: string): EditorInfo =>
        editors.get(socketId) ?? {
            id: '',
            loadId: '',
            label: `unlabeled · ${socketId.slice(0, 6)}`,
            platform: 'Unknown',
            browser: 'Unknown',
            page: '',
            viewport: { width: 0, height: 0 },
            devicePixelRatio: 1,
            userAgent: '',
            socketId,
            connectedAt: 0,
            identified: false,
        }

    const listEditors = () => {
        const infos = roomSocketIds().map(editorFor)
        const counts = new Map<string, number>()
        for (const info of infos) {
            if (info.id) counts.set(info.id, (counts.get(info.id) ?? 0) + 1)
        }
        // A duplicated tab copies `sessionStorage`, so two live editors can
        // present one id — which makes `?editor=<that id>` ambiguous.
        const duplicates = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id)
        return { editors: infos, duplicates }
    }

    type Resolution = { ok: true; sockets: string[] } | { ok: false; status: number; error: string }

    /**
     * Resolve `?editor=` against the live pool: exact id, then exact label, then
     * a case-insensitive substring of either. An ambiguous selector is refused
     * rather than guessed at — silently picking one tab is the exact class of
     * non-determinism this whole change exists to remove.
     */
    const resolveEditors = (selector: string | undefined): Resolution => {
        const sockets = roomSocketIds()
        if (!selector) return { ok: true, sockets }

        const infos = sockets.map(editorFor)
        const want = selector.toLowerCase()
        const byId = infos.filter((e) => e.id && e.id.toLowerCase() === want)
        const byLabel = infos.filter((e) => e.label.toLowerCase() === want)
        const matches =
            byId.length > 0
                ? byId
                : byLabel.length > 0
                  ? byLabel
                  : infos.filter(
                        (e) =>
                            (e.id && e.id.toLowerCase().includes(want)) ||
                            e.label.toLowerCase().includes(want),
                    )

        if (matches.length === 0) {
            return { ok: false, status: 404, error: `no editor matches "${selector}"` }
        }
        if (matches.length > 1) {
            const who = matches.map((e) => e.label || e.socketId).join(', ')
            return {
                ok: false,
                status: 400,
                error: `"${selector}" matches ${matches.length} editors (${who}) — use a full id`,
            }
        }
        return { ok: true, sockets: [matches[0].socketId] }
    }

    /** Serialize once, and treat a `RangeError` as "too big" rather than letting
     *  it escape as an opaque 500. */
    const measure = (value: unknown): number => {
        try {
            return JSON.stringify(value)?.length ?? 0
        } catch {
            return Number.POSITIVE_INFINITY
        }
    }

    const failure = (socketId: string, entry: PendingRequest, error: string): EditorAnswer => ({
        editor: editorFor(socketId),
        ok: false,
        elapsedMs: Date.now() - entry.startedAt,
        error,
    })

    /** Respond, exactly once, with whatever has been collected. */
    const finish = (reqID: string, timedOut: boolean) => {
        const entry = pending.get(reqID)
        if (!entry || entry.done) return
        entry.done = true
        clearTimeout(entry.timer)
        pending.delete(reqID)

        // Anything still outstanding could not answer before the deadline.
        for (const socketId of entry.awaiting) {
            entry.answers.set(socketId, failure(socketId, entry, 'did not answer before the timeout'))
        }
        entry.awaiting.clear()

        // Rebuild in the addressed order so responses[] is stable call to call.
        const responses = entry.addressed
            .map((socketId) => entry.answers.get(socketId))
            .filter((answer): answer is EditorAnswer => Boolean(answer))

        const answered = responses.filter((a) => a.ok).length
        const envelope: QueryEnvelope = {
            count: responses.length,
            expected: entry.addressed.length,
            responses,
            timedOut,
            partial: answered !== responses.length,
            allFailed: answered === 0,
            warnings: entry.warnings,
        }
        entry.res.json({ reqID, ok: true, result: envelope })
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

        // Who this tab is. Upsert, so a re-hello (a rotated phone, a reconnect
        // that reused the socket) just refreshes the entry.
        socket.on(EDITOR_HELLO, (raw: unknown) => {
            const identity = sanitizeIdentity(raw)
            if (!identity) {
                console.warn(`[editor] ${socket.id} sent an unusable hello`)
                return
            }
            editors.set(socket.id, {
                ...identity,
                socketId: socket.id,
                connectedAt: Date.now(),
                identified: true,
            })
            console.log(`editor ${socket.id} → ${identity.label}`)
        })

        // Editors answer by emitting back on this fixed channel, carrying the
        // reqID that identifies which pending collection to fill.
        socket.on(REPLY_EVENT, (payload: EditorReply) => {
            const reqID = payload?.reqID
            if (!reqID) {
                console.warn(`[editor] reply without reqID from ${socket.id}`)
                return
            }
            const entry = pending.get(reqID)
            // Not waiting for this socket: already settled (timed out or
            // complete), a duplicate reply, or a socket that was never addressed.
            if (!entry || !entry.awaiting.has(socket.id)) {
                if (entry && !entry.warnedLate) {
                    entry.warnedLate = true
                    console.warn(`[editor ${reqID}] ignoring reply from ${socket.id} — not awaited`)
                }
                return
            }

            entry.awaiting.delete(socket.id)
            if (payload.ok) {
                const size = measure(payload.result)
                entry.answers.set(
                    socket.id,
                    size > EDITOR_ANSWER_MAX_BYTES
                        ? failure(
                              socket.id,
                              entry,
                              `answer too large (${Math.round(size / 1048576)}MB, cap ${Math.round(
                                  EDITOR_ANSWER_MAX_BYTES / 1048576,
                              )}MB) — narrow it with ?object= / ?maxDepth=`,
                          )
                        : {
                              editor: editorFor(socket.id),
                              ok: true,
                              elapsedMs: Date.now() - entry.startedAt,
                              result: payload.result,
                          },
                )
            } else {
                // This editor could not fulfil a request it did receive.
                entry.answers.set(socket.id, failure(socket.id, entry, payload.error))
            }

            if (entry.awaiting.size === 0) finish(reqID, false)
        })

        socket.on('disconnect', () => {
            console.log('disconnected: ', socket.id)
            // Capture the label before dropping the entry, so a request left
            // waiting on this socket can still name who dropped out.
            const info = editorFor(socket.id)
            editors.delete(socket.id)

            for (const [reqID, entry] of pending) {
                if (!entry.awaiting.has(socket.id)) continue
                // Its answer can never arrive — fail this slot now instead of
                // making the caller wait out the full timeout.
                entry.awaiting.delete(socket.id)
                entry.answers.set(socket.id, {
                    editor: info,
                    ok: false,
                    elapsedMs: Date.now() - entry.startedAt,
                    error: 'disconnected before answering',
                })
                if (entry.awaiting.size === 0) finish(reqID, false)
            }
        })
    })

    /** Forward one request to the pool (or to `?editor=`) and collect answers. */
    const dispatch = (
        kind: FacetKind,
        params: QueryParams | MutationParams,
        selector: string | undefined,
        res: Response,
    ) => {
        const reqID = makeReqID(kind)

        const target = resolveEditors(selector)
        if (!target.ok) {
            res.status(target.status).json({ reqID, ok: false, error: target.error })
            return
        }
        // Fast-fail when nothing can answer — don't make the caller wait out the
        // full timeout.
        if (target.sockets.length === 0) {
            res.status(503).json({ reqID, ok: false, error: 'no editor connected' })
            return
        }

        const entry: PendingRequest = {
            res,
            kind,
            // Backstop: end the request rather than leaving it hanging forever.
            // Cannot fire before `pending.set` below — a timer never runs
            // synchronously.
            timer: setTimeout(() => finish(reqID, true), EDITOR_QUERY_TIMEOUT_MS),
            addressed: target.sockets,
            awaiting: new Set(target.sockets),
            answers: new Map<string, EditorAnswer>(),
            startedAt: Date.now(),
            warnings: focusWarnings(kind, params, target.sockets.length),
            done: false,
            warnedLate: false,
        }
        pending.set(reqID, entry)

        for (const socketId of target.sockets) {
            // Look the socket up explicitly rather than `io.to(id).emit(...)`:
            // emitting into a dead socket's room is a silent no-op, whereas this
            // tells us the target is already gone so its slot can fail now.
            const socket = io.sockets.sockets.get(socketId)
            if (!socket) {
                entry.awaiting.delete(socketId)
                entry.answers.set(socketId, failure(socketId, entry, 'disconnected before answering'))
                continue
            }
            socket.emit(REQUEST_EVENT, { reqID, kind, params })
        }

        if (entry.awaiting.size === 0) finish(reqID, false)
    }

    // One GET route per queryable facet — they share the WS round-trip and
    // differ only in which facet the editor collects.
    for (const kind of Object.keys(QUERY_ROUTES) as QueryKind[]) {
        app.get(QUERY_ROUTES[kind], (req, res) => {
            dispatch(kind, queryParamsOf(req), editorSelectorOf(req), res)
        })
    }

    /**
     * Who is connected, and what they are.
     *
     * Guarded like the mutations rather than left open: `runSetup` binds
     * `0.0.0.0`, and this lists user agents, viewport sizes and the page each
     * tab is on — a fingerprint set that has no business being readable from the
     * rest of the wifi.
     */
    const guardLocal = (req: Request, res: Response, next: NextFunction) => {
        if (!isLoopback(req) || !isLocalOrigin(req)) {
            res.status(403).json({
                ok: false,
                error: 'this route is restricted to local callers',
            })
            return
        }
        next()
    }

    app.get(EDITOR_LIST_ROUTE, guardLocal, (_req, res) => {
        res.json(listEditors())
    })

    // Mutation routes share the same round-trip but are POST, and are the only
    // ones that change state — so they are guarded, and `?editor=` aims them.
    for (const kind of Object.keys(MUTATION_ROUTES) as MutationKind[]) {
        app.post(MUTATION_ROUTES[kind], guardLocal, (req, res) => {
            // express 5 leaves `req.body` undefined when no parser matched
            // (unlike v4's `{}`), so never destructure it unguarded.
            dispatch(kind, (req.body ?? {}) as MutationParams, editorSelectorOf(req), res)
        })
    }

    return { editorCount, listEditors }
}
