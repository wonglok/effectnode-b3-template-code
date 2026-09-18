/**
 * The jump's force field: the maths behind the pulse.
 *
 * The field is not an instant. It is a ring sweeping outward from the player
 * over {@link FORCE_FIELD_SWEEP_SECONDS} — the same second the floor ring takes
 * to reach its edge, since both read that one constant — and it acts on things
 * **as it passes them**. An NPC 4 m away is thrown when the wave arrives at 4 m,
 * not when the player leaves the ground, which is what makes the pulse read as
 * the cause rather than as decoration.
 *
 * The three questions that takes are answered here rather than inline in
 * `npcEnemies`, for one reason: the crowd cannot be built in a headless harness
 * (it needs a navmesh and every avatar's FBX), so anything left inline is
 * verifiable only by eye. These are pure, so the arithmetic — the part that can
 * be quietly wrong — is somewhere a test can reach it.
 *
 * The wave's *shape* and its *duration* are both shared with the floor ring: the
 * ring is not a depiction of the field, it is the field's edge. See
 * {@link FORCE_FIELD_SWEEP_SECONDS} and {@link forceFieldEase}.
 */

/**
 * Seconds the ring takes to travel from the player out to `forceFieldRadius`.
 *
 * One constant, two consumers: the field's own sweep, and the floor ring's
 * tween. They are the same event, so a second copy of this number would be the
 * visual and the mechanic drifting apart — the ring reaching an NPC a moment
 * before or after the wave does.
 */
export const FORCE_FIELD_SWEEP_SECONDS = 1

/**
 * The pulse's shape: the edge leaves the centre quickly and slows into the rim,
 * so the wave does not read as a metronome.
 *
 * Exported as a *function* because it has two consumers that have to agree — the
 * sweep below, and the floor ring's gsap tween in `LoadCollider`, which takes it
 * as its `ease`. Sharing the function rather than re-typing its name is the same
 * discipline as sharing the duration: a push running on a different curve from
 * the ring is invisible in the source and obvious in the game, where things get
 * thrown a fraction of a second before or after the edge appears to reach them.
 *
 * `1 - (1 - t)²` — gsap's `power1.out`, written out here so neither side depends
 * on the other's spelling of it.
 */
export const forceFieldEase = (t: number): number => 1 - (1 - t) * (1 - t)

/**
 * How far out the ring's edge has travelled `elapsed` seconds into the sweep.
 *
 * On the same curve as the ring itself, so the wave that pushes *is* the wave on
 * screen: an NPC is thrown at the moment the visible edge passes it.
 */
export function sweepReach(radius: number, elapsed: number): number {
    if (!(radius > 0)) return 0
    const t = Math.min(1, Math.max(0, elapsed / FORCE_FIELD_SWEEP_SECONDS))
    return radius * forceFieldEase(t)
}

/**
 * Did the ring just cross `distance`, given where its edge was last frame and
 * where it is now?
 *
 * The interval is half-open — `previous < distance <= current` — which is what
 * makes the sweep act on each thing exactly once. Consecutive frames tile the
 * whole reach with no gap and no overlap, so every distance falls in exactly one
 * frame's interval however fast the ring is travelling or however long the
 * frame: nothing inside the field is stepped over between frames, and nothing is
 * hit twice.
 */
export function ringJustCrossed(distance: number, previousReach: number, reach: number): boolean {
    return distance > previousReach && distance <= reach
}

/**
 * The outward speed that throws an agent `distance` world units, given how hard
 * it can decelerate (`Agent.maxAcceleration`).
 *
 * An impulse rather than a teleport, so the crowd's own integrator carries the
 * NPC out: `integrate` clamps the change in velocity to `maxAcceleration` per
 * second, and the stun holds the speed cap at zero, so the throw is a slide that
 * decelerates and settles instead of a snap. Decelerating from `v` at `a` covers
 * `v² / 2a`, so the speed for a given distance is `sqrt(2ad)` — 3 m at an
 * acceleration of 8 needs 6.9 m/s.
 *
 * The continuous form is an **upper** bound on what a frame-stepped agent
 * actually travels: each frame steps position after the velocity has already
 * been cut, so the last partial step is lost. Measured by the harness:
 * under 2% at 60 fps for the shipped 3 m / 8, rising to ~7% for a short shove on
 * a coarse frame. The tunable is a distance to aim at, and it aims slightly
 * short rather than long — which is the harmless direction for a knockback.
 */
export function shoveImpulse(acceleration: number, distance: number): number {
    if (!(distance > 0) || !(acceleration > 0)) return 0
    return Math.sqrt(2 * acceleration * distance)
}
