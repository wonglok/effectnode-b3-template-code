/**
 * The player's half of the water fight: a gun in hand and a pool of droplets to
 * fire from it.
 *
 * The crowd (`npcEnemies`) already owns all the machinery — the ballistic solve,
 * the droplet and splash pools, the gun mount and its per-frame calibration. All
 * of it is shooter-agnostic, so this module reuses it rather than growing a
 * second implementation:
 *
 * - `npcProps` for the gun itself (`attachGun` / `calibrateGun` /
 *   `applyGunTuning`), the same mount the NPCs hold.
 * - `npcProjectiles` for the ammunition, as a **second pool** — the crowd's is
 *   constructed inside its own closure and disposed with it, and more to the
 *   point its default target is the player.
 *
 * ## Why the gun's visibility is not the crowd's `enabled` flag
 *
 * `applyGunTuning` sets `mount.visible = weapon.enabled`, and the rig keeps one
 * shared `weapon` object that lil-gui flips for the crowd. Reusing that object
 * would make the player's gun appear and vanish with the crowd's mood, so this
 * module owns its **own** `NpcWeapon` — a copy of the manifest entry's tuning —
 * and drives `enabled` from attack mode alone.
 *
 * ## Why every shot carries its own target
 *
 * `npcProjectiles.update` reads its target **once per frame** and hit-tests
 * every live droplet against that single point, which is exactly right for a
 * crowd that all shoots at one player. A player can re-aim between shots, so
 * each droplet here is given its own hit-test point at spawn: the locked
 * enemy's live chest, or the fixed point the shot was aimed at. The pool's own
 * `getTarget` is therefore never used and returns null.
 *
 * ## Two ways to hold fire
 *
 * Both are sustained — the trigger goes down and stays down, one droplet every
 * `fireInterval` — and they differ only in what the shots are aimed at:
 *
 * - `lockOn` holds fire on an **enemy**, re-reading its live chest every shot.
 * - `holdFireAt` holds fire on a **point in the world**, aimed once when it is
 *   set. This is the right-click spray: fire at where the player pointed, until
 *   they point somewhere else, click to stop, or walk off.
 *
 * They share one shot body (`shoot`), so an enemy-locked shot and a point-held
 * shot cannot drift apart. What differs is only who decides when to pull the
 * trigger, and where the barrel points when it does.
 *
 * The two release differently, and deliberately so. An enemy lock also releases
 * from the target's side: `NpcTarget.aimPoint` goes null once the NPC is down or
 * the crowd is disposed — that null *is* "the target is gone", so nothing here
 * needs to know what death looks like. A target that respawns gets no
 * re-engagement: the lock is already gone. A held point has no such side — it
 * does not move and cannot die — so it is released **only** by a command. See
 * `holdFireAt` for why re-checking it shot by shot would be a mistake.
 */

import * as THREE from 'three'
import type { AvatarRig } from './avatarLoader'
import { ARMED_FIRING_CLIP, ARMED_SET_KEY } from './armedClipSet'
import type { NpcTarget } from './npcEnemies'
import { applyGunTuning, attachGun, calibrateGun, type NpcGun, type NpcWeapon } from './npcProps'
import { createNpcProjectiles } from './npcProjectiles'

