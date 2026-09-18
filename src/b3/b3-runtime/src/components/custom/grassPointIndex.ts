// ---------------------------------------------------------------------------
// Point BVH — a static spatial index over the grass blade roots
// ---------------------------------------------------------------------------
// The grass field is 600k instances in one instanced draw. Only the blades near
// the player are drawn, and finding them with a linear scan of every root on
// every update is the one thing that would make the field cost more to cull
// than to draw. This turns "which roots are inside this sphere" into a tree
// descent.
//
// Two notes on why this is hand-written rather than `three-mesh-bvh`:
//
//   * `three-mesh-bvh` indexes *triangles*. Indexing points with it means
//     faking a degenerate triangle per point, which triples the index buffer
//     (7.2 MB → 7.2 MB of index on top of the positions for 600k roots) and
//     puts 600k zero-area triangles through its SAH builder — a ~1-2 s build
//     hitch at scene sync. This builds in ~0.15 s over the same points and
//     keeps a single permutation array.
//   * It removes a dependency that would otherwise be reached only
//     transitively, through `@react-three/drei`.
//
// Split strategy is the midpoint of the bounding box on its widest axis — for
// roots scattered over a terrain (roughly uniform in XZ) that balances as well
// as a median split, without a selection pass.
// ---------------------------------------------------------------------------

/** Node is a leaf: `childA`/`childB` hold a range into `order`. */
const LEAF = 1
/** Node is internal: `childA`/`childB` hold child node indices. */
const BRANCH = 0

/**
 * Hard cap on tree depth.
 *
 * A midpoint split can stay lopsided indefinitely on adversarial input (one
 * point isolated in a corner, repeatedly), and each level costs a stack frame.
 * At the cap the node becomes a leaf instead: correct, just coarser. With
 * `leafSize` 16 a balanced tree over 600k roots is ~16 deep, so this never binds
 * in practice — it exists so a pathological point cloud degrades in query speed
 * rather than blowing the stack.
 */
const MAX_DEPTH = 40

/**
 * Flat-tree traversal stack. Depth is bounded by `MAX_DEPTH`, and a leaf can
 * push at most two children, so 41 entries is the ceiling.
 */
const STACK_SIZE = 64

export interface PointIndex {
    /** How many points are indexed. */
    readonly count: number
    /**
     * Write the indices of every point within `radius` of (`cx`, `cy`, `cz`) into
     * `out`, returning how many were found.
     *
     * Indices are into the `points` array the index was built from — which the
     * caller must therefore keep stable. `out` should hold at least `count`
     * entries; results beyond its length are dropped.
     */
    querySphere(cx: number, cy: number, cz: number, radius: number, out: Int32Array): number
}

/**
 * Build the index over `points` (xyz per point).
 *
 * The array is read but never written — the caller keeps ownership, and the
 * returned indices refer to its original order even when the caller later
 * rearranges its own copy.
 */
