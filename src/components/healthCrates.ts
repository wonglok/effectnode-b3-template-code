/**
 * Health crates: medkit boxes standing on the floor that restore the player's
 * health when they walk into one, then disappear and come back somewhere else.
 *
 * Written as a plain closure over the scene with an `update` tick — the same
 * shape as `playerCombat.ts` — rather than a React component, because it owns
 * GPU resources and has to be disposed exactly once by whoever created it.
 *
 * ## Pooled, not built on demand
 *
 * `crateCount` is a lil-gui slider, so it changes live. Building meshes when it
 * rises and disposing them when it falls would allocate and free geometry
 * mid-play, and building once at construction would let the slider silently
 * disagree with the scene. So the pool is fixed at `poolSize` meshes and the
 * slider only decides **how many are shown** — the same trick, for the same
 * reason, as the droplet pool in `npcProjectiles`.
 *
 * ## One geometry, one material, one texture
 *
 * Every crate shares a single `BoxGeometry`, a single `MeshStandardMaterial`
 * and a single `CanvasTexture` by reference. That keeps the whole crate set at
 * one texture and three GPU objects however many stand on the floor — but it
 * means `dispose` is the **single owner** of all three. Nothing else may
 * dispose them, and the meshes must never be parented under an object that
 * `NavMeshRig` walks with `disposeObject` (which disposes `map`/`emissiveMap`
 * off every material it meets — the mechanism behind the gun-mount incident).
 * They are added straight to the scene, like the target marker.
 *
 * A `BoxGeometry` has one UV set, so the cross lands on all six faces including
 * the lid. That is deliberate: a medkit with a cross on top reads correctly,
 * and the alternative — a six-material array — would mean six materials to
 * dispose and per-face UV rotation for a detail nobody sees.
 */

import * as THREE from 'three'
import type { NavMesh } from 'navcat'
import { randomNavMeshPoint } from './navmeshPoints'

/** The tunables this module reads, live, every frame — `NavMeshRig` hands its
 *  `settings` object straight in, so a GUI slider takes effect immediately. */
export interface HealthCrateTunables {
    maxHp: number
    crateCount: number
    crateHealFraction: number
    cratePickupRadius: number
    crateRespawnSeconds: number
}

export interface HealthCratesOptions {
    scene: THREE.Scene
    navMesh: NavMesh
    /** How many meshes to pool. Must be at least the `crateCount` slider's
     *  maximum, or the slider clips. */
    poolSize: number
    /** Live tunables, read every frame. */
    tunables: HealthCrateTunables
    getPlayerPosition: () => THREE.Vector3
    /**
     * Whether a crate may be taken right now. The rig owns this rule — it gates
     * on the player being up and below full health — because it is the rig that
     * knows what "downed" means and what the player's health currently is.
     */
    canCollect: () => boolean
    /** A crate was walked into. `heal` is already the resolved HP amount. */
    onCollect: (heal: number) => void
}

export interface HealthCrates {
    update(delta: number): void
    /** Re-seat every crate on a replacement navmesh. The mesh object is rebuilt
     *  from scratch on every collider change, so any position sampled from the
     *  old one refers to a surface that no longer exists. */
    setNavMesh(navMesh: NavMesh): void
    dispose(): void
}

const CRATE_SIZE = 0.42
const CRATE_HEIGHT = 0.36
/** Crates are seated by their centre, so they are lifted by half their height
 *  to rest *on* the surface the navmesh reports rather than sinking through. */
const HALF_HEIGHT = CRATE_HEIGHT / 2

/** Scale-down on pickup, in seconds. Short enough to feel instant, long enough
 *  that the crate reads as taken rather than deleted. */
const SHRINK_SECONDS = 0.25

const BOB_AMPLITUDE = 0.05
const BOB_SPEED = 2.1
const SPIN_SPEED = 0.8

/**
 * Placement draws, and draws per attempt.
 *
 * Two levels because the two failure modes differ: `randomNavMeshPoint` already
 * retries the upstream "found it but reported failure" quirk (6.4% per draw),
 * and on top of that a candidate is rejected when it lands on the player.
 * Rejection shrinks the effective pool, so the outer budget is generous — and a
 * crate that still cannot find a home is left down and retried next tick, never
 * placed somewhere it was rejected.
 */
