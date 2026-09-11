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
 * Ownership: the pool is owned by the NPC crowd, which creates it, ticks it and
 * releases it. The shared geometry and material are freed exactly once there —
 * unlike the per-NPC gun clones, they are not swept up by any avatar teardown.
 */

import * as THREE from 'three'

/** Radius of a droplet, in world units. */
const DROP_RADIUS = 0.07

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

interface Droplet {
    mesh: THREE.Mesh
    velocity: THREE.Vector3
    /** Seconds remaining; <= 0 means the droplet is free. */
    life: number
    /** World y below which this droplet is recycled (see `FALL_LIMIT`). */
    floorY: number
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

    let disposed = false

    /** Next droplet to consider — droplets are recycled round-robin, so a burst
     *  takes free slots in turn instead of always re-using slot 0. */
    let cursor = 0

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
            slot.velocity.set(
                dx / flight,
                (dy + 0.5 * GRAVITY * flight * flight) / flight,
                dz / flight,
            )
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
                        d.life = 0
                        d.mesh.visible = false
                    }
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
        },
    }
}
