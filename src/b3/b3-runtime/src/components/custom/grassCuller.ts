// ---------------------------------------------------------------------------
// Grass culler — keeps the drawn blades to a contiguous prefix of the instances
// ---------------------------------------------------------------------------
// The field is one instanced draw, so the only lever on how many blades are drawn
// is `geometry.instanceCount`, and that can only describe a prefix `[0, N)`.
// Getting from "these scattered roots are within 10 m of the player" to a prefix
// is therefore a rearrangement problem, not a filtering one.
//
// The arrangement here is a swap-based compaction. The per-instance data is never
// duplicated: the attribute arrays hold every blade, split into a drawn prefix
// and a hidden tail, and a boundary crossing is resolved by swapping the two
// blades involved. So
//
//   * the cost of an update is proportional to the number of blades crossing the
//     boundary, not to the size of the field or of the visible set;
//   * no second copy of the attributes is needed — 600k blades of orientation and
//     stretch would be ~29 MB of shadow data;
//   * the only state beyond the attributes is the permutation (`bladeAt` /
//     `slotOf`) and a membership byte per blade.
//
// Both views of the permutation are kept because the two passes need opposite
// lookups: eviction asks "which blade is in this slot", admission asks "which slot
// holds this blade".
//
// See `grassPointIndex.ts` for the spatial query, and `grassTSLMaterial.ts` for
// the shader half — the visible set can only change in whole steps, so the
// material fades blades out over a band inside the radius and no blade is ever
// seen to pop.
// ---------------------------------------------------------------------------

import { buildPointIndex } from './grassPointIndex'

/** Swap the `size` components of two records in an interleaved array. */
function swapBlock(array: Float32Array, a: number, b: number, size: number): void {
    const pa = a * size
    const pb = b * size

    for (let i = 0; i < size; i++) {
        const held = array[pa + i]
        array[pa + i] = array[pb + i]
        array[pb + i] = held
    }
}

/**
 * The per-instance arrays this rearranges, in the same layout the geometry
 * attributes use. They are permuted **in place**, so the caller must not hold a
 * separate expectation about their order.
 */
export interface GrassCullerBuffers {
    /** Blade roots, xyz per instance. */
    offset: Float32Array
    /** Blade root heading, quaternion per instance. */
    rootDirection: Float32Array
    /** Blade growth orientation, quaternion per instance. */
    orientation: Float32Array
    /** Per-blade height multiplier, one float per instance. */
    stretch: Float32Array
}

export interface GrassCullerOptions {
    /** Radius, in world units, at which the material shrinks a blade to nothing. */
    cullRadius: number
    /** Width of the shrink-out band just inside `cullRadius`. */
    fadeWidth: number
    /**
     * Re-query only once the player has moved this far. Clamped to `fadeWidth`,
     * which is what makes a whole-step set change invisible — see below.
     */
    updateDistance: number
    /** Points per BVH leaf. Smaller prunes harder, larger builds faster. */
    leafSize?: number
}

/**
 * A live view of the drawn prefix. The three counts are written by `update` —
 * read them after it returns true; treating them as inputs would desync the
 * buffers from what the draw believes.
 */
export interface GrassCuller {
    /** Blades in the field. */
    readonly count: number
    /** Blades currently in the drawn prefix. Write to `geometry.instanceCount`. */
    visibleCount: number
    /**
     * Slots `[dirtyStart, dirtyEnd)` hold data that changed in the last `update`
     * that returned true. In instance units, so an attribute of item size `n`
     * wants `addUpdateRange(dirtyStart * n, (dirtyEnd - dirtyStart) * n)`.
     */
    dirtyStart: number
    dirtyEnd: number
    /**
     * Recompute the visible set for a player at (`x`, `y`, `z`).
     *
     * Returns whether the set changed; when it returns false the caller has
     * nothing to upload. Call it every frame — it is the throttle inside that
     * decides, using `updateDistance`.
     */
    update(x: number, y: number, z: number): boolean
}