const PLACEMENT_ATTEMPTS = 24
const POINT_ATTEMPTS = 4

/**
 * How far from the player a crate may appear.
 *
 * A crate that respawns under the player's feet is collected on its first
 * visible frame — a free full heal on a timer, which a four-crate pool on a
 * small navmesh would hit constantly. Floored at 1.5 rather than left to the
 * pickup radius so a deliberately *tiny* radius cannot reintroduce it.
 */
const MIN_SPAWN_CLEARANCE = 1.5

/** Wait before retrying placement when a crate found nowhere valid. */
const RETRY_SECONDS = 0.5

/** Crate face: an off-white panel with a red cross. Cosmetic only — drawn once
 *  at construction and never redrawn. */
const CANVAS_SIZE = 128
const FACE_COLOUR = '#eef2f4'
const CROSS_COLOUR = '#e5484d'
/** Cross arm thickness and length, in canvas pixels. */
const CROSS_ARM = 26
const CROSS_LENGTH = 82

/** `idle` is collectable; `shrinking` is visible but *not* collectable, which a
 *  boolean cannot express; `gone` is hidden with its timer running. */
type CratePhase = 'idle' | 'shrinking' | 'gone'

interface Crate {
    mesh: THREE.Mesh
    /** Centre height when resting, before the bob. */
    baseY: number
    phase: CratePhase
    /** Seconds left in `shrinking` or `gone`. */
    timer: number
    /** Per-crate phase offset, so the pool does not bob and spin in lockstep. */
    offset: number
}

function drawFace(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas')
    canvas.width = CANVAS_SIZE
    canvas.height = CANVAS_SIZE
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = FACE_COLOUR
    ctx.fillRect(0, 0, CANVAS_SIZE, CANVAS_SIZE)
    ctx.fillStyle = CROSS_COLOUR
    const mid = CANVAS_SIZE / 2
    // Two overlapping bars, centred.
    ctx.fillRect(mid - CROSS_ARM / 2, mid - CROSS_LENGTH / 2, CROSS_ARM, CROSS_LENGTH)
    ctx.fillRect(mid - CROSS_LENGTH / 2, mid - CROSS_ARM / 2, CROSS_LENGTH, CROSS_ARM)

    const texture = new THREE.CanvasTexture(canvas)
    texture.colorSpace = THREE.SRGBColorSpace
    // Matches the health bars: a small canvas on a small object gains nothing
    // from mipmaps and shimmers on the box's edges without them.
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    return texture
}

