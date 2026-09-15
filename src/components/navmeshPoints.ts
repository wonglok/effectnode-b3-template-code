import { DEFAULT_QUERY_FILTER, findRandomPoint, type FindRandomPointResult, type NavMesh } from 'navcat'

/**
 * Shared navmesh point sampling.
 *
 * Both the NPC crowd and the health crates need "somewhere valid to put a
 * thing", and both need the same workaround for the same upstream quirk. It
 * lives here rather than being copied twice so the two cannot drift — the same
 * reason `armedClipSet.ts` exists.
 *
 * `navMesh` is a parameter on every call rather than something this module
 * caches: the rig replaces the whole mesh object on every rebuild, so a cached
 * reference would silently sample a mesh that no longer exists.
 *
 * Deliberately *not* extended with a `findNearestPoly` helper. That needs a
 * mutable `FindNearestPolyResult` scratch struct, and a module-level one shared
 * by two callers is an aliasing bug waiting to happen.
 */

/** Retries for the workaround below. 0.064^8 is about 3e-10. */
const DEFAULT_ATTEMPTS = 8

/**
 * A random walkable point, with retries — because `findRandomPoint` reports
 * failure on a point it actually found.
 *
 * It picks a polygon by area-weighted reservoir sampling, then rejects its
 * own result with `if (!selectedPoly || !selectedPolyRef)`. Node refs are
 * 1-based everywhere except the **first polygon of a tile, whose ref is
 * literally 0** — so every time the sampling happens to keep that polygon,
 * a perfectly good point is thrown away as `success: false`. Measured at
 * 6.4% on a 7-polygon mesh (it is just the odds that polygon 0 survives,
 * so it varies with that polygon's area share — higher on coarser meshes).
 *
 * One attempt per NPC would therefore under-spawn the crowd for no reason, and
 * one attempt per crate would leave crates unplaced. Eight is ample for the
 * base failure rate — but `attempts` is a parameter because a caller that
 * *also* rejects candidates on its own criteria (the crates avoid the player)
 * is drawing from a smaller effective pool and needs a larger budget.
 *
 * Returns the whole result, not just the position: the crowd's `scatter` needs
 * `nodeRef` to request a move target.
 */
export function randomNavMeshPoint(navMesh: NavMesh, attempts = DEFAULT_ATTEMPTS): FindRandomPointResult | null {
    for (let attempt = 0; attempt < attempts; attempt++) {
        const random = findRandomPoint(navMesh, DEFAULT_QUERY_FILTER, Math.random)
        if (random.success) return random
    }
    return null
}
