/**
 * Hand props for the NPC crowd.
 *
 * The water gun is a Tripo scan: one mesh, no skeleton, ~1.0 m long, and its
 * pivot is the bbox **centre** rather than the grip. Three measured facts drive
 * everything here (all read out of the GLB's position accessor):
 *
 * - The **barrel runs along +Z** (a thin tube at Z 0.33-0.46 with a dense
 *   muzzle cap at Z = +0.5), so the model's forward is +Z.
 * - **Up is +Y.**
 * - The **grip hangs below the body at Z ≈ -0.06, Y ≈ -0.17** — the only part
 *   of the mesh that reaches down to Y = -0.218, and narrow in X (~0.10).
 *
 * Aligning that +Z to the avatar's own forward is what makes the gun point
 * where its holder is facing, and it is why the mount below cancels the hand
 * bone's frame instead of using a hand-tuned Euler: the crowd yaws its NPCs
 * with `atan2(x, z)`, so +Z *is* forward for the avatar root, and cancelling
 * the hand rotation puts the gun's axes back on the avatar's.
 *
 * ## Cloning and ownership
 *
 * The parsed GLB is cached at module level and reused by every NPC and every
 * later crowd, so its **textures** are deliberately never disposed — they are
 * shared by every gun clone and outlive any one crowd.
 *
 * Each gun gets its own **geometry and material** clone, though. Geometry is
 * cheap (5.5k verts) and material clones still share the textures by reference,
 * so this costs very little and buys a simple ownership rule: the gun lives
 * under the avatar's hand bone, which means the rig's existing teardown walks
 * into it. If the geometry were shared, that teardown would free the GPU
 * buffers out from under every *other* NPC still holding one.
 */

import * as THREE from 'three'
import { findBone, loadGLB } from '../b3/b3-runtime/src/components/AvatarSDK'
import type { AvatarRig } from './avatarLoader'

/**
 * The point of the model a hand should close around, in gun-local units —
 * the middle of the grip, measured from the vertex cloud rather than guessed.
 *
 * A property of the *water-gun mesh*, not of the character, which is why it is
 * not part of a manifest weapon entry (see `WeaponEntry` in the SDK). A
 * differently-shaped model would want its own grip.
 */
const GRIP = new THREE.Vector3(0, -0.17, -0.06)

/**
 * The weapon to carry and where to hang it.
 *
 * A structural subset of the SDK's `WeaponEntry` — the crowd gets plain data and
 * never imports the avatar store, so it declares only what it reads. `url` and
 * `bone` are consumed once per avatar at attach; the rest is live.
 */
export interface NpcWeapon {
    /** GLB served from `/props/…`. */
    url: string
    /** Hand bone name — `findBone` handles the `mixamorig:` name sanitizing. */
    bone: string
    enabled: boolean
    /**
     * Desired **world** size, in metres — 0.5 is a half-metre gun in a ~1.7 m
     * avatar's hands.
     *
     * Worth spelling out that this is world size: the gun hangs off a bone, so
     * it inherits the skeleton's own scale, and the mixamo bodies are authored
     * in centimetres, so a hand bone's world scale is ~0.01. Left un-normalised
     * the gun renders about 5 mm long. `applyGunTuning` divides that back out.
     */
    scale: number
    /**
     * Nudge off the grip, in **centimetres** — `offset[1] = 5` lifts the gun
     * 5 cm out of the palm.
     *
     * Centimetres because that is the rig's own unit (a node under the hand bone
     * is scaled by 0.01); `applyGunTuning` normalises for it, so the number
     * means the same distance on a body of any scale — and unlike `scale` it is
     * *not* a world length. Read in the avatar's own axes (X left/right, Y up,
     * Z forward), the frame the barrel alignment targets, so it reads the same
     * way whatever pose the arm is in.
     */
    offset: [number, number, number]
    /** Nudge in degrees, on top of the computed alignment. */
    rotation: [number, number, number]
}

/**
 * Parsed templates, cached across crowds **by URL**.
 *
 * The promise (not the scene) is cached so two crowds starting in the same tick
 * share one download and one parse — and keyed by URL because a manifest can
 * name more than one weapon, where a single slot would hand the second weapon
 * the first one's mesh. A rejected load is dropped from the cache so a later
 * crowd can retry instead of being poisoned by a transient failure.
 */
const templatePromises = new Map<string, Promise<THREE.Object3D>>()

function loadGunTemplate(url: string): Promise<THREE.Object3D> {
    const cached = templatePromises.get(url)
    if (cached) return cached
    const pending = loadGLB(url)
        .then((gltf) => gltf.scene)
        .catch((err) => {
            templatePromises.delete(url)
            throw err
        })
    templatePromises.set(url, pending)
    return pending
}