/**
 * Muzzle velocity for the player's shots, world units / second.
 *
 * Deliberately **not** the crowd's `npcProjectileSpeed` (8): an NPC lobs water at
 * a player standing 5 m away, and the player shoots at whatever they clicked, so
 * the two want very different arcs.
 *
 * `speed × LIFETIME` is the gun's reach — 20 × 1.6 = 32 m — and the
 * `playerFireRange` dial sits just inside it, so a lock held at its limit is
 * still a shot the gun can actually deliver. Change this and that relationship
 * moves: at 40 the reach is 64 m and the range dial stops bounding anything
 * physically.
 *
 * Two things to know before changing this again, both learned the hard way:
 *
 * - **The speed sets the step, and the step sets whether shots can miss.** A
 *   droplet moves `speed × dt` per frame — 0.33 m here, against a capture sphere
 *   0.81 m across, so a comfortable margin. The hit test is swept against the
 *   step regardless (see `sweptHit` in `npcProjectiles`): a frame-end point test
 *   stops connecting above roughly `2r / dt` ≈ **49 u/s**, and the failure is
 *   silent — at 2000 every shot passed straight through every enemy and the gun
 *   simply never hit anything. The sweep is headroom at this speed and a
 *   necessity above that one.
 * - **The arc is `speed⁻²`.** Apex over a level shot is `g·flight²/8`, so
 *   doubling the speed quarters it. Measured over 6 m at 60 fps: about **9 cm**
 *   here and 2 cm at 40, both a little under the ideal (10.1 and 2.5 cm) because
 *   a frame-sampled rise is under-integrated — the same coarse-frame effect that
 *   makes the force field's shove land a few percent short. Beyond about 50 the
 *   flight is under five frames, and then the sampling itself flattens the arc
 *   further still, which is where a shot stops reading as thrown water at all.
 */
const MUZZLE_SPEED = 20

/** The tuning the player's gun carries. A structural subset of the manifest's
 *  `WeaponEntry`, so the rig can hand its entry straight in. */
export interface PlayerWeaponSpec {
    /** GLB served from `/props/…`. Consumed at attach. */
    url: string
    /** Hand bone name. Consumed at attach. */
    bone: string
    scale: number
    offset: [number, number, number]
    rotation: [number, number, number]
}

/** Default cadence, mirroring `playerFireInterval` in the store's settings. Only
 *  ever in play for the first frame — the rig pushes the live value every frame. */
const DEFAULT_FIRE_INTERVAL = 0.15

/**
 * What the shooter has to know about the world that it does not own.
 *
 * Injected as callbacks, exactly the way `npcEnemies` takes `getHostile` /
 * `getPlayerPosition` / `onPlayerHit`: it keeps this module importing nothing
 * from the store, the navmesh, or the terrain, and leaves the rig owning where
 * the player is and what is between them.
 */
export interface PlayerCombatOptions {
    /**
     * Whether a locked **enemy** may be shot at right now — in range, and with
     * terrain that does not come between.
     *
     * Asked **once per shot**, not per frame. The answer only has to be right at
     * the moment a droplet leaves the muzzle, and a terrain raycast is far too
     * expensive to run at frame rate for a question nothing else reads.
     *
     * False **drops the lock** rather than pausing it: a target that has walked
     * out of range or behind a hill is no longer being engaged, so the shot that
     * would have gone its way is skipped, not queued.
     *
     * Asked about an enemy lock only. A held point never reaches this — it does
     * not move, so there is nothing for the answer to change with; see
     * `holdFireAt`.
     */
    canEngage?: (aim: THREE.Vector3) => boolean
    /**
     * Called with the aim point just before a locked shot, so the caller can turn
     * the character to face it. Runs ahead of the gun calibration, so the barrel
     * is aimed on the same frame the droplet is spawned.
     *
     * Injected because the facing convention (`atan2(x, z)` written straight onto
     * the player group) belongs to the rig that owns that group and shares it
     * with the movement loop. A second copy here would drift from it.
     */
    onAim?: (aim: THREE.Vector3) => void
}