export function createHealthCrates(opts: HealthCratesOptions): HealthCrates {
    const { scene, tunables, getPlayerPosition, canCollect, onCollect } = opts
    const poolSize = Math.max(0, Math.floor(opts.poolSize))

    let navMesh = opts.navMesh
    let disposed = false
    let elapsed = 0

    const group = new THREE.Group()
    group.name = 'health-crates'
    scene.add(group)

    const geometry = new THREE.BoxGeometry(CRATE_SIZE, CRATE_HEIGHT, CRATE_SIZE)
    const texture = drawFace()
    const material = new THREE.MeshStandardMaterial({
        map: texture,
        // A faint tiffany glow so a crate reads as interactive against the
        // scene — the same accent the target marker uses.
        emissive: 0x81d8d0,
        emissiveIntensity: 0.2,
        roughness: 0.55,
        metalness: 0.0,
    })

    const crates: Crate[] = []
    for (let i = 0; i < poolSize; i++) {
        const mesh = new THREE.Mesh(geometry, material)
        // The canvas renders shadows, and a crate with neither flag floats.
        mesh.castShadow = true
        mesh.receiveShadow = true
        mesh.visible = false
        group.add(mesh)
        crates.push({ mesh, baseY: 0, phase: 'gone', timer: 0, offset: i * 1.7 })
    }

    /**
     * Seat `crate` on a fresh navmesh point clear of the player.
     *
     * Returns false when every candidate was rejected or the sampler came up
     * empty; the caller then leaves the crate down and retries next tick rather
     * than dropping it on a point it just rejected.
     */
    const place = (crate: Crate): boolean => {
        const player = getPlayerPosition()
        const clearance = Math.max(MIN_SPAWN_CLEARANCE, tunables.cratePickupRadius)
        const minSq = clearance * clearance
        for (let attempt = 0; attempt < PLACEMENT_ATTEMPTS; attempt++) {
            const random = randomNavMeshPoint(navMesh, POINT_ATTEMPTS)
            if (!random) continue
            const [x, y, z] = random.position
            const dx = x - player.x
            const dz = z - player.z
            if (dx * dx + dz * dz < minSq) continue
            crate.baseY = y + HALF_HEIGHT
            crate.mesh.position.set(x, crate.baseY, z)
            crate.mesh.scale.setScalar(1)
            return true
        }
        return false
    }

    /** Back on the floor, collectable. */
    const rest = (crate: Crate) => {
        if (place(crate)) {
            crate.phase = 'idle'
            crate.timer = 0
        } else {
            // Nowhere valid. Stay down and try again shortly — never place a
            // crate that was rejected for being on top of the player.
            crate.phase = 'gone'
            crate.timer = RETRY_SECONDS
        }
    }

    // Seat the whole pool up front, so raising the slider reveals crates that
    // are already standing on the floor rather than appearing at the origin.
    for (const crate of crates) rest(crate)

    return {
        update(delta: number) {
            if (disposed) return
            elapsed += delta

            const want = Math.max(0, Math.min(poolSize, Math.floor(tunables.crateCount)))
            const radius = tunables.cratePickupRadius
            const radiusSq = radius * radius
            const player = getPlayerPosition()
            let collectedThisFrame = false

            for (let i = 0; i < crates.length; i++) {
                const crate = crates[i]

                // Timers tick whether or not the crate is currently shown, so
                // lowering the slider cannot strand one mid-respawn.
                if (crate.phase === 'shrinking') {
                    crate.timer -= delta
                    if (crate.timer <= 0) {
                        crate.phase = 'gone'
                        crate.timer = Math.max(0.1, tunables.crateRespawnSeconds)
                    } else {
                        crate.mesh.scale.setScalar(crate.timer / SHRINK_SECONDS)
                    }
                } else if (crate.phase === 'gone') {
                    crate.timer -= delta
                    if (crate.timer <= 0) rest(crate)
                }

                // The slider decides how many of the pool are on the floor. A
                // crate that is down stays hidden until it respawns, even once
                // the slider is raised back over it.
                const shown = crate.phase !== 'gone' && i < want
                crate.mesh.visible = shown
                if (!shown) continue

                crate.mesh.rotation.y += SPIN_SPEED * delta
                crate.mesh.position.y = crate.baseY + Math.sin(elapsed * BOB_SPEED + crate.offset) * BOB_AMPLITUDE

                if (crate.phase !== 'idle' || collectedThisFrame) continue

                // Horizontal only, and load-bearing: the frame loop re-applies
                // the jump lift to `playerGroup.position.y` before this runs, so
                // a 3D distance would put the player ~1.2 units "above" the
                // floor at the apex and make crates uncollectable mid-jump.
                const dx = crate.mesh.position.x - player.x
                const dz = crate.mesh.position.z - player.z
                if (dx * dx + dz * dz > radiusSq) continue
                if (!canCollect()) continue

                // One crate per frame: two within a radius would otherwise both
                // fire, burning the whole cluster the moment the heal is not a
                // full restore.
                collectedThisFrame = true
                onCollect(tunables.crateHealFraction * tunables.maxHp)
                crate.phase = 'shrinking'
                crate.timer = SHRINK_SECONDS
            }
        },

        setNavMesh(next: NavMesh) {
            if (disposed) return
            navMesh = next
            // Re-seat the ones standing on the floor. Anything mid-respawn is
            // left down; it is placed on the new mesh when its timer runs out,
            // which is also what happens if placement fails here.
            for (const crate of crates) {
                if (crate.phase === 'idle') rest(crate)
            }
        },

        dispose() {
            if (disposed) return
            disposed = true
            // The rig's own cleanup only removes `playerGroup`, `targetMarker`
            // and the navmesh helper — it does not sweep the scene. Without this
            // the whole crate set is duplicated by a remount (e.g. /dev's
            // Navmesh Mode toggle, whose R3F scene outlives the component).
            scene.remove(group)
            group.clear()
            // Geometry, material and texture are shared by every crate, so this
            // is the single release for all of them.
            geometry.dispose()
            material.dispose()
            texture.dispose()
        },
    }
}
