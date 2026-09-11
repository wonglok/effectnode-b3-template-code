/**
 * Project a live JS value onto something JSON-safe and small.
 *
 * Used for both shader uniform values and REPL results, so the two agree on how
 * a `Vector3`, a `Color` or a `Float32Array` reads. The object graph it walks is
 * cyclic and enormous (three's `Object3D` references its parent, its children,
 * its geometry, …), so three types are identified rather than expanded, and
 * depth is bounded at every branch.
 *
 * Design rule: **never silently drop a value.** An earlier version kept only
 * scalars when expanding a plain object, which quietly discarded arrays — so a
 * REPL result like `{ min: [1,2,3] }` came back as `{}`. Summarising loudly is
 * always better than omitting quietly.
 */

/** Arrays nested deeper than this collapse to a length descriptor. */
const MAX_ARRAY_DEPTH = 5
/** Plain objects nested deeper than this collapse to `[…]`. */
const MAX_OBJECT_DEPTH = 3
/** Items kept from one array. */
const MAX_ARRAY_ITEMS = 16
/** Keys kept from one object. */
const MAX_OBJECT_KEYS = 25

export function serializeValue(value: unknown, depth = 0): unknown {
    if (value === null || value === undefined) {
        return null
    }

    const kind = typeof value
    if (kind === 'number' || kind === 'boolean' || kind === 'string') {
        return value
    }
    if (kind === 'bigint') {
        return String(value)
    }
    if (kind === 'function') {
        return '[function]'
    }
    if (kind === 'symbol') {
        return String(value)
    }

    // Typed arrays: a descriptor, never the contents.
    if (ArrayBuffer.isView(value)) {
        const view = value as unknown as { length: number; constructor: { name: string } }
        return `[${view.constructor.name}(${view.length})]`
    }

    // Arrays are handled before the depth bail so that a shallow array nested
    // inside a deep object (a bounding box, a position tuple) still comes back
    // as numbers rather than being cut off.
    if (Array.isArray(value)) {
        if (depth > MAX_ARRAY_DEPTH) {
            return `[Array(${value.length})]`
        }
        const head = value.slice(0, MAX_ARRAY_ITEMS).map((entry) => serializeValue(entry, depth + 1))
        return value.length > MAX_ARRAY_ITEMS ? [...head, `…+${value.length - MAX_ARRAY_ITEMS}`] : head
    }

    if (depth > MAX_OBJECT_DEPTH) {
        return '[…]'
    }

    const object = value as Record<string, unknown>

    // ---- three types we can describe precisely ----------------------------
    if (typeof object.getHex === 'function') {
        return object.getHex() // THREE.Color
    }
    if (object.isTexture) {
        return { texture: object.uuid, name: object.name || undefined }
    }
    if (object.isVector2 || object.isVector3 || object.isVector4 || object.isQuaternion) {
        const tuple = [object.x, object.y, object.z, object.w].filter((n) => n !== undefined)
        return tuple.map((n) => (typeof n === 'number' ? n : null))
    }
    if (object.isMatrix4 || object.isMatrix3 || object.elements) {
        const elements = object.elements as { length?: number } | undefined
        return `[Matrix(${elements?.length ?? '?'})]`
    }
    // Identify, but never walk into, the heavy graph nodes.
    if (object.isObject3D) {
        return { object3D: object.uuid as string, name: (object.name as string) || undefined }
    }
    if (object.isBufferGeometry) {
        return { geometry: object.uuid as string }
    }
    if (object.isMaterial) {
        return { material: object.uuid as string }
    }

    // ---- a plain object: expand it ----------------------------------------
    const keys = Object.keys(object)
    const out: Record<string, unknown> = {}
    for (const key of keys.slice(0, MAX_OBJECT_KEYS)) {
        const entry = object[key]
        const entryKind = typeof entry
        if (entry === null || entryKind === 'number' || entryKind === 'boolean' || entryKind === 'string') {
            out[key] = entry
        } else if (entryKind === 'object') {
            out[key] = serializeValue(entry, depth + 1)
        } else if (entryKind === 'function') {
            out[key] = '[function]'
        }
    }
    if (keys.length > MAX_OBJECT_KEYS) {
        out['…'] = `+${keys.length - MAX_OBJECT_KEYS} more keys`
    }
    return out
}