export interface PlayerCombat {
    /**
     * Adopt the manifest's weapon entry. Returns true when `url` or `bone`
     * changed, which is the one case a gun already in hand cannot absorb and the
     * caller has to re-attach — the same contract as the rig's `syncWeapon`.
     */
    setWeapon(spec: PlayerWeaponSpec): boolean
    /** Put the gun in the player's hand. Safe to call before the template has
     *  resolved (it simply stays unarmed), and a no-op when one is already held. */
    attach(rig: AvatarRig, template: THREE.Object3D | null): void
    /** Take the gun off the rig it is on, freeing its geometry and material.
     *  Idempotent. Must run before the rig that owns it is disposed — see
     *  `detachGun` for why that ordering is load-bearing. */
    detach(): void
    /** Arm/disarm — attack mode. Visibility follows this, not the crowd's. */
    setActive(active: boolean): void
    /**
     * Hold fire on `target` until it is gone, or stop firing with `null`.
     *
     * Fires immediately, then once every `fireInterval`, for as long as the
     * target keeps returning an aim point. Released by `setActive(false)`, by the
     * target going down, by the crowd being disposed, by `canEngage` saying no,
     * and by `holdFireAt`. All of them are one-way: re-acquiring is a fresh
     * `lockOn`, so a respawned NPC is not re-engaged.
     *
     * `null` is the stop-everything command: it ends a held point too, so the
     * rig can halt all fire without knowing which kind was running. The reverse
     * is not true — see `holdFireAt`.
     *
     * Safe to call while unarmed — the lock is simply dropped on the next frame,
     * which is what keeps a click during the disarm frame from arming anything.
     */
    lockOn(target: NpcTarget | null): void
    /**
     * Seconds between shots while locked on.
     *
     * Pushed every frame from the tunable, like the gun tuning, so a GUI drag
     * lands on the next shot with no rebuild. **Not clamped here**: the pool
     * caps the real rate at `POOL_SIZE / LIFETIME` (≈ 15/s) by dropping shots
     * once it is saturated, and a clamp that hid that would make the tunable
     * disagree with what the gun does.
     */
    setFireInterval(seconds: number): void
    /**
     * Whether a shot may play its recoil clip.
     *
     * The recoil is a *reflex* one-shot, and the emotion path gives a clip the
     * mixers outright — so with a shot every `fireInterval`, sustained fire holds
     * the body almost continuously. Anything else that wants the body has to be
     * able to take it away and keep it away, which is what this is for: the rig
     * suppresses the recoil while the character is airborne, so a jump renders as
     * a jump instead of being overruled by the next shot.
     *
     * Suppressing the clip does **not** hold fire. The droplet, the damage, the
     * cadence and the aim are all untouched — only the animation is held back.
     *
     * Pushed per frame like the interval, so it takes effect on the next shot.
     */
    setRecoilEnabled(enabled: boolean): void
    /** Match the armed walk / run clip cadence to the player's movement speed
     *  (the rig owns the clip sets; this just forwards the numbers). */
    setCadence(walk: number, run: number): void
    /** Re-aim the gun, keep its tuning live, and advance the droplets. Call once
     *  per frame **after** the mixers have posed the skeleton. */
    update(delta: number): void
    /**
     * Hold fire on a fixed point in the world — one droplet every
     * `fireInterval`, aimed once at `point` when it is set. The right-click
     * spray: fire at where the player pointed and keep firing.
     *
     * Aimed at nothing, so it damages nothing: a droplet that splashes on the
     * ground has no one at the landing spot to hurt (the same reason `shoot`
     * gives a free-aim shot its own landing point). It is still a threat the
     * crowd reacts to — the dodge reads the pool, not the shooter's intent — so
     * a spray across an enemy's feet makes it dodge without ever scoring.
     *
     * Released by `lockOn` (both the lock it starts and its `null`), by
     * `holdFireAt(null)` — which is how the rig cancels the spray when the
     * character sets off walking — by `setActive(false)`, and by disposal.
     * Deliberately **not** by `canEngage`: an enemy lock re-asks that every
     * shot because the enemy moves and a moment later may be behind a hill,
     * whereas a point does not move, so the answer could only change because
     * the player moved — and the two ways they can move, walking off and
     * re-aiming, are commands that release the hold themselves. Re-asking would
     * buy nothing and cost a way for the spray to lapse on its own: a jump
     * lengthens the shot, so a hold set at the range limit would drop mid-air,
     * and firing *through* a jump is the whole point of holding rather than
     * tapping.
     *
     * `point` is copied, so the caller keeps whatever scratch it read the point
     * out of. `null` ends a **point** hold and leaves an enemy lock alone — the
     * rig cancels a spray on the first step of a walk, and walking while
     * shooting an NPC is something the player is allowed to do.
     */
    holdFireAt(point: THREE.Vector3 | null): void
    /**
     * Is one of the player's own droplets inbound toward `point`, inside `radius`?
     * The read the crowd's dodge is triggered by — see
     * `NpcProjectiles.inboundThreat`.
     */
    inboundThreat(point: THREE.Vector3, radius: number): boolean
    dispose(): void
}

