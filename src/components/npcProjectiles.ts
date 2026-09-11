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
 */

import * as THREE from 'three'

/** Radius of a droplet, in world units. */
const DROP_RADIUS = 0.057

/** Simultaneous droplets. Four NPCs firing slowly will never approach this. */
const POOL_SIZE = 24

/** Seconds a droplet lives before it is recycled. */
const LIFETIME = 1.6

/** Downward acceleration, world units / s². Gentle — this is a squirt, not a lob. */
const GRAVITY = 4.5

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
    material: THREE.MeshBasicMaterial
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
     */
    spawn(from: THREE.Vector3, toward: THREE.Vector3, speed: number): void
    /** Advance every live droplet. Call once per frame. */
    update(delta: number): void
    /** Recycle everything and free the shared geometry + material. */
    dispose(): void
}

export interface NpcProjectilesOptions {
    scene: THREE.Scene
    /** Live player position, or null before the player exists. */
    getTarget: () => THREE.Vector3 | null
}

/** Scratch — `update` runs per droplet per frame and must not allocate. */
const _toTarget = new THREE.Vector3()

/** Scratch — the splash basis, rebuilt per burst. */
const _splashN = new THREE.Vector3()
const _splashU = new THREE.Vector3()
const _splashW = new THREE.Vector3()

export function createNpcProjectiles(opts: NpcProjectilesOptions): NpcProjectiles {
    const { scene, getTarget } = opts

    const root = new THREE.Group()
    root.name = 'npc-droplets'
    scene.add(root)

    // One geometry and one material for the whole pool. The material is shared
    // by reference, so it must be disposed exactly once, in `dispose`.
    const geometry = new THREE.SphereGeometry(DROP_RADIUS, 8, 6)
    const material = new THREE.MeshStandardMaterial({
        color: 0x3aa8ff,
        emissive: 0x1b6fd4,
        emissiveIntensity: 0.55,
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
        droplets.push({ mesh, velocity: new THREE.Vector3(), life: 0, floorY: -Infinity })
    }

    // --- Splash pool ---------------------------------------------------
    // Its own group, so a teardown can pull the whole effect out in one call
    // and the names stay distinguishable in a scene dump.
    const splashRoot = new THREE.Group()
    splashRoot.name = 'npc-splashes'
    scene.add(splashRoot)

    // A *unit* sphere, scaled per frame, so every splash shares one geometry
    // and the puff needs no per-hit allocation.
    const flashGeometry = new THREE.SphereGeometry(1, 10, 8)
    const beadGeometry = new THREE.SphereGeometry(BEAD_RADIUS, 6, 4)

    const splashes: Splash[] = []
    for (let i = 0; i < SPLASH_POOL; i++) {
        const material = new THREE.MeshBasicMaterial({
            color: 0x8fd4ff,
            transparent: true,
            opacity: 0,
            // A translucent effect must not write depth, or it punches a hole
            // in whatever is drawn after it.
            depthWrite: false,
            // Additive-looking glow fading *toward* a fog colour is not a look
            // worth having; the droplets stay fogged, the burst does not.
            fog: false,
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
        spawn(from, toward, speed) {
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
            slot.floorY = from.y - FALL_LIMIT

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
            const target = getTarget()
            for (const d of droplets) {
                if (d.life <= 0) continue

                d.life -= delta
                if (d.life <= 0) {
                    d.mesh.visible = false
                    continue
                }

                d.velocity.y -= GRAVITY * delta
                d.mesh.position.addScaledVector(d.velocity, delta)

                // Missed shots sink; recycling them at the floor keeps the
                // several metres of fall below the muzzle off the screen.
                if (d.mesh.position.y <= d.floorY) {
                    d.life = 0
                    d.mesh.visible = false
                    continue
                }

                if (target) {
                    _toTarget.copy(target).sub(d.mesh.position)
                    // Compare squared lengths — no sqrt per droplet per frame.
                    const reach = HIT_RADIUS + DROP_RADIUS
                    if (_toTarget.lengthSq() <= reach * reach) {
                        // Where the water is, not where the target is: the hit
                        // radius is a generous capture, and the droplet has not
                        // necessarily travelled the last few centimetres to the
                        // centre. Splashing on the droplet keeps the burst
                        // attached to the water the player just watched arrive.
                        splash(d.mesh.position, d.velocity)
                        d.life = 0
                        d.mesh.visible = false
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
