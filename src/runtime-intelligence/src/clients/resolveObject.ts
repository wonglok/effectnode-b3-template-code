import type { Object3D } from 'three'

/**
 * Resolve a `Selector` (see protocol.ts) to a live `Object3D`.
 *
 * The scene is indexed once per request rather than calling
 * `getObjectByName` / `getObjectByProperty` per lookup — a patch with twenty
 * ops would otherwise re-traverse the whole tree twenty times.
 */

export type SceneIndex = {
    root: Object3D
    byUuid: Map<string, Object3D>
    /** name → every object with that name, in depth-first order */
    byName: Map<string, Object3D[]>
}

export function indexScene(root: Object3D): SceneIndex {
    const byUuid = new Map<string, Object3D>()
    const byName = new Map<string, Object3D[]>()

    const visit = (object: Object3D) => {
        byUuid.set(object.uuid, object)
        if (object.name) {
            const existing = byName.get(object.name)
            if (existing) {
                existing.push(object)
            } else {
                byName.set(object.name, [object])
            }
        }
        for (const child of object.children) {
            visit(child)
        }
    }

    visit(root)
    return { root, byUuid, byName }
}

/** `A/B/C` — each token names a *child* of the previous node. */
function resolvePath(index: SceneIndex, path: string): Object3D | null {
    const tokens = path.split('/').filter(Boolean)
    if (tokens.length === 0) {
        return index.root
    }

    let current = index.root
    // Tolerate a leading token that names the root itself.
    if (tokens[0] === current.name || tokens[0] === current.uuid) {
        tokens.shift()
    }

    for (const token of tokens) {
        const next = current.children.find((child) => child.name === token || child.uuid === token)
        if (!next) {
            return null
        }
        current = next
    }
    return current
}

export type Resolution =
    | { object: Object3D; error?: undefined }
    | { object: null; error: string }

/**
 * Resolve `selector` against an indexed scene. `focus` is the current `$0`.
 *
 * Order: `$0` → exact uuid → child path (when it contains a `/`) → exact name.
 */
export function resolveSelector(index: SceneIndex, selector: string, focus: Object3D | null): Resolution {
    if (!selector) {
        return { object: null, error: 'empty selector' }
    }

    if (selector === '$0') {
        return focus
            ? { object: focus }
            : {
                  object: null,
                  error: 'no $0 yet — address an object by name, uuid or path first, and it becomes $0',
              }
    }

    const byUuid = index.byUuid.get(selector)
    if (byUuid) {
        return { object: byUuid }
    }

    if (selector.includes('/')) {
        const viaPath = resolvePath(index, selector)
        return viaPath
            ? { object: viaPath }
            : { object: null, error: `no object at path "${selector}"` }
    }

    const named = index.byName.get(selector)
    if (named && named.length > 0) {
        return { object: named[0] }
    }

    return {
        object: null,
        error: `no object named "${selector}" — pass a uuid, an "A/B/C" path, or check /api/query/scene`,
    }
}

/** A stable, human-readable label for an object, used for `$0`. */
export function labelOf(object: Object3D, index?: SceneIndex): string {
    if (object.name) {
        return object.name
    }
    if (index && object === index.root) {
        return 'scene'
    }
    return `${object.type}#${object.uuid.slice(0, 8)}`
}