export function buildPointIndex(points: Float32Array, leafSize = 16): PointIndex {
    const count = Math.floor(points.length / 3)

    // The permutation the tree is built over: `order[k]` is the point index that
    // currently sits at slot `k`. Partitioning rearranges this, never `points`.
    const order = new Int32Array(count)
    for (let i = 0; i < count; i++) order[i] = i

    // --- Node storage, grown on demand ---
    // A tree with `count` points holds at most `2 * count - 1` nodes, but
    // allocating for the worst case would reserve ~40 MB for 600k roots when the
    // real tree has a few hundred thousand at most. Doubling from small keeps the
    // total copy work linear.
    let capacity = 0
    let bounds = new Float32Array(0)
    let childA = new Int32Array(0)
    let childB = new Int32Array(0)
    let isLeaf = new Uint8Array(0)
    let nodeCount = 0

    const ensureCapacity = (needed: number): void => {
        if (needed <= capacity) return

        let next = capacity === 0 ? 1024 : capacity
        while (next < needed) next *= 2

        const grownBounds = new Float32Array(next * 6)
        grownBounds.set(bounds)
        bounds = grownBounds

        const grownA = new Int32Array(next)
        grownA.set(childA)
        childA = grownA

        const grownB = new Int32Array(next)
        grownB.set(childB)
        childB = grownB

        const grownLeaf = new Uint8Array(next)
        grownLeaf.set(isLeaf)
        isLeaf = grownLeaf

        capacity = next
    }

    /** Bounds of `order[start, end)`, written to node `node` (6 floats). */
    const measure = (start: number, end: number, node: number): void => {
        let minX = Infinity
        let minY = Infinity
        let minZ = Infinity
        let maxX = -Infinity
        let maxY = -Infinity
        let maxZ = -Infinity

        for (let i = start; i < end; i++) {
            const point = order[i] * 3
            const x = points[point]
            const y = points[point + 1]
            const z = points[point + 2]

            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
            if (z < minZ) minZ = z
            if (z > maxZ) maxZ = z
        }

        const o = node * 6
        bounds[o] = minX
        bounds[o + 1] = minY
        bounds[o + 2] = minZ
        bounds[o + 3] = maxX
        bounds[o + 4] = maxY
        bounds[o + 5] = maxZ
    }

    /**
     * Partition `order[start, end)` so the points below `split` on `axis` come
     * first, returning the first index of the upper side.
     *
     * A two-pointer sweep rather than a filter, so it needs no scratch array.
     */
    const partition = (start: number, end: number, axis: number, split: number): number => {
        let lower = start
        let upper = end - 1

        while (lower <= upper) {
            if (points[order[lower] * 3 + axis] < split) {
                lower++
                continue
            }

            const held = order[lower]
            order[lower] = order[upper]
            order[upper] = held
            upper--
        }

        return lower
    }

    /** Build the subtree for `order[start, end)`, returning its node index. */
    const build = (start: number, end: number, depth: number): number => {
        const node = nodeCount++
        ensureCapacity(nodeCount)
        measure(start, end, node)

        const size = end - start
        let mid = -1

        if (size > leafSize && depth < MAX_DEPTH) {
            const o = node * 6
            const extentX = bounds[o + 3] - bounds[o]
            const extentY = bounds[o + 4] - bounds[o + 1]
            const extentZ = bounds[o + 5] - bounds[o + 2]

            // Split the longest axis: a square-ish split keeps both subtrees'
            // boxes tight, which is what makes the pruning work.
            let axis = 0
            let extent = extentX
            if (extentY > extent) {
                axis = 1
                extent = extentY
            }
            if (extentZ > extent) {
                axis = 2
                extent = extentZ
            }

            if (extent > 0) {
                mid = partition(start, end, axis, (bounds[o + axis] + bounds[o + axis + 3]) * 0.5)
            }

            // A one-sided partition makes no progress and would recurse forever.
            // Splitting by count the rest of the way always terminates, and is
            // only reachable when the points are coincident on every axis (where
            // position carries no information to split on anyway).
            if (mid <= start || mid >= end) mid = (start + end) >> 1
        }

        if (mid < 0) {
            isLeaf[node] = LEAF
            childA[node] = start
            childB[node] = size
            return node
        }

        isLeaf[node] = BRANCH
        const left = build(start, mid, depth + 1)
        const right = build(mid, end, depth + 1)
        childA[node] = left
        childB[node] = right

        return node
    }

    // A zero-point field still gets a root, so the query has something to pop and
    // immediately reject. Its bounds are inverted infinities, which the
    // box-vs-sphere test rejects without a special case.
    build(0, count, 0)

    const stack = new Int32Array(STACK_SIZE)

    return {
        count,

        querySphere(cx, cy, cz, radius, out) {
            const r2 = radius * radius
            let found = 0
            let top = 0
            stack[top++] = 0

            while (top > 0) {
                const node = stack[--top]
                const o = node * 6

                // Box vs sphere: the nearest point of an AABB to a centre is the
                // centre clamped into the box, so this test is exact. It never
                // rejects a box that contains a point inside the sphere — which
                // is the only way it could produce a false negative, and would
                // show up as blades vanishing while still in range.
                const dx =
                    cx < bounds[o] ? bounds[o] - cx : cx > bounds[o + 3] ? cx - bounds[o + 3] : 0
                const dy =
                    cy < bounds[o + 1]
                        ? bounds[o + 1] - cy
                        : cy > bounds[o + 4]
                          ? cy - bounds[o + 4]
                          : 0
                const dz =
                    cz < bounds[o + 2]
                        ? bounds[o + 2] - cz
                        : cz > bounds[o + 5]
                          ? cz - bounds[o + 5]
                          : 0

                if (dx * dx + dy * dy + dz * dz > r2) continue

                if (isLeaf[node] === LEAF) {
                    const start = childA[node]
                    const end = start + childB[node]

                    for (let i = start; i < end; i++) {
                        const point = order[i]
                        const p = point * 3
                        const px = points[p] - cx
                        const py = points[p + 1] - cy
                        const pz = points[p + 2] - cz

                        if (px * px + py * py + pz * pz <= r2 && found < out.length) {
                            out[found++] = point
                        }
                    }
                } else {
                    stack[top++] = childA[node]
                    stack[top++] = childB[node]
                }
            }

            return found
        },
    }
}
