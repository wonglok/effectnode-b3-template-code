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

/** Served from `public/props/`. */
const GUN_URL = '/props/water-gun.glb'

/** Which hand holds it. `findBone` handles the `mixamorig:` name sanitizing. */
const HAND_BONE = 'mixamorigRightHand'

/**
 * The point of the model a hand should close around, in gun-local units —
 * the middle of the grip, measured from the vertex cloud rather than guessed.
 */
const GRIP = new THREE.Vector3(0, -0.17, -0.06)

/** Per-NPC gun settings, read live from the rig's lil-gui-bound object. */
export interface GunTuning {
    enabled: boolean
    /**
     * Desired **world** size, as a fraction of the model's natural 1 m. 0.5 puts
     * a half-metre gun in a ~1.7 m avatar's hands.
     *
     * Worth being explicit that this is world size: the gun hangs off a bone, so
     * it inherits the skeleton's own scale — and the mixamo bodies are authored
     * in centimetres, so a hand bone's world scale is around 0.004. Left
     * un-normalised the gun renders about 5 mm long. `applyGunTuning` divides
     * that back out.
     */
    scale: number
    /**
     * Nudge off the grip, in **world units** (the same ones `scale` is in), so
     * `offY = 0.05` lifts the gun 5 cm out of the palm whatever the skeleton's
     * own scale is. Applied in the avatar's own axes — the frame the barrel
     * alignment targets — not the hand's, so a nudge here means the same thing
     * for every NPC regardless of how the arm is posed.
     */
    offX: number
    offY: number
    offZ: number
    /** Extra nudge in degrees on top of the computed alignment. */
    rotX: number
    rotY: number
    rotZ: number
}

export const DEFAULT_GUN_TUNING: GunTuning = {
    enabled: true,
    scale: 0.5,
    offX: 0,
    offY: 0,
    offZ: 0,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
}

/**
 * The parsed template, cached across crowds.
 *
 * The promise (not the scene) is cached so two crowds starting in the same
 * tick share one download and one parse. A rejected load is dropped from the
 * cache so a later crowd can retry instead of being poisoned by a transient
 * failure.
 */
let templatePromise: Promise<THREE.Object3D> | null = null

function loadGunTemplate(): Promise<THREE.Object3D> {
    if (!templatePromise) {
        templatePromise = loadGLB(GUN_URL)
            .then((gltf) => gltf.scene)
            .catch((err) => {
                templatePromise = null
                throw err
            })
    }
    return templatePromise
}

/** Per-mesh geometry+material clone, so one NPC's teardown can't free another's. */
function cloneGun(template: THREE.Object3D): THREE.Object3D {
    const clone = template.clone(true)
    clone.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.geometry = mesh.geometry.clone()
        mesh.material = Array.isArray(mesh.material)
            ? mesh.material.map((m) => m.clone())
            : mesh.material.clone()
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
 * This has to run in a real animation pose, not at attach time. `attachGun`
 * runs the instant `loadAvatar` resolves, when the skeleton is still in its
 * home pose — and the idle clip drops the arms a long way from there, which is
 * clearly visible: aligned at load, the guns sit across the NPCs' bodies. The
 * caller re-runs this while an NPC is standing, so the offset is taken from
 * the pose the player actually looks at. It stays a fixed local offset after
 * that, so the gun still swings with the arm while walking.
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

/** Scratch — `calibrateGun` runs every frame while an NPC stands. */
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
 * Returns null when the model has no such bone — some bodies ship a reduced
 * skeleton, and a missing hand should disarm that NPC rather than throw.
 */
export function attachGun(
    rig: AvatarRig,
    forwardRoot: THREE.Object3D,
    tuning: GunTuning,
): NpcGun | null {
    const template = templateRef
    if (!template) return null

    const hand = findBone(rig.scene, HAND_BONE)
    if (!hand) {
        console.warn(`[npcProps] no ${HAND_BONE} bone on this avatar — no gun`)
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
    // Provisional only — the caller re-aims it once the NPC is standing, by
    // which point the idle clip has posed the arm. See `calibrateGun`.
    calibrateGun(npcGun)
    applyGunTuning(npcGun, tuning)
    return npcGun
}

/** Apply live tuning. Called on attach and again whenever the GUI changes. */
export function applyGunTuning(gun: NpcGun, tuning: GunTuning): void {
    gun.mount.visible = tuning.enabled
    // The holder hangs off the calibration mount, which is unit-scaled, so a
    // position here is plain world units — the hand's centimetre scale is
    // already behind us (it is divided out of `scale` below, and never reaches
    // this node). Its own rotation does not move its origin, so the offset is
    // read in the avatar's axes however the gun is later rotated.
    gun.holder.position.set(tuning.offX, tuning.offY, tuning.offZ)
    gun.holder.scale.setScalar(tuning.scale / gun.handWorldScale)
    gun.holder.rotation.set(
        THREE.MathUtils.degToRad(tuning.rotX),
        THREE.MathUtils.degToRad(tuning.rotY),
        THREE.MathUtils.degToRad(tuning.rotZ),
    )
}

/** Set once the template resolves; `attachGun` is synchronous, its callers await. */
let templateRef: THREE.Object3D | null = null

/**
 * Resolve and cache the template, then arm `attachGun`.
 *
 * Safe to call before any crowd exists, and idempotent — later crowds await the
 * same promise. Failures are swallowed into a `false` because every caller has
 * a working "no gun" path.
 */
export async function readyNpcProps(): Promise<boolean> {
    try {
        templateRef = await loadGunTemplate()
        return true
    } catch (err) {
        console.warn('[npcProps] water gun failed to load — NPCs will be unarmed:', err)
        return false
    }
}
