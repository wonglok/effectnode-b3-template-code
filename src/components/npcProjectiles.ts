/**
 * Water droplets fired by the armed NPCs.
 *
 * A small fixed pool of blue spheres, emitted from a gun muzzle and flown at the
 * player under mild gravity so the shots arc like a squirt rather than a laser.
 * Each droplet is launched on the arc that actually reaches its target, so the
 * muzzle speed stays a pacing dial rather than an accuracy one.
 *
 * Nothing here is per-shot allocated: the pool, the geometry and the material
 * are all built once, and a shot just re-arms a free droplet.
 *
 * Pooling is not incidental. Four NPCs firing on a timer would otherwise create
 * and destroy a mesh every second or so, and each new mesh would drag a fresh
 * material into the renderer's pipeline cache — the kind of slow growth this
 * repo has been bitten by before. It also matches the codebase's existing
 * transient-object idiom (`targetMarker` in NavMeshRig: build once, toggle
 * `visible`, mutate per frame, free geometry/material in the owner's cleanup).
 *
 * ## Splashes
 *
 * A droplet that reaches the player bursts into a splash, drawn from a second
 * pool here. The splash is a short expanding puff plus a fan of beads thrown
 * back along the shot, because that is where water off a struck surface goes —
 * a burst sprayed evenly in all directions reads as an explosion, not a hit.
 *
 * It lives in this module rather than beside the target because the hit test
 * does: the frame a droplet is recycled *is* the frame the water lands, and
 * splitting those two facts across modules would mean re-deriving the impact
 * point from a droplet that has already been hidden.
 *
 * Ownership: the pools are owned by the NPC crowd, which creates them, ticks
 * them and releases them. The shared geometries and materials are freed exactly
 * once there — unlike the per-NPC gun clones, they are not swept up by any
 * avatar teardown. Splashes break the sharing rule in one place and only one:
 * opacity is animated per burst, so each splash slot owns a material of its own,
 * pre-built with the pool.
 *
 * ## Deflection
 *
 * `deflect` is the one call that reaches into live droplets instead of firing
 * them: the jump's force field turns every shot inside its radius back outward.
 * A turned droplet is never disarmed by *clearing* the per-shot callbacks. The
 * crowd's pool spawns with neither, so clearing them falls back to the pool-wide
 * target — the live player chest — and the reversed water would curve back in and
 * damage the player it was just blown away from.
 *
 * Instead it is **re-armed**: `hitPoint` is replaced with a resolver that looks
 * for a target on the *other* side (see `getBouncePoint`), so the water thrown
 * back can hit the crowd that fired it, and can never hit the player. Returning
 * null from that resolver parks the droplet on the miss path, which is what keeps
 * a bounce harmless when there is nobody near it.
 */

import * as THREE from 'three'

/** Radius of a droplet, in world units. */
const DROP_RADIUS = 0.057

/** Simultaneous droplets. Four NPCs firing slowly will never approach this. */
const POOL_SIZE = 24

/** Seconds a droplet lives before it is recycled. */
const LIFETIME = 1.6

/** Downward acceleration, world units / s². Gentle — this is a squirt, not a lob. */
const GRAVITY = 9.0

/** A droplet that gets this close to the target has "hit" and is recycled. */
const HIT_RADIUS = 0.35

/**
 * How far below its launch point a droplet may fall before it is recycled.
 * Without this a shot that misses sinks through the floor and keeps going for
 * the rest of its lifetime — several metres of visible sphere under the
 * ground, since the muzzle sits roughly chest-high.
 */
const FALL_LIMIT = 1.0

/** Simultaneous splashes. One per hit, and they last under half a second. */
const SPLASH_POOL = 8

/** Seconds a splash lives — the puff and its beads fade out together. */
const SPLASH_LIFE = 0.4

/** Beads thrown per splash, fanned over a hemisphere. */
const SPLASH_BEADS = 7

/** Bead radius. Smaller than a droplet, so the burst reads as spray. */
const BEAD_RADIUS = 0.02

/** Bead launch speed, world units / s. Slow: this is a splat, not shrapnel. */
const SPLASH_SPEED = 1.7

/** Opacity the splash material starts at; it fades linearly to 0. */
const SPLASH_OPACITY = 0.85