/** Per-mesh geometry+material clone, so one NPC's teardown can't free another's. */
function cloneGun(template: THREE.Object3D): THREE.Object3D {
    const clone = template.clone(true)
    clone.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry = mesh.geometry.clone()
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map((m) => m.clone()) : mesh.material.clone()
    })
    return clone
}

const _basis = new THREE.Matrix4()
const _bx = new THREE.Vector3()
const _by = new THREE.Vector3()
const _bz = new THREE.Vector3()

/**
 * World rotation with scale **and shear** divided out.
 *
 * `Object3D.getWorldQuaternion` decomposes the world matrix, which reports the
 * wrong rotation once the matrix is sheared — and these rigs are: the composed
 * avatar root carries a -90 degrees X (the Z-up to Y-up correction) while the
 * mixamo bone chain below it carries its own scale, so the product is not a
 * clean rotate-and-scale. Trusting the decomposition put the guns ~45-60
 * degrees off the character's facing even though the mount's local quaternion
 * matched its target exactly. Gram-Schmidt the basis instead.
 */
function pureWorldQuaternion(obj: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
    obj.updateWorldMatrix(true, false)
    const m = obj.matrixWorld
    _bx.setFromMatrixColumn(m, 0).normalize()
    _by.setFromMatrixColumn(m, 1)
    _by.addScaledVector(_bx, -_by.dot(_bx)).normalize()
    _bz.crossVectors(_bx, _by)
    _basis.makeBasis(_bx, _by, _bz)
    return out.setFromRotationMatrix(_basis)
}

/** A gun attached to an NPC: the mount to toggle/pose, and the inner holder to tune. */
export interface NpcGun {
    /** Parented to the hand bone; hide this to disarm. */
    mount: THREE.Group
    /** Carries the user's scale/rotation nudge, in avatar-axes space. */
    holder: THREE.Group
    /** The hand bone's world scale, divided out so `tuning.scale` means metres. */
    handWorldScale: number
    /** Kept for re-calibration — see `calibrateGun`. */
    hand: THREE.Bone
    forwardRoot: THREE.Object3D
    /** Barrel tip. Read its world transform to spawn a projectile along the aim. */
    muzzle: THREE.Object3D
}

/**
 * Re-aim the gun along the character's forward **for the pose it is in now**.
 *
 * `attachGun` runs the instant `loadAvatar` resolves, when the skeleton is
 * still in its home pose — and every clip drops the arms a long way from
 * there, which is clearly visible: aligned once at load, the guns sit across
 * the NPCs' bodies until something re-aims them. So the caller runs this
 * **every frame**, after the mixers have posed the skeleton, which is what
 * keeps the barrel on the character's forward from the first drawn frame
 * rather than from the first frame the NPC happens to stand still.
 *
 * Re-running it cancels the hand's own rotation, so the gun holds its aim
 * while the arm rotates under it — it does not swing as a carried object
 * would. That is the intended read here: an armed NPC keeps the muzzle on
 * target.
 */
export function calibrateGun(gun: NpcGun): void {
    const handQuat = pureWorldQuaternion(gun.hand, _calibHand)
    const refQuat = pureWorldQuaternion(gun.forwardRoot, _calibRef)
    // The mount is a child of the hand, so its world rotation is
    // `handQuat * mountQuat`. Solving that for a world rotation of `refQuat`
    // gives `handQuat⁻¹ * refQuat` — the order matters, and getting it the other
    // way round (`refQuat * handQuat⁻¹`) still produced a *stable* mount that
    // simply was not aligned, which is easy to mistake for a pose problem.
    gun.mount.quaternion.copy(handQuat).invert().multiply(refQuat)
}

/** Scratch — `calibrateGun` runs on every armed NPC every frame. */
const _calibHand = new THREE.Quaternion()
const _calibRef = new THREE.Quaternion()

/**
 * Put a gun in the avatar's right hand, gripping it.
 *
 * `forwardRoot` is the node whose **+Z is the character's forward** — in the
 * crowd that is the NPC group, the same node `faceVelocity` yaws toward the
 * velocity. It is deliberately *not* `rig.scene`.
 *
 * `rig.scene` is the composed `Avatar` root, which carries a **-90 degrees X
 * rotation** — the Z-up to Y-up correction — so its own local +Z points at the
 * sky. Aligning the barrel to that frame stands the gun upright in the NPC's
 * fist (measured: barrel direction [0, 1, 0] against a facing of [0, 0, 1]).
 * The avatar really does face world +Z once upright: the vector from the ankle
 * to the toe tip measures [0, 0, +0.06] horizontally, i.e. along the group's
 * forward.
 *
 * `template` is the already-resolved GLB (see `loadWeaponTemplate`) — passed in
 * rather than fetched here so this stays synchronous, which is what lets the
 * crowd attach guns inside its sequential avatar-load loop. The weapon's
 * placement is applied from the same object, so there is no separate tuning
 * argument to keep in sync with it.
 *
 * Returns null when the model has no such bone — some bodies ship a reduced
 * skeleton, and a missing hand should disarm that NPC rather than throw.
 */
