/**
 * Wire protocol shared by the backend (`src/core`) and the in-canvas editor
 * (`src/clients`).
 *
 * The two halves never import each other — they only meet over socket.io — so
 * this module is deliberately free of runtime dependencies and of any Node- or
 * DOM-only code. It is resolved two ways: the server loads it through tsx, the
 * browser through Vite. Keep it to types + plain constants.
 */

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

/**
 * A queryable facet of the live scene. Each key is both a GET route (see
 * {@link QUERY_ROUTES}) and a key in the editor's collector registry, so a
 * request only ever ships back the slice that was asked for.
 */
export type QueryKind = 'scene' | 'performance' | 'memory' | 'drawcalls' | 'shader'

/**
 * A mutation the agent can apply to the live scene. All three share the same
 * request/response round-trip as a query; they differ only in HTTP method.
 */
export type MutationKind = 'patch' | 'eval' | 'dispose'

/** Every facet addressable over the wire. */
export type FacetKind = QueryKind | MutationKind

/** GET routes — each answers with the current state of its facet. */
export const QUERY_ROUTES: Record<QueryKind, string> = {
    /** Scene graph digest — hierarchy + spatial bounds + cull flags. */
    scene: '/api/query/scene',
    /** Performance insight — geometry / per-object cost + live frame runtime. */
    performance: '/api/query/performance',
    /** Resource registry — geometries / materials / textures + leak candidates. */
    memory: '/api/query/memory',
    /** Draw-call dependency map — mesh → material → texture, ranked by cost. */
    drawcalls: '/api/query/drawcalls',
    /** Compiled shader source + uniforms + the material's active feature set. */
    shader: '/api/query/shader',
}

/** POST routes — each applies a change and reports what happened. */
export const MUTATION_ROUTES: Record<MutationKind, string> = {
    /** RFC 6902 JSON Patch against the scene graph. */
    patch: '/api/mutation/patch',
    /** Restricted REPL — run a snippet against the live runtime. */
    eval: '/api/mutation/eval',
    /** Dispose a subtree's geometries / materials / textures. */
    dispose: '/api/mutation/dispose',
}

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/**
 * Addresses a single object in the scene graph. Resolved in this order:
 *
 *  - `$0`      the object the agent last addressed (see `useAssetRegistry`)
 *  - a uuid    exact match on `Object3D.uuid`
 *  - `A/B/C`   a child path walked from the scene root (contains a `/`)
 *  - `Name`    first object in the tree whose `name` matches exactly
 */
export type Selector = string

/** Per-request options for a query. Every field is optional. */
export type QueryParams = {
    /** `scene`: cap recursion depth (1 = the root's immediate children). */
    maxDepth?: number
    /** Walk only this subtree instead of the whole scene. */
    object?: Selector
    /** `shader`: cap on returned source length, in characters. */
    maxChars?: number
}

/**
 * A single RFC 6902 operation. `path` is a JSON Pointer whose *first* token is
 * a {@link Selector} rather than a JSON key, because the target document is the
 * live object graph rather than a plain JSON value:
 *
 *     { "op": "replace", "path": "/player/position/y", "value": 15 }
 */
export type JsonPatchOp = {
    op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'
    /** JSON Pointer, first token is a Selector. */
    path: string
    /** `add` / `replace` / `test`. */
    value?: unknown
    /** `move` / `copy`. */
    from?: string
}

/** Body of a POST to a {@link MUTATION_ROUTES} path. */
export type MutationParams = {
    /** `patch`: the operations to apply, in order. */
    patch?: JsonPatchOp[]
    /** `eval`: the snippet to run. */
    code?: string
    /** The subtree to act on, and/or the object to bind as `$0`. */
    object?: Selector
}

// ---------------------------------------------------------------------------
// Socket.io handshake
// ---------------------------------------------------------------------------

/** server → every connected editor. */
export const REQUEST_EVENT = 'req:query'

/** editor → server, carrying the reqID that identifies the waiting request. */
export const REPLY_EVENT = 'res:query'

/** editor → server, once per connect, naming the device behind the tab. */
export const EDITOR_HELLO = 'editor:hello'