/**
 * How far the puff grows over its life, as a multiple of `DROP_RADIUS` — an
 * expanding mist around the impact rather than a fixed ball, so the burst
 * spreads instead of just switching off.
 */
const SPLASH_GROWTH = 4.5

interface Droplet {
    mesh: THREE.Mesh
    velocity: THREE.Vector3
    /** Seconds remaining; <= 0 means the droplet is free. */
    life: number
    /** World y below which this droplet is recycled (see `FALL_LIMIT`). */
    floorY: number
    /**
     * Per-shot hit-test point, or null to fall back to the pool-wide
     * `getTarget`. See `spawn`'s fourth argument.
     */
    hitPoint: (() => THREE.Vector3 | null) | null
    /**
     * Per-shot hit callback, or null to fall back to the pool-wide `onHit`. See
     * `spawn`'s fifth argument.
     */
    onHit: (() => void) | null
}

interface Splash {
    /** Expanding puff around the impact, scaled per frame from a unit sphere. */
    flash: THREE.Mesh
    beads: THREE.Mesh[]
    /**
     * Per-splash, not shared: opacity is animated, and a shared material would
     * fade every live splash in lockstep. Pre-built with the pool, so a burst
     * still allocates nothing.
     */
    material: THREE.MeshPhysicalMaterial
    /** One launch velocity per bead, parallel to `beads`. */
    beadVelocity: THREE.Vector3[]
    /** Seconds remaining; <= 0 means the splash is free. */
    life: number
}

export interface NpcProjectiles {
    /**
     * Fire one droplet from `from` at the point `toward`, at muzzle `speed`.
     * Silently dropped if the pool is exhausted. Both vectors are copied, so
     * callers may pass scratch.
     *
     * `toward` is a **destination, not a direction**: the droplet is launched
     * on the ballistic arc that lands there (see `spawn` for why that matters).
     *
     * `hitPoint` overrides where *this* droplet tests for a hit. Without it the
     * droplet uses the pool-wide `getTarget`, which is read once per frame and
     * shared by every droplet — fine for a crowd that all shoots at one player,
     * wrong for a shooter that can re-aim between shots: the earlier ball would
     * stop being able to hit what it was fired at. Callers who can retarget
     * mid-volley pass a closure over their own target instead.
     *
     * `onHit` runs once, on the frame the droplet registers a hit, immediately
     * after its splash. It is where damage is applied. It is *not* run for a
     * droplet that merely expires or falls past its floor. As with `hitPoint`,
     * omitting it falls back to the pool-wide hook — and a **free-aim** shot
     * should omit it, since its `hitPoint` is its own landing spot and there is
     * nothing there to damage.
     */
    spawn(
        from: THREE.Vector3,
        toward: THREE.Vector3,
        speed: number,
        hitPoint?: () => THREE.Vector3 | null,
        onHit?: () => void,
    ): void
    /** Advance every live droplet. Call once per frame. */
    update(delta: number): void
    /**
     * Turn every **inbound** droplet inside `radius` of `origin` (XZ only) back
     * out along its own line from that origin, at the speed it arrived. Returns
     * how many were turned.
     *
     * A turned droplet flies off on its own arc and **cannot damage the player** —
     * that is the one thing deflection guarantees, and it is enforced by the
     * per-shot `hitPoint` the droplet is given rather than by clearing it (see
     * this file's header). What it *can* hit is whatever `getBouncePoint`
     * resolves: the crowd that fired it. With no resolver, it hits nothing at all.
     *
     * It does not splash at the point of deflection — splashing there would
     * consume the droplet as spray, which is absorbing the shot rather than
     * deflecting it. A turned droplet recycles on its existing `LIFETIME` /
     * `floorY` exactly as a miss does.
     *
     * A droplet already travelling away is left alone: it is no longer a threat,
     * and redirecting it is motion for nothing.
     */
    deflect(origin: THREE.Vector3, radius: number): number
    /**
     * Is any live droplet **inbound** toward `point` and within `radius` of it
     * (XZ only)? The read-only half of `deflect` — the same distance test and the
     * same inbound test, with nothing mutated.
     *
     * It exists so a defender can decide to raise a field *before* the water
     * arrives. `deflect` only turns what is already inside its radius, which is
     * too late for the defender that wants to be airborne by the time the shot
     * gets there: this answers "is something coming at me?", which is the
     * question a dodge has to be triggered by.
     */
    inboundThreat(point: THREE.Vector3, radius: number): boolean
    /** Recycle everything and free the shared geometry + material. */
    dispose(): void
}

