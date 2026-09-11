import type { Object3D } from 'three'
import type { JsonPatchOp } from '../protocol'
import { indexScene, labelOf, resolveSelector } from './resolveObject'

/**
 * A small RFC 6902 JSON Patch engine that operates on the live object graph
 * rather than on plain JSON.
 *
 * The target document is the scene, so a pointer's *first* token is a
 * {@link Selector} and the remaining tokens walk properties from there:
 *
 *     /player/position/y      →  scene.getObjectByName('player').position.y
 *     /Sun/intensity          →  the light named 'Sun'
 *
 * The usual JSON Pointer escape sequences apply (`~1` → `/`, `~0` → `~`).
 */

/**
 * Segments that would let a patch reach into the prototype chain. A patch is
 * authored by a language model, so this is untrusted input — without the guard,
 * `{"op":"replace","path":"/x/__proto__/polluted","value":1}` is a
 * prototype-pollution primitive.
 */
const FORBIDDEN_TOKENS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Material properties whose change alters three's pipeline cache key, forcing a
 * shader rebuild — which allocates a new GPU pipeline. Worth flagging, because
 * a rebuild that never gets cleaned up is exactly the leak /api/query/memory
 * reports, and the patch itself caused it.
 */
const REBUILD_KEYS = new Set([
    'wireframe',
    'side',
    'flatShading',
    'transparent',
    'alphaTest',
    'blending',
    'vertexColors',
    'fog',
    'map',
    'normalMap',
    'roughnessMap',
    'metalnessMap',
    'emissiveMap',
    'alphaMap',
    'aoMap',
    'displacementMap',
    'envMap',
    'defines',
])

export type PatchOpResult = {
    op: JsonPatchOp['op']
    path: string
    ok: boolean
    /** the value the op replaced or removed, when there was one */
    previous?: unknown
    error?: string
}

export type PatchOutcome = {
    /** how many ops were applied */
    applied: number
    results: PatchOpResult[]
    /**
     * True when an op failed and the remainder were skipped. RFC 6902 intends a
     * patch to be atomic; this engine stops on the first failure rather than
     * rolling back, so a partial patch leaves the scene partly modified. The
     * `results` array says exactly how far it got.
     */
    partial: boolean
    /** paths whose change likely forced a shader/pipeline rebuild */
    rebuildRisk: string[]
}

/** RFC 6901 unescaping. */
export function unescapeToken(token: string): string {
    return token.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** Split a JSON Pointer whose first token is a scene selector. */
export function parsePointer(path: string): string[] {
    if (path === '') {
        return []
    }
    if (!path.startsWith('/')) {
        throw new Error(`path must start with "/": ${JSON.stringify(path)}`)
    }
    const tokens = path.slice(1).split('/').map(unescapeToken)
    for (const token of tokens) {
        if (FORBIDDEN_TOKENS.has(token)) {
            throw new Error(`path segment ${JSON.stringify(token)} is not addressable`)
        }
    }
    return tokens
}

function readToken(container: unknown, token: string): unknown {
    if (container === null || container === undefined) {
        return undefined
    }
    if (Array.isArray(container)) {
        if (token === '-') {
            return undefined
        }
        return container[Number(token)]
    }
    if (typeof container !== 'object') {
        return undefined
    }
    return (container as Record<string, unknown>)[token]
}

function hasToken(container: unknown, token: string): boolean {
    if (container === null || container === undefined) {
        return false
    }
    if (Array.isArray(container)) {
        if (token === '-') {
            return false
        }
        const index = Number(token)
        return Number.isInteger(index) && index >= 0 && index < container.length
    }
    if (typeof container !== 'object') {
        return false
    }
    return token in (container as object)
}

function writeToken(container: unknown, token: string, value: unknown, mode: 'add' | 'replace'): void {
    if (Array.isArray(container)) {
        if (token === '-') {
            container.push(value)
            return
        }
        const index = Number(token)
        if (mode === 'add') {
            container.splice(index, 0, value)
        } else {
            container[index] = value
        }
        return
    }
    if (container === null || typeof container !== 'object') {
        throw new Error('cannot set a property on a non-object')
    }
    ;(container as Record<string, unknown>)[token] = value
}

function removeToken(container: unknown, token: string): unknown {
    if (Array.isArray(container)) {
        return container.splice(Number(token), 1)[0]
    }
    if (container === null || typeof container !== 'object') {
        throw new Error('cannot delete a property on a non-object')
    }
    const record = container as Record<string, unknown>
    const previous = record[token]
    delete record[token]
    return previous
}

/** Walk `tokens` from `start`, returning whatever is at the end. */
function walk(start: unknown, tokens: string[]): unknown {
    let current = start
    for (const token of tokens) {
        current = readToken(current, token)
        if (current === undefined || current === null) {
            return current
        }
    }
    return current
}

/**
 * Structural equality, depth-bounded. The object graph is cyclic (an Object3D
 * holds its parent and its children), so an unbounded walk would not terminate.
 */
function deepEqual(a: unknown, b: unknown, depth = 0): boolean {
    if (a === b) {
        return true
    }
    if (depth > 4 || a === null || b === null) {
        return false
    }
    if (typeof a !== typeof b || typeof a !== 'object') {
        return false
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
        return false
    }
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) {
        return false
    }
    return keys.every((key) => deepEqual(left[key], right[key], depth + 1))
}