/**
 * Bumped whenever the wire shape changes incompatibly. There is no test suite
 * and server and client share no type-level link, so a stale browser bundle
 * that still listens for an old event name would fail *silently* — every
 * request would sit until the 15s timeout. The editor sends this in its
 * handshake and the server refuses a mismatch, turning that into an immediate,
 * legible 503.
 *
 * 2: every route now answers with a per-editor envelope instead of the single
 * winning reply, and editors announce themselves with {@link EDITOR_HELLO}.
 */
export const PROTOCOL_VERSION = 2

/** Editor sockets join this room so requests target only them. */
export const EDITOR_ROOM = 'editor-room'

/** How long a request waits for an editor to answer before giving up. */
export const EDITOR_QUERY_TIMEOUT_MS = 15_000

/** GET route listing the connected editors. Guarded like the mutations. */
export const EDITOR_LIST_ROUTE = '/api/editors'

/**
 * Cap on one editor's serialized answer.
 *
 * engine.io's `maxHttpBufferSize` bounds *inbound* frames and
 * `express.json({ limit })` bounds *request* bodies — neither bounds the HTTP
 * response, which is now the sum of every editor's answer. `JSON.stringify`
 * throws `RangeError` past V8's ~512MB string limit, so fanning a large
 * `?object=scene` across three tabs would surface as an opaque 500. An over-size
 * answer is replaced by an error naming the lever (`?object=`, `?maxDepth=`)
 * instead, and the envelope is marked `partial`.
 */
export const EDITOR_ANSWER_MAX_BYTES = 32 * 1024 * 1024

// ---------------------------------------------------------------------------
// Editor identity
// ---------------------------------------------------------------------------

/**
 * What an editor announces on connect, so the server can name it in a response
 * and address it with `?editor=`.
 *
 * Nothing here is trusted: the server caps every field on arrival, because a
 * buggy or hostile tab would otherwise be free to bloat `/api/editors` and the
 * agent's context with it.
 */
export type EditorIdentity = {
    /** Stable for the life of the tab — survives a reload (via sessionStorage). */
    id: string
    /**
     * Fresh on every page load. A duplicated tab inherits the same `sessionStorage`
     * and therefore the same `id`, so this is what tells two live tabs apart.
     */
    loadId: string
    /** Human label, e.g. `"iOS · Safari · /production"`. */
    label: string
    platform: string
    browser: string
    /** Route path the editor is mounted on, e.g. `/production`. */
    page: string
    viewport: { width: number; height: number }
    devicePixelRatio: number
    userAgent: string
}

/** A connected editor, as the server knows it. */
export type EditorInfo = EditorIdentity & {
    /** socket.io's id — the transport handle, and what a request targets. */
    socketId: string
    connectedAt: number
    /**
     * `false` for a socket that joined the room without sending a hello. It can
     * still answer requests; it just cannot be targeted by `?editor=`.
     */
    identified: boolean
}

/** One editor's answer inside a fan-out response. */
export type EditorAnswer =
    | { editor: EditorInfo; ok: true; elapsedMs: number; result: unknown }
    | { editor: EditorInfo; ok: false; elapsedMs: number; error: string }

/**
 * The body of `result` on **every** route — one answer per connected editor,
 * rather than the single first reply it used to be.
 *
 * Read `responses` as the point of the whole thing: an iPhone, an Android and a
 * laptop each report their own frame timings for the same scene.
 */
export type QueryEnvelope = {
    /** `responses.length` — the fan-out width actually collected. */
    count: number
    /** how many editors the request was addressed to, before any dropped out. */
    expected: number
    responses: EditorAnswer[]
    /** at least one addressed editor never answered before the timeout. */
    timedOut: boolean
    /** at least one answer is `ok: false` — the editors have diverged. */
    partial: boolean
    /** every answer failed. */
    allFailed: boolean
    /** caveats about how to read this envelope, e.g. a per-tab `$0`. */
    warnings: string[]
}

/** What the editor sends back for one request. Unchanged from v1. */
export type EditorReply =
    | { reqID: string; ok: true; result: unknown }
    | { reqID: string; ok: false; error: string }

/** What a client sees when the request could not be dispatched at all. */
export type ErrorReply = { reqID: string; ok: false; error: string }

/** What a client sees when the fan-out ran. */
export type SuccessReply = { reqID: string; ok: true; result: QueryEnvelope }