export function attachGun(
    rig: AvatarRig,
    forwardRoot: THREE.Object3D,
    weapon: NpcWeapon,
    template: THREE.Object3D | null,
): NpcGun | null {
    if (!template) return null

    const hand = findBone(rig.scene, weapon.bone)
    if (!hand) {
        console.warn(`[npcProps] no ${weapon.bone} bone on this avatar — no gun`)
        return null
    }

    const mount = new THREE.Group()
    mount.name = 'gun-mount'

    const holder = new THREE.Group()
    holder.name = 'gun-holder'

    const gun = cloneGun(template)
    // Slide the model so the grip sits on the holder's origin — which sits on
    // the hand bone's origin. After this no positional maths is needed: the
    // palm is the pivot, so the hand rotates the gun about the grip.
    gun.position.copy(GRIP).multiplyScalar(-1)

    // Barrel tip, in the gun model's own frame: the barrel runs along +Z and the
    // model is ~1 unit long, so the muzzle cap sits at +Z 0.5. Parented to the
    // clone so it inherits the holder's scale and the mount's calibration with no
    // `localToWorld` maths — projectiles spawn from `muzzle.getWorldPosition()`.
    const muzzle = new THREE.Object3D()
    muzzle.name = 'gun-muzzle'
    muzzle.position.set(0, 0, 0.5)
    gun.add(muzzle)

    holder.add(gun)
    mount.add(holder)
    hand.add(mount)

    // The skeleton's own scale. The mixamo bodies are authored in centimetres,
    // so this is ~0.004 — without dividing it out the gun renders millimetres
    // across and looks like it failed to load.
    const handWorldScale = new THREE.Vector3()
    hand.getWorldScale(handWorldScale)

    const npcGun: NpcGun = {
        mount,
        holder,
        handWorldScale: handWorldScale.x || 1,
        hand,
        forwardRoot,
        muzzle,
    }
    // Provisional, taken in the home pose — the caller re-aims it every frame
    // once the mixers are running. Kept so a gun that is attached and never
    // ticked is still aimed rather than left at an arbitrary rotation.
    calibrateGun(npcGun)
    applyGunTuning(npcGun, weapon)
    return npcGun
}

/** Metres in one rig unit — the mixamo bodies are authored in centimetres. */
const RIG_UNIT = 0.01

/** Apply live placement. Called on attach and again every frame while it holds. */
export function applyGunTuning(gun: NpcGun, weapon: NpcWeapon): void {
    gun.mount.visible = weapon.enabled
    const [offX, offY, offZ] = weapon.offset
    const [rotX, rotY, rotZ] = weapon.rotation
    // The holder sits under the calibration mount, which is a child of the hand
    // bone and so carries the skeleton's centimetre scale (measured 0.01). A
    // position here is therefore *rig units*, not metres: moving it by 1 moves
    // the gun 1 cm. Dividing by that scale converts the caller's centimetres so
    // the number means the same distance on a body of any scale — the same
    // correction `scale` needs below.
    //
    // A node's own rotation does not move its origin, so the offset is read in
    // the avatar's axes however the gun is later rotated.
    const perCm = RIG_UNIT / gun.handWorldScale
    gun.holder.position.set(offX * perCm, offY * perCm, offZ * perCm)
    gun.holder.scale.setScalar(weapon.scale / gun.handWorldScale)
    gun.holder.rotation.set(
        THREE.MathUtils.degToRad(rotX),
        THREE.MathUtils.degToRad(rotY),
        THREE.MathUtils.degToRad(rotZ),
    )
}

/**
 * Resolve a weapon's template, then hand it back for `attachGun`.
 *
 * Safe to call before any crowd exists, and idempotent — later crowds await the
 * same promise. Failures resolve to `null` rather than throwing, because every
 * caller already has a working "no gun" path.
 *
 * Kept a separate step from `attachGun` so the (async, once-per-url) load is not
 * mixed into the per-avatar attach — `attachGun` stays synchronous, which is
 * what lets it run inside the crowd's sequential avatar loop.
 */
export async function loadWeaponTemplate(url: string): Promise<THREE.Object3D | null> {
    try {
        return await loadGunTemplate(url)
    } catch (err) {
        console.warn(`[npcProps] weapon "${url}" failed to load — that NPC is unarmed:`, err)
        return null
    }
}