export interface NpcProjectilesOptions {
    scene: THREE.Scene
    /**
     * The pool's default hit-test point, read once per frame.
     *
     * Every droplet that was spawned without its own `hitPoint` tests against
     * this, so it models "one shooter aiming at one thing" — the NPC crowd
     * shooting at the player. A shooter that can retarget passes a per-shot
     * closure to `spawn` instead.
     */
    getTarget: () => THREE.Vector3 | null
    /**
     * Runs when a droplet that was testing against `getTarget` hits it — the
     * pool-level counterpart to `spawn`'s per-shot `onHit`, and where the crowd
     * applies damage to the player. Droplets that carried their own `hitPoint`
     * use their own callback instead; this is never both.
     */
    onHit?: () => void
    /**
     * What a **deflected** droplet may hit instead, given its current world
     * position — the crowd that fired it, for the jump's force field. Return the
     * point to test against, or null for "nothing near it".
     *
     * Only consulted for droplets `deflect` has turned, and it replaces their
     * target outright: a turned droplet is aimed at what this finds, never at the
     * pool-wide `getTarget`. That is the point of it — the water blown back can
     * hurt the shooter, and cannot hurt the player it was blown away from.
     *
     * Called once per turned droplet per frame, so it must not allocate (see
     * {@link onBounceHit} for the damage half).
     */
    getBouncePoint?: (position: THREE.Vector3) => THREE.Vector3 | null
    /**
     * Damage whatever `getBouncePoint` resolved — the pool-level counterpart to
     * the pair above, and the only way a deflected droplet hurts anything.
     *
     * Positional like `getBouncePoint` rather than taking a target: the hit is
     * resolved from where the water actually is, which is the same question, and
     * the two calls are adjacent for the same droplet on the same frame. Called
     * only on a frame the droplet registered a hit.
     */
    onBounceHit?: (position: THREE.Vector3) => void
    /**
     * Root names for the two groups this pool adds to the scene.
     *
     * Defaults match the crowd's historical names. A second pool must override
     * them, or `scene.getObjectByName` — and any scene dump, including the
     * runtime-intelligence `/api/query/scene` route — becomes ambiguous between
     * two identically-named siblings.
     */
    names?: { droplets: string; splashes: string }
}

/** Scratch — `update` runs per droplet per frame and must not allocate. */
const _toTarget = new THREE.Vector3()

/** Scratch — where a droplet was at the start of this frame's step, and the
 *  closest point on the step to its target. See `sweptHit`. */
const _stepFrom = new THREE.Vector3()
const _sweptTo = new THREE.Vector3()
const _hitPoint = new THREE.Vector3()

/** Scratch — the outward direction `deflect` pushes along. */
const _outward = new THREE.Vector3()

/**
 * The disarm a deflected droplet carries when the pool has no bounce resolver —
 * a non-null `hitPoint` is what keeps the pool-wide `getTarget` out of the test
 * (see `update`), and returning null from it is the documented miss path: no hit
 * test, no splash, no damage. One shared function, so deflecting a volley
 * allocates nothing.
 */
const NEVER_HITS = () => null

/**
 * Did the step `from`→`to` pass within `radius` of `point`? Writes the closest
 * point on that step to `out`, and answers whether it was close enough.
 *
 * The hit test used to be a plain distance from the droplet to its target, taken
 * once per frame. That is only correct while a droplet moves less than the
 * capture radius in a frame: the player's muzzle speed crosses tens of metres per
 * frame, so a droplet would step clean over an enemy between two frames and never
 * register a hit at all. Testing the whole step is the *same test* at low speed —
 * once the step is shorter than the radius the closest point is the endpoint, and
 * the answer is identical — and stays correct at any speed or frame rate.
 *
 * The closest point is handed back because a fast shot crosses the capture sphere
 * mid-frame: that crossing is where the water landed, and it is what the splash
 * should be drawn at, not wherever the frame happened to end.
 */