export function createGrassCuller(
    buffers: GrassCullerBuffers,
    options: GrassCullerOptions,
): GrassCuller {
    const { offset, rootDirection, orientation, stretch } = buffers
    const count = stretch.length

    // The index needs the roots to stay put, but the compaction below permutes
    // `offset`. So the tree is built over its own copy and keeps returning
    // original blade indices no matter how the live arrays are rearranged.
    const index = buildPointIndex(offset.slice(0, count * 3), options.leafSize ?? 16)

    // The permutation. `bladeAt[slot]` is the blade currently occupying a slot;
    // `slotOf[blade]` is that blade's slot. Both are needed, and both are exactly
    // the arrays the two passes below are shaped around.
    const bladeAt = new Int32Array(count)
    const slotOf = new Int32Array(count)
    for (let i = 0; i < count; i++) {
        bladeAt[i] = i
        slotOf[i] = i
    }

    const wanted = new Uint8Array(count)
    const candidates = new Int32Array(count)

    const fadeWidth = Math.max(0, options.fadeWidth)

    // A blade can only be seen to appear if it does so already inside the drawn
    // radius with room to fade in. Blades are admitted out to `queryRadius`, one
    // `fadeWidth` beyond the visible edge, and the query only has to keep up with
    // the player between updates. If they could move `updateDistance` away from
    // the last query, a blade could first be admitted at up to
    // `cullRadius + updateDistance` — so clamping the step to the band width is
    // what guarantees every blade is in the set before it is ever visible. With
    // `fadeWidth` 0 there is no band and the set has to track the player exactly.
    const updateDistance = Math.min(Math.max(0, options.updateDistance), fadeWidth)
    const queryRadius = options.cullRadius + fadeWidth

    let lastX = Infinity
    let lastY = Infinity
    let lastZ = Infinity

    const swapSlots = (a: number, b: number): void => {
        // Every pass below can land on this, and the no-op case is common (the
        // last visible slot backfilling itself), so it is cheaper to test here
        // than at each call site.
        if (a === b) return

        swapBlock(offset, a, b, 3)
        swapBlock(rootDirection, a, b, 4)
        swapBlock(orientation, a, b, 4)
        swapBlock(stretch, a, b, 1)

        const moved = bladeAt[a]
        bladeAt[a] = bladeAt[b]
        bladeAt[b] = moved

        slotOf[bladeAt[a]] = a
        slotOf[bladeAt[b]] = b
    }

    function update(x: number, y: number, z: number): boolean {
        if (count === 0) return false

        const stepX = x - lastX
        const stepY = y - lastY
        const stepZ = z - lastZ
        if (stepX * stepX + stepY * stepY + stepZ * stepZ < updateDistance * updateDistance) {
            return false
        }

        lastX = x
        lastY = y
        lastZ = z

        const found = index.querySphere(x, y, z, queryRadius, candidates)

        // Membership, not a list: both passes below ask "should this blade be
        // drawn" in the middle of walking slots, where a list would need a search.
        wanted.fill(0)
        for (let i = 0; i < found; i++) wanted[candidates[i]] = 1

        let dirtyFirst = Infinity
        let dirtyLast = -Infinity

        const markDirty = (slot: number): void => {
            // Only slots inside the drawn prefix are read by the draw. A slot at
            // or past `visibleCount` holds data the draw never touches, and is
            // refreshed if and when a later update swaps it into the prefix.
            if (slot >= culler.visibleCount) return

            if (slot < dirtyFirst) dirtyFirst = slot
            if (slot > dirtyLast) dirtyLast = slot
        }

        // --- 1. Evict the visible blades that have fallen out of range ---
        // Each hole is backfilled from the *end* of the prefix. That is what keeps
        // this from being a shift: only two records move per eviction, and the
        // backfilled blade is always taken from a slot the loop has not reached
        // yet, so no slot that already passed its test is ever overwritten.
        for (let slot = 0; slot < culler.visibleCount; ) {
            if (wanted[bladeAt[slot]] === 1) {
                slot++
                continue
            }

            // Shrinking the prefix first makes the old last visible slot the drop
            // target, and takes it out of the drawn range in the same step.
            culler.visibleCount--
            swapSlots(slot, culler.visibleCount)
            markDirty(slot)

            // Deliberately no `slot++`: the backfilled blade has not been tested.
        }

        // --- 2. Admit the blades that have come into range ---
        // Everything still wanted is either already in the prefix (kept by step 1)
        // or parked in the hidden tail, so walking the candidates finishes the job
        // in one pass over what is newly visible rather than a scan of the field.
        for (let i = 0; i < found; i++) {
            const blade = candidates[i]
            const slot = slotOf[blade]

            if (slot >= culler.visibleCount) {
                swapSlots(slot, culler.visibleCount)
                culler.visibleCount++
                markDirty(culler.visibleCount - 1)
            }
        }

        if (dirtyFirst > dirtyLast) {
            culler.dirtyStart = 0
            culler.dirtyEnd = 0
            return false
        }

        culler.dirtyStart = dirtyFirst
        culler.dirtyEnd = dirtyLast + 1

        return true
    }

    // Start with the whole field drawn rather than nothing. The player group is
    // published by NavMeshRig after its navmesh is built, so until then there is
    // no position to cull around, and the honest fallback is the current
    // behaviour — the complete field — not an empty one.
    const culler: GrassCuller = {
        count,
        visibleCount: count,
        dirtyStart: 0,
        dirtyEnd: 0,
        update,
    }

    return culler
}