/**
 * What the trigger is held on.
 *
 * Two kinds rather than one because they answer "where is the next shot going?"
 * differently — an enemy is re-read every shot and can end the hold by going
 * down, a point is fixed and can only be released by a command — and only the
 * enemy kind is worth damage.
 */
type HeldFire =
    | { kind: 'target'; target: NpcTarget }
    | { kind: 'point'; point: THREE.Vector3 }

export function createPlayerCombat(
    scene: THREE.Scene,
    forwardRoot: THREE.Object3D,
    options: PlayerCombatOptions = {},
): PlayerCombat {
    // The player's own weapon object — never the crowd's, and mutated in place
    // like theirs so `applyGunTuning` reads the live placement off it.
    const weapon: NpcWeapon = {
        url: '',
        bone: '',
        // Driven by `setActive` (attack mode). Starts false: the app begins
        // peaceful, so the player begins unarmed.
        enabled: false,
        scale: 1,
        offset: [0, 0, 0],
        rotation: [0, 0, 0],
    }

    // Its own names: a second `npc-droplets` sibling would make
    // `scene.getObjectByName` — and every scene dump, including the
    // runtime-intelligence one — ambiguous between the two pools.
    const projectiles = createNpcProjectiles({
        scene,
        // Never used: every shot below carries its own `hitPoint`. Null rather
        // than a throwaway so a droplet spawned without one simply has nothing
        // to hit, instead of silently testing against the player.
        getTarget: () => null,
        names: { droplets: 'player-droplets', splashes: 'player-splashes' },
    })

    /** Scratch for the muzzle's world position — read once per shot. */
    const _muzzleWorld = new THREE.Vector3()

    let rig: AvatarRig | null = null
    let gun: NpcGun | null = null
    let disposed = false

    /** What the trigger is held on, or null for no fire. See `lockOn` and
     *  `holdFireAt` — the two kinds are the same sustained loop aimed
     *  differently, so one variable holds either and setting one clears the
     *  other. */
    let heldFire: HeldFire | null = null
    /** Seconds until the next locked shot. Negative means owed. */
    let fireCountdown = 0
    let fireInterval = DEFAULT_FIRE_INTERVAL
    /** Whether the recoil clip may play. See `setRecoilEnabled`. */
    let recoilEnabled = true

    /**
     * Remove the gun and free what it owns.
     *
     * Removing the mount first is not tidiness — it is a bug fix. The mount
     * hangs off a bone *inside* `rig.scene`, and the rig's own teardown
     * (`NavMeshRig`'s `disposeObject`) disposes `map` / `normalMap` and friends
     * on every material it walks over. A cloned material **shares its textures
     * by reference** with the module-cached template and with every NPC's gun,
     * so letting the rig's teardown reach the gun would turn the whole crowd
     * untextured. Hence: take it out of the graph first, and free only the
     * geometry and material this gun actually owns — never the maps.
     */
    const detachGun = () => {
        if (!gun) return
        gun.mount.removeFromParent()
        gun.mount.traverse((obj) => {
            const mesh = obj as THREE.Mesh
            if (!mesh.isMesh) return
            mesh.geometry?.dispose()
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
            for (const m of mats) m?.dispose()
        })
        gun = null
    }

    /**
     * Put one droplet in the air and play the recoil.
     *
     * The single body behind both ways of holding fire, so the two cannot
     * drift: an enemy-locked shot and a point-held shot are the same shot, only
     * aimed differently. The caller has already established that the gun is
     * armed and held.
     *
     * `destination` is where the droplet is *aimed* at spawn — the enemy's chest
     * for a locked shot, the clicked point for a free-aim one. With a `target`
     * the pool re-reads the aim from it every frame, so the ball tracks a moving
     * enemy rather than landing where it stood.
     */
    const shoot = (destination: THREE.Vector3, target?: NpcTarget | null) => {
        if (!gun) return

        gun.muzzle.updateWorldMatrix(true, false)
        gun.muzzle.getWorldPosition(_muzzleWorld)

        if (target) {
            // Re-read per frame by the pool, so the ball follows the enemy.
            const locked = target
            projectiles.spawn(
                _muzzleWorld,
                destination,
                MUZZLE_SPEED,
                () => locked.aimPoint(),
                // Damage, through the same handle that supplied the aim point —
                // the crowd decides what a droplet is worth, so nothing here
                // needs to know the number.
                () => locked.damage(),
            )
        } else {
            // A free-aim shot still needs something to hit, or it would fly
            // through its own landing point and only vanish on the fall limit.
            // Its own destination is that something, so the water splashes where
            // the player clicked.
            //
            // Copied per shot rather than read from a scratch: every droplet holds
            // this for its whole flight, so a second click would otherwise drag a
            // ball still in the air onto the new landing spot and burst the water
            // in the wrong place.
            const landing = destination.clone()
            projectiles.spawn(_muzzleWorld, landing, MUZZLE_SPEED, () => landing)
        }

        // The recoil, through the same path the crowd uses. Played after the
        // spawn so a missing FBX still produces the water — and skipped while
        // suppressed, which leaves the water exactly as it is. See
        // `setRecoilEnabled`: an emotion owns the mixers, so a recoil replayed
        // every `fireInterval` would otherwise never let a jump show.
        if (ARMED_FIRING_CLIP && recoilEnabled) rig?.playEmotionOnce(ARMED_FIRING_CLIP)
    }

    return {
        setWeapon(spec) {
            const changed = spec.url !== weapon.url || spec.bone !== weapon.bone
            weapon.url = spec.url
            weapon.bone = spec.bone
            weapon.scale = spec.scale
            weapon.offset[0] = spec.offset[0]
            weapon.offset[1] = spec.offset[1]
            weapon.offset[2] = spec.offset[2]
            weapon.rotation[0] = spec.rotation[0]
            weapon.rotation[1] = spec.rotation[1]
            weapon.rotation[2] = spec.rotation[2]
            return changed
        },

        attach(nextRig, template) {
            if (disposed || gun) return
            if (!nextRig || !template || !weapon.url || !weapon.bone) return
            rig = nextRig
            gun = attachGun(nextRig, forwardRoot, weapon, template)
        },

        detach() {
            detachGun()
            rig = null
        },

        setActive(active) {
            weapon.enabled = active
            // No hold can outlive the mode that armed it, enemy lock or held
            // point alike. Dropping it here, on the one path that disarms, means
            // leaving attack mode ends the fight rather than pausing it —
            // re-entering starts peaceful instead of silently resuming fire on
            // whoever, or whatever, was last pointed at.
            if (!active) heldFire = null
            // Hide immediately rather than waiting for the next frame's
            // `applyGunTuning`, so a mode toggle never shows a stale frame of gun.
            if (gun) gun.mount.visible = active
        },

        lockOn(target) {
            // Always fires on the next frame rather than after a full interval:
            // the click that set the lock should read as a shot, not as a fifth
            // of a second of nothing happening. The assignment replaces whatever
            // was held, so locking on also takes the trigger off a held point —
            // the character holds fire on one thing at a time.
            fireCountdown = 0
            heldFire = target ? { kind: 'target', target } : null
        },

        holdFireAt(point) {
            // Ending a spray is deliberately not the same as `lockOn(null)`: the
            // rig calls it on every frame the character is walking, and an enemy
            // lock has to survive that or the player could no longer advance
            // while shooting at an NPC. Only a point hold is ended here.
            if (!point) {
                if (heldFire?.kind === 'point') heldFire = null
                return
            }
            // Fires on the next frame, like `lockOn`. The point is copied rather
            // than held by reference, for the same reason a free-aim shot copies
            // its landing spot: the caller reads it from a shared scratch, and a
            // later click would otherwise drag a still-running spray onto the new
            // spot mid-flight.
            fireCountdown = 0
            heldFire = { kind: 'point', point: point.clone() }
        },

        setFireInterval(seconds) {
            fireInterval = seconds
        },

        setRecoilEnabled(enabled) {
            recoilEnabled = enabled
        },

        setCadence(walk, run) {
            rig?.setClipSetTimeScale(ARMED_SET_KEY, { walk, run })
        },

        update(delta) {
            if (disposed) return

            // The four steps below are in a deliberate order, and it is the
            // facing that fixes it: the character has to be turned toward the
            // target *before* the gun is calibrated, or every shot is aimed at
            // where the enemy was a frame ago.

            // 1. Resolve what is held, and decide whether this frame shoots.
            let aim: THREE.Vector3 | null = null
            let target: NpcTarget | null = null

            // Read into a local: the branches below can clear `heldFire`, and the
            // aim has to come from the hold this frame actually started with.
            const held = heldFire

            if (held) {
                if (!gun || !weapon.enabled) {
                    // Disarmed, or the gun is gone. `setActive` already clears on
                    // the way out of attack mode; this covers the other way a hold
                    // can be left holding nothing.
                    heldFire = null
                } else {
                    fireCountdown -= delta

                    if (fireCountdown <= 0) {
                        if (held.kind === 'target') {
                            const chest = held.target.aimPoint()

                            // Null means the NPC is down, or the crowd is gone.
                            // That null is the whole release rule — see
                            // NpcTarget.aimPoint.
                            if (!chest) {
                                heldFire = null
                            } else if (options.canEngage && !options.canEngage(chest)) {
                                // Out of range, or the terrain is in the way.
                                heldFire = null
                            } else {
                                // `chest` is the crowd's shared scratch — read it
                                // and use it this frame, which is exactly how long
                                // it lives.
                                aim = chest
                                target = held.target
                                options.onAim?.(chest)
                            }
                        } else {
                            // A held point, which is fired at as-is: no aim point
                            // to re-read, no `canEngage` to ask and no damage to
                            // deal. The point is our own copy, so it is safe to
                            // hand to the shot — the shot copies it again into the
                            // droplet's landing spot, so the drop of the hold
                            // never touches water already in the air.
                            aim = held.point
                            options.onAim?.(held.point)
                        }
                    }
                }
            }

            // 2. The gun, every frame — armed or not, firing or not. The hand
            //    moves as the idle and walk clips play, so a calibration skipped
            //    on a non-firing frame leaves the barrel trailing the hand.
            if (gun) {
                // Tuning is re-applied every frame so a lil-gui edit lands
                // without a rebuild, exactly as the crowd does it.
                applyGunTuning(gun, weapon)
                // …and the aim is re-solved every frame because the mixers have
                // just posed the skeleton. Aligning once at attach would leave
                // the barrel pointing wherever the hand happened to be then.
                if (weapon.enabled) calibrateGun(gun)
            }

            // 3. The shot, now that the barrel points where this frame's facing
            //    put it. `target` is null for a held point, which `shoot` reads as
            //    the free-aim case.
            if (aim) {
                shoot(aim, target)
                // Added rather than assigned, so the debt carries: an interval
                // that is not a whole number of frames keeps its average rate
                // instead of losing a slice of every gap to the rounding. At most
                // one shot a frame, so a long delta arrives as a quick follow-up
                // shot rather than as a burst.
                fireCountdown += fireInterval
            }

            // 4. The droplets.
            projectiles.update(delta)
        },

        // The pool's own method, forwarded rather than reimplemented: the crowd
        // asks its one question about the player's water, and the pool is where
        // the water is. Deliberately unguarded on `weapon.enabled` — this is asked
        // *about* droplets already in flight, and a player who leaves attack mode
        // mid-volley still has water in the air that an NPC is entitled to dodge.
        inboundThreat(point, radius) {
            return disposed ? false : projectiles.inboundThreat(point, radius)
        },

        dispose() {
            if (disposed) return
            disposed = true
            heldFire = null
            detachGun()
            projectiles.dispose()
        },
    }
}