function sweptHit(
    from: THREE.Vector3,
    to: THREE.Vector3,
    point: THREE.Vector3,
    radius: number,
    out: THREE.Vector3,
): boolean {
    _sweptTo.copy(to).sub(from)
    const lengthSq = _sweptTo.lengthSq()
    if (lengthSq < 1e-12) {
        // No movement this frame; the point test is the whole of it.
        out.copy(to)
    } else {
        _toTarget.copy(point).sub(from)
        // Clamped to the step, so a target behind the droplet (t < 0) or beyond it
        // (t > 1) is measured to the nearest end rather than to the infinite line.
        const t = Math.min(1, Math.max(0, _toTarget.dot(_sweptTo) / lengthSq))
        out.copy(from).addScaledVector(_sweptTo, t)
    }
    return out.distanceToSquared(point) <= radius * radius
}

/** Scratch — the splash basis, rebuilt per burst. */
const _splashN = new THREE.Vector3()
const _splashU = new THREE.Vector3()
const _splashW = new THREE.Vector3()

export function createNpcProjectiles(opts: NpcProjectilesOptions): NpcProjectiles {
    const { scene, getTarget, onHit, getBouncePoint, onBounceHit, names } = opts

    const root = new THREE.Group()
    root.name = names?.droplets ?? 'npc-droplets'
    scene.add(root)

    // One geometry and one material for the whole pool. The material is shared
    // by reference, so it must be disposed exactly once, in `dispose`.
    const geometry = new THREE.SphereGeometry(DROP_RADIUS, 8, 6)
    const material = new THREE.MeshStandardMaterial({
        color: 0x3aa8ff,
        emissive: 0x1b6fd4,
        emissiveIntensity: 1.55,
        roughness: 0.15,
        metalness: 0.0,
        transparent: true,
        opacity: 0.9,
    })

    const droplets: Droplet[] = []
    for (let i = 0; i < POOL_SIZE; i++) {
        const mesh = new THREE.Mesh(geometry, material)
        mesh.visible = false
        // Droplets are short-lived and fly close to the camera's subject; culling
        // them by a stale bounding sphere would pop them out mid-flight.
        mesh.frustumCulled = false
        root.add(mesh)
        droplets.push({
            mesh,
            velocity: new THREE.Vector3(),
            life: 0,
            floorY: -Infinity,
            hitPoint: null,
            onHit: null,
        })
    }

    // --- Splash pool ---------------------------------------------------
    // Its own group, so a teardown can pull the whole effect out in one call
    // and the names stay distinguishable in a scene dump.
    const splashRoot = new THREE.Group()
    splashRoot.name = names?.splashes ?? 'npc-splashes'
    scene.add(splashRoot)

    // A *unit* sphere, scaled per frame, so every splash shares one geometry
    // and the puff needs no per-hit allocation.
    const flashGeometry = new THREE.SphereGeometry(1, 10, 8)
    const beadGeometry = new THREE.SphereGeometry(BEAD_RADIUS, 6, 4)

    const splashes: Splash[] = []
    for (let i = 0; i < SPLASH_POOL; i++) {
        const material = new THREE.MeshPhysicalMaterial({
            color: 0x8fd4ff,
            transparent: true,
            opacity: 0,
            // A translucent effect must not write depth, or it punches a hole
            // in whatever is drawn after it.
            depthWrite: false,
            // Additive-looking glow fading *toward* a fog colour is not a look
            // worth having; the droplets stay fogged, the burst does not.
            fog: false,
            emissive: 0x8fd4ff,
            emissiveIntensity: 0.5,
        })

        const flash = new THREE.Mesh(flashGeometry, material)
        flash.visible = false
        flash.frustumCulled = false
        splashRoot.add(flash)

        const beads: THREE.Mesh[] = []
        const beadVelocity: THREE.Vector3[] = []
        for (let b = 0; b < SPLASH_BEADS; b++) {
            const bead = new THREE.Mesh(beadGeometry, material)
            bead.visible = false
            bead.frustumCulled = false
            splashRoot.add(bead)
            beads.push(bead)
            beadVelocity.push(new THREE.Vector3())
        }

        splashes.push({ flash, beads, material, beadVelocity, life: 0 })
    }

    let disposed = false

    /** Next droplet to consider — droplets are recycled round-robin, so a burst
     *  takes free slots in turn instead of always re-using slot 0. */
    let cursor = 0

    /** Same round-robin, over the splash pool. */
    let splashCursor = 0

    /**
     * Burst a splash at `point`, thrown back along `incoming` — the droplet's
     * velocity as it landed. Silently dropped when every slot is live.
     */
    function splash(point: THREE.Vector3, incoming: THREE.Vector3): void {
        let slot: Splash | null = null
        for (let i = 0; i < SPLASH_POOL; i++) {
            const s = splashes[(splashCursor + i) % SPLASH_POOL]
            if (s.life <= 0) {
                slot = s
                splashCursor = (splashCursor + i + 1) % SPLASH_POOL
                break
            }
        }
        if (!slot) return

        slot.life = SPLASH_LIFE
        slot.material.opacity = SPLASH_OPACITY
        slot.flash.position.copy(point)
        slot.flash.scale.setScalar(DROP_RADIUS)
        slot.flash.visible = true

        // Water off a struck surface comes back the way it arrived, so the fan
        // opens around the *reverse* of the droplet's travel. A degenerate
        // incoming (a shot fired straight along one axis) still needs a basis,
        // hence the axis swap rather than a cross with a near-parallel vector.
        _splashN.copy(incoming)
        if (_splashN.lengthSq() < 1e-8) _splashN.set(0, 0, 1)
        _splashN.normalize().multiplyScalar(-1)
        _splashU.set(0, 1, 0)
        if (Math.abs(_splashN.y) > 0.9) _splashU.set(1, 0, 0)
        _splashW.crossVectors(_splashN, _splashU).normalize()
        _splashU.crossVectors(_splashW, _splashN).normalize()

        // Even coverage of the hemisphere without randomness: stepping `cosPhi`
        // linearly gives rings of equal area, and the golden angle spaces the
        // beads around them. Deterministic, so no two bursts clump alike and
        // none of them leaves a bald patch.
        const golden = Math.PI * (3 - Math.sqrt(5))
        for (let b = 0; b < SPLASH_BEADS; b++) {
            const cosPhi = 1 - (b + 0.5) / SPLASH_BEADS
            const sinPhi = Math.sqrt(Math.max(0, 1 - cosPhi * cosPhi))
            const theta = golden * b

            const v = slot.beadVelocity[b]
            v.copy(_splashN).multiplyScalar(cosPhi)
            v.addScaledVector(_splashU, Math.cos(theta) * sinPhi)
            v.addScaledVector(_splashW, Math.sin(theta) * sinPhi)
            // The cone's rim flies fastest, so the burst opens out instead of
            // staying a clump that drifts.
            v.multiplyScalar(SPLASH_SPEED * (0.55 + 0.45 * (1 - cosPhi)))

            slot.beads[b].position.copy(point)
            slot.beads[b].visible = true
        }
    }

    return {
        spawn(from, toward, speed, hitPoint, shotOnHit) {
            if (disposed) return
            // Round-robin from the cursor to find a free droplet. Scanning the
            // whole pool is what lets a burst exceed the free slots near the
            // cursor without dropping shots unnecessarily.
            let slot: Droplet | null = null
            for (let i = 0; i < POOL_SIZE; i++) {
                const d = droplets[(cursor + i) % POOL_SIZE]
                if (d.life <= 0) {
                    slot = d
                    cursor = (cursor + i + 1) % POOL_SIZE
                    break
                }
            }
            if (!slot) return // pool saturated; drop the shot rather than steal one

            slot.mesh.position.copy(from)
            slot.mesh.visible = true
            slot.life = LIFETIME
            // Measured from the *lower* of the launch point and the destination,
            // not from the muzzle alone. A shot aimed below its own muzzle — at
            // the ground, say — would otherwise cross its own floor on the way
            // down and be recycled in mid-air a metre above what it was aimed
            // at, which reads as the shot vanishing rather than landing. For a
            // level shot the two heights are close and this is the same cut as
            // before. A miss now falls that little bit further before being
            // recycled, i.e. it reaches the ground instead of stopping above it.
            slot.floorY = Math.min(from.y, toward.y) - FALL_LIMIT
            // Latched per shot, so retargeting after this one is fired cannot
            // steal the hit from the enemy it was actually aimed at.
            slot.hitPoint = hitPoint ?? null
            slot.onHit = shotOnHit ?? null

            // Solve the launch velocity that lands on `toward`.
            //
            // Aiming *at* the target — the obvious `dir = toward - from` — arcs
            // under it by `½g(d/speed)²`, which is 4 cm at the default 14 m/s
            // over a couple of metres but over a third of a metre at 5. That is
            // inside the GUI's own speed range, so the naive version reads as
            // "the shots miss" exactly when someone slows them down to watch the
            // arc. Fix the horizontal speed at `speed` (so the dial keeps meaning
            // what it says) and let the vertical component carry both the height
            // difference and the drop over the flight.
            const dx = toward.x - from.x
            const dy = toward.y - from.y
            const dz = toward.z - from.z
            const horizontal = Math.hypot(dx, dz)
            const muzzleSpeed = Math.max(0.1, speed)
            if (horizontal < 1e-4) {
                // Target directly overhead/underfoot: no horizontal solution, so
                // fire straight along the vertical offset.
                slot.velocity.set(0, dy >= 0 ? muzzleSpeed : -muzzleSpeed, 0)
                return
            }
            const flight = horizontal / muzzleSpeed
            slot.velocity.set(dx / flight, (dy + 0.5 * GRAVITY * flight * flight) / flight, dz / flight)
        },

        update(delta) {
            if (disposed) return
            // The pool-wide fallback, resolved once. Per-droplet overrides are
            // resolved inside the loop instead, because two droplets in flight
            // at the same moment can be tracking two different targets.
            const sharedTarget = getTarget()
            for (const d of droplets) {
                if (d.life <= 0) {
                    // A free droplet holds no target and no callback. Done here
                    // rather than at each of the three recycle sites so the
                    // invariant cannot be missed by a path added later — and so
                    // a spent shot stops retaining a closure over an NPC.
                    d.hitPoint = null
                    d.onHit = null
                    continue
                }

                d.life -= delta
                if (d.life <= 0) {
                    d.mesh.visible = false
                    continue
                }

                // Where the step begins, kept for the swept hit test below — at
                // the player's muzzle speed a droplet crosses tens of metres in a
                // frame, so the target has to be tested against the path it took
                // rather than the point it ended on.
                _stepFrom.copy(d.mesh.position)

                d.velocity.y -= GRAVITY * delta
                d.mesh.position.addScaledVector(d.velocity, delta)

                // Missed shots sink; recycling them at the floor keeps the
                // several metres of fall below the muzzle off the screen.
                if (d.mesh.position.y <= d.floorY) {
                    d.life = 0
                    d.mesh.visible = false
                    continue
                }

                // The shot's own target if it has one, else the pool's, else
                // nothing — which parks the droplet on the miss path below.
                const target = d.hitPoint ? d.hitPoint() : sharedTarget
                if (target) {
                    const reach = HIT_RADIUS + DROP_RADIUS
                    // Swept, not a point test: see `sweptHit`. The comparison is
                    // still on squared lengths, inside the helper.
                    if (sweptHit(_stepFrom, d.mesh.position, target, reach, _hitPoint)) {
                        // Where the water met the target, not where the target is:
                        // the capture radius is generous and the droplet has not
                        // necessarily travelled to the centre. On the step, rather
                        // than at the frame's end position, so a fast shot's burst
                        // lands where it crossed instead of tens of metres past.
                        splash(_hitPoint, d.velocity)
                        // Zeroed on this very frame, which is what makes the hit
                        // fire exactly once: the next frame's `life <= 0` guard
                        // skips the droplet before it can be tested again.
                        d.life = 0
                        d.mesh.visible = false
                        // Damage, attributed to whoever this droplet was fired
                        // at: its own shooter's target if it carried one, else
                        // the pool's. Read here rather than stored so it cannot
                        // go stale, but it is only ever *called* the once.
                        d.onHit ? d.onHit() : onHit?.()
                    }
                }
            }

            for (const s of splashes) {
                if (s.life <= 0) continue

                s.life -= delta
                if (s.life <= 0) {
                    s.flash.visible = false
                    for (const b of s.beads) b.visible = false
                    continue
                }

                // Linear in `t`, so the fade-out matches the droplet's own
                // straight-line travel rather than easing against it.
                const t = 1 - s.life / SPLASH_LIFE
                s.material.opacity = SPLASH_OPACITY * (1 - t)
                s.flash.scale.setScalar(DROP_RADIUS * (1 + t * SPLASH_GROWTH))

                for (let b = 0; b < SPLASH_BEADS; b++) {
                    const v = s.beadVelocity[b]
                    v.y -= GRAVITY * delta
                    s.beads[b].position.addScaledVector(v, delta)
                }
            }
        },

        deflect(origin, radius) {
            if (disposed || radius <= 0) return 0
            let turned = 0
            for (const d of droplets) {
                if (d.life <= 0) continue

                // XZ only, like every other distance in this file and the
                // crowd's own aggro test: the field is anchored at the player's
                // feet and the shots fly at chest height, so a sphere would
                // shrink the effective radius with height for no reason.
                const dx = d.mesh.position.x - origin.x
                const dz = d.mesh.position.z - origin.z
                const dist = Math.hypot(dx, dz)
                if (dist > radius) continue

                // The horizontal speed is the one being reversed. Carrying the
                // vertical into it too would inflate the punch — a shot arriving
                // on a steep descent leaves faster than it came.
                const speed = Math.hypot(d.velocity.x, d.velocity.z)
                if (speed < 1e-4) continue // nothing in flight to turn

                if (dist > 1e-4) {
                    _outward.set(dx / dist, 0, dz / dist)
                } else {
                    // Dead centre: there is no outward line to push along, so
                    // send it back the way it came — which for an inbound shot
                    // is still outward. Avoids a NaN direction, and the dot test
                    // below passes by construction.
                    _outward.set(-d.velocity.x / speed, 0, -d.velocity.z / speed)
                }

                // Inbound only.
                if (d.velocity.x * _outward.x + d.velocity.z * _outward.z >= 0) continue

                // Flat out and then falling: the outward punch dominates, so the
                // arc reads as "blown away", not as "bounced back up".
                d.velocity.copy(_outward).multiplyScalar(speed)

                // Re-arm it at whatever the pool's bounce resolver finds — the
                // crowd that fired it — and at nothing else. Supplying a per-shot
                // `hitPoint` is the load-bearing half: it is what keeps the
                // pool-wide `getTarget`, the player's own chest, out of this
                // droplet's test. See this file's header.
                //
                // The closures are built once per turned droplet, not per frame:
                // they capture the droplet's mesh and answer where the water is,
                // so a flight back across the field allocates nothing.
                const mesh = d.mesh
                if (getBouncePoint) {
                    d.hitPoint = () => getBouncePoint(mesh.position)
                    d.onHit = onBounceHit ? () => onBounceHit(mesh.position) : null
                } else {
                    // No bounce resolver on this pool: the water is inert from
                    // here on out, which is still better than aiming at the player.
                    d.hitPoint = NEVER_HITS
                    d.onHit = null
                }
                turned++
            }
            return turned
        },

        inboundThreat(point, radius) {
            if (disposed || radius <= 0) return false
            const radiusSq = radius * radius
            for (const d of droplets) {
                if (d.life <= 0) continue

                // Toward the point, not away from it — the sign convention is the
                // mirror of `deflect`'s outward vector, because the question here
                // is "is this coming at me" rather than "is this inside me".
                const dx = point.x - d.mesh.position.x
                const dz = point.z - d.mesh.position.z
                if (dx * dx + dz * dz > radiusSq) continue

                // Inbound only, exactly as `deflect` requires before it turns
                // anything: water already flying away from this point cannot hit
                // it, so it must not trigger a dodge either.
                if (d.velocity.x * dx + d.velocity.z * dz > 0) return true
            }
            return false
        },

        dispose() {
            if (disposed) return
            disposed = true
            for (const d of droplets) {
                d.mesh.visible = false
                d.mesh.parent?.remove(d.mesh)
            }
            droplets.length = 0
            root.clear()
            scene.remove(root)
            // Shared, so freed once here — never per droplet.
            geometry.dispose()
            material.dispose()

            for (const s of splashes) {
                s.flash.visible = false
                s.flash.parent?.remove(s.flash)
                for (const b of s.beads) {
                    b.visible = false
                    b.parent?.remove(b)
                }
                // Per-splash, so freed per splash — see `Splash.material`.
                s.material.dispose()
            }
            splashes.length = 0
            splashRoot.clear()
            scene.remove(splashRoot)
            // Shared by every splash of the pool.
            flashGeometry.dispose()
            beadGeometry.dispose()
        },
    }
}