export type ApplyPatchOptions = {
    /** the scene root (or any subtree root) to patch */
    scene: Object3D
    /** the current `$0` */
    focus: Object3D | null
    ops: JsonPatchOp[]
    /** called with the object each addressable op resolved, to update `$0` */
    onFocus?: (object: Object3D, label: string) => void
}

/**
 * Apply a JSON Patch to the live scene. See {@link PatchOutcome.partial} for the
 * atomicity caveat.
 */
export function applyPatch(options: ApplyPatchOptions): PatchOutcome {
    const { scene, focus, ops, onFocus } = options
    const index = indexScene(scene)

    // Parse every pointer before touching anything, so a malformed patch can
    // never leave the scene half-modified.
    const parsedPaths = ops.map((op) => parsePointer(op.path))
    const parsedFrom = ops.map((op) => (op.from === undefined ? null : parsePointer(op.from)))

    const results: PatchOpResult[] = []
    const rebuildRisk: string[] = []
    let applied = 0
    let partial = false

    for (let i = 0; i < ops.length; i++) {
        const op = ops[i]
        const tokens = parsedPaths[i]
        const fail = (error: string): void => {
            results.push({ op: op.op, path: op.path, ok: false, error })
            partial = true
        }

        if (tokens.length === 0) {
            fail('path must address an object and at least one of its properties, e.g. /Sun/intensity')
            break
        }

        const resolution = resolveSelector(index, tokens[0], focus)
        if (!resolution.object) {
            fail(resolution.error)
            break
        }
        const target = resolution.object
        onFocus?.(target, labelOf(target, index))

        const rest = tokens.slice(1)
        if (rest.length === 0) {
            fail('path must address a property of the object, e.g. /Sun/intensity — the object itself cannot be replaced')
            break
        }

        const parentTokens = rest.slice(0, -1)
        const lastToken = rest[rest.length - 1]
        const parent = walk(target, parentTokens)

        if (parent === undefined || parent === null) {
            fail(`no value at /${[...tokens.slice(0, -1)].join('/')}`)
            break
        }

        try {
            switch (op.op) {
                case 'add': {
                    if (Array.isArray(parent) && lastToken !== '-' && Number(lastToken) > parent.length) {
                        throw new Error(`array index ${lastToken} is out of range`)
                    }
                    writeToken(parent, lastToken, op.value, 'add')
                    results.push({ op: op.op, path: op.path, ok: true })
                    applied++
                    break
                }
                case 'replace': {
                    if (!hasToken(parent, lastToken)) {
                        throw new Error(`no value at ${op.path}`)
                    }
                    const previous = readToken(parent, lastToken)
                    writeToken(parent, lastToken, op.value, 'replace')
                    results.push({ op: op.op, path: op.path, ok: true, previous })
                    applied++
                    break
                }
                case 'remove': {
                    if (!hasToken(parent, lastToken)) {
                        throw new Error(`no value at ${op.path}`)
                    }
                    const previous = removeToken(parent, lastToken)
                    results.push({ op: op.op, path: op.path, ok: true, previous })
                    applied++
                    break
                }
                case 'move':
                case 'copy': {
                    const fromTokens = parsedFrom[i]
                    if (!fromTokens || fromTokens.length === 0) {
                        throw new Error(`"${op.op}" requires a "from" pointer`)
                    }
                    const fromResolution = resolveSelector(index, fromTokens[0], focus)
                    if (!fromResolution.object) {
                        throw new Error(fromResolution.error)
                    }
                    const fromRest = fromTokens.slice(1)
                    if (fromRest.length === 0) {
                        throw new Error('"from" must address a property, not a whole object')
                    }
                    const fromParent = walk(fromResolution.object, fromRest.slice(0, -1))
                    const fromLast = fromRest[fromRest.length - 1]
                    if (fromParent === undefined || fromParent === null || !hasToken(fromParent, fromLast)) {
                        throw new Error(`no value at ${op.from}`)
                    }
                    const moved = readToken(fromParent, fromLast)
                    if (op.op === 'move') {
                        removeToken(fromParent, fromLast)
                    }
                    writeToken(parent, lastToken, moved, 'add')
                    results.push({ op: op.op, path: op.path, ok: true })
                    applied++
                    break
                }
                case 'test': {
                    const actual = readToken(parent, lastToken)
                    if (!deepEqual(actual, op.value)) {
                        throw new Error(
                            `test failed at ${op.path}: expected ${JSON.stringify(op.value)}, found ${JSON.stringify(actual)}`,
                        )
                    }
                    results.push({ op: op.op, path: op.path, ok: true })
                    applied++
                    break
                }
                default: {
                    throw new Error(`unsupported op ${JSON.stringify((op as { op: string }).op)}`)
                }
            }
        } catch (error) {
            fail((error as Error).message)
            break
        }

        if (REBUILD_KEYS.has(lastToken)) {
            rebuildRisk.push(op.path)
        }
    }

    // A mutated transform is only visible to a later /api/query/scene once world
    // matrices are recomputed, and our collectors run outside the render loop.
    if (applied > 0) {
        scene.updateWorldMatrix(false, true)
    }

    return { applied, results, partial, rebuildRisk }
}
