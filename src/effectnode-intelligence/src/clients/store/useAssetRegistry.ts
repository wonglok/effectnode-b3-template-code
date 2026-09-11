import type { Object3D } from 'three'
import { create } from 'zustand'
import type { ObservedResource, ResourceKind } from '../sceneResources'

/**
 * One resource the registry has seen in a scene walk.
 *
 * `firstSeenMs` / `lastSeenMs` are `performance.now()` stamps, so the gap
 * between them (plus `observations`) is what tells a leak from a one-off.
 */
export type SeenResource = ObservedResource & {
    firstSeenMs: number
    lastSeenMs: number
    /** how many walks still contained this resource */
    observations: number
    kind: ResourceKind
}

interface AssetRegistryStore {
    /**
     * uuid → the last walk that still contained it.
     *
     * This exists to answer one question a single walk cannot: *was this ever
     * in the scene?* A resource that was present and has since disappeared
     * without being disposed still occupies GPU memory — see `collectMemory`.
     */
    seen: Map<string, SeenResource>
    /** `$0` — the object an agent last addressed. */
    focus: Object3D | null
    focusLabel: string | null
    /** Record the resources a scene walk just found. */
    observe: (resources: ObservedResource[]) => void
    /** Point `$0` at an object, so later queries can say `$0`. */
    setFocus: (object: Object3D, label: string) => void
    /** Stop tracking a resource — used once it has been deliberately disposed. */
    forget: (uuids: Iterable<string>) => void
    /** Forget everything — call when a new canvas/scene mounts. */
    reset: () => void
}

export const useAssetRegistry = create<AssetRegistryStore>((set, get) => ({
    seen: new Map(),
    focus: null,
    focusLabel: null,

    observe: (resources) => {
        const now = performance.now()
        // Mutated in place on purpose: `seen` is read imperatively through
        // getState() when a query is answered, never subscribed to, and
        // rebuilding the Map on every walk would copy every resource each time.
        const seen = get().seen
        for (const resource of resources) {
            const previous = seen.get(resource.uuid)
            if (previous) {
                previous.lastSeenMs = now
                previous.observations++
                previous.name = resource.name
                previous.type = resource.type
            } else {
                seen.set(resource.uuid, {
                    ...resource,
                    firstSeenMs: now,
                    lastSeenMs: now,
                    observations: 1,
                })
            }
        }
    },

    setFocus: (object, label) => set({ focus: object, focusLabel: label }),

    forget: (uuids) => {
        const seen = get().seen
        for (const uuid of uuids) {
            seen.delete(uuid)
        }
    },

    reset: () => {
        get().seen.clear()
        set({ focus: null, focusLabel: null })
    },
}))
