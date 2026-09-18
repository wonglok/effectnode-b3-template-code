'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { GUI } from 'lil-gui'
import type { Vec3 } from 'mathcat'
import { createFindNearestPolyResult, DEFAULT_QUERY_FILTER, findNearestPoly, findPath, moveAlongSurface } from 'navcat'
import { generateSoloNavMesh, type SoloNavMeshInput, type SoloNavMeshOptions } from 'navcat/blocks'
import { createNavMeshHelper, getPositionsAndIndices } from 'navcat/three'
import { CRATE_POOL_SIZE, useBlenderStore, useNavRigStore } from '../b3/b3-runtime/src'
import type { EmotionDef } from '../b3/b3-runtime/src/components/stores/navRigStore'
import { buildWalkableMeshesFromStore } from './blenderWalkableMeshes'
import { BASE_SET_KEY, loadAvatar, LOCOMOTION_KEYS, type AvatarConfig, type AvatarRig } from './avatarLoader'
import { AIM_HEIGHT, createNpcEnemies, type NpcEnemies, type NpcTarget } from './npcEnemies'
import { DEFAULT_WEAPON_BONE, type WeaponEntry } from '../b3/b3-runtime/src/components/AvatarSDK'
import { ARMED_SET_KEY, isReflexEmotion } from './armedClipSet'
import { DEATH_CLIPS } from './deathClip'
import { BAR_HEIGHT_ABOVE, createHealthBar } from './healthBar'
import { createHealthCrates, type HealthCrates } from './healthCrates'
import { createPlayerCombat, type PlayerCombat } from './playerCombat'
import { loadWeaponTemplate, type NpcWeapon } from './npcProps'
import { avatarConfigSnapshot, useAvatarStore } from './avatar/useAvatarStore'
import {
    ImmersiveControls,
    CAMERA_INITIAL_RADIUS,
} from '../b3/b3-runtime/src/components/blender/canvas-units/ImmersiveControls'
import { Spherical } from 'three'
import { Vector3 } from 'three'
import { useGameGlobal } from './useGameGlobal'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Dispose a mesh (and its geometry / materials). */
function disposeMesh(mesh: THREE.Mesh) {
    mesh.geometry?.dispose()
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) m?.dispose()
}

/**
 * How near the pointer an enemy's chest has to project, in pixels, to count as
 * being aimed at. Generous on purpose: it is also the touch slop for a tap, and
 * a miss here reads as "the gun did not fire" rather than as a near miss.
 */
const PICK_RADIUS_PX = 40

/**
 * How close to the target a terrain hit still counts as a clear shot, in world
 * units.
 *
 * The line-of-sight ray runs chest to chest, and the last stretch of it grazes
 * the ground the target is standing on — so without this, an enemy on a rising
 * slope reads as behind cover. Wide enough to forgive that final approach, far
 * short of the ~3 m standoff the crowd closes to, so a hill genuinely between
 * the two is still a block.
 */
const LOS_CLEARANCE = 0.5

/** Dispose an entire Object3D subtree. */
function disposeObject(root: THREE.Object3D) {
    root.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.isMesh) {
            mesh.geometry?.dispose()
            const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
            for (const m of mats) {
                if (m) {
                    const m2 = m as THREE.MeshStandardMaterial
                    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap'] as const) {
                        m2[k]?.dispose()
                    }
                    m.dispose()
                }
            }
        }
    })
}

/** Start position above the centre of the level's bounding box. */
function computeStartPosition(meshes: THREE.Mesh[]): Vec3 {
    const box = new THREE.Box3()
    for (const m of meshes) box.expandByObject(m)
    const center = box.getCenter(new THREE.Vector3())
    const maxY = box.max.y
    return [center.x, maxY + 2, center.z]
}

/**
 * World-space position of the "birthplace" marker — the first object whose
 * name contains "birthplace", from the live Blender sync or the rendered
 * scene. Returns null when no such object exists.
 */
function findBirthplacePosition(scene: THREE.Scene): THREE.Vector3 | null {
    // Live Blender sync — any object type (EMPTY, MESH, …) with a world transform.
    const { sceneData } = useBlenderStore.getState()
    for (const obj of sceneData.objects) {
        if (obj.name.toLowerCase().includes('birthplace')) {
            return new THREE.Vector3(...obj.position)
        }
    }

    // Rendered scene (deployment / SyncViewer copies) — keeps the Blender name.
    const markers: THREE.Object3D[] = []
    scene.traverse((obj) => {
        if (obj.name.toLowerCase().includes('birthplace')) markers.push(obj)
    })
    return markers.length > 0 ? markers[0].getWorldPosition(new THREE.Vector3()) : null
}

// ---------------------------------------------------------------------------
// Per-frame state (created in the effect, consumed by useFrame)
// ---------------------------------------------------------------------------

interface RigFrame {
    frame: (delta: number, _: any) => void
}

// ---------------------------------------------------------------------------
// Component — mounts inside CanvasGPU and drives the R3F scene + camera
// ---------------------------------------------------------------------------

interface NavMeshRigProps {
    /** Container div (inside the sidebar) that the lil-gui mounts into. */
    guiContainer?: RefObject<HTMLDivElement | null>
}

export function NavMeshRig({ guiContainer }: NavMeshRigProps) {
    const scene = useThree((s) => s.scene)
    const camera = useThree((s) => s.camera)
    const gl = useThree((s) => s.gl)
    const frameRef = useRef<RigFrame>({ frame: () => {} })
    const [player, setPlayer] = useState<any>(null)
    // Setup once: navmesh from the synced *collider* meshes, character, GUI, input
    useEffect(() => {
        let disposed = false
        let retryInterval = 0

        // Mutable settings shared with the lil-gui controls (which write in place).
        const settings = useNavRigStore.getState().settings

        // The weapon the NPC crowd carries, mirrored from the avatar store into
        // a plain object the crowd holds by reference — the same contract as
        // `settings`. It is written in place rather than replaced so a crowd
        // that is already built (and reading it every frame) keeps seeing the
        // live values; the avatar store's `weapons` array is immutable, and
        // re-reading it per frame would mean a store lookup per NPC per frame.
        const weapon: NpcWeapon = {
            url: '',
            bone: DEFAULT_WEAPON_BONE,
            enabled: false,
            scale: 0,
            offset: [0, 0, 0],
            rotation: [0, 0, 0],
        }
        // Which entry `weapon` mirrors, and the url/bone last handed to a crowd.
        // The crowd bakes those two into every avatar it builds, so a change to
        // either is the one weapon edit that needs a respawn.
        let weaponId: string | null = null
        let weaponSpec = ''

        // ------------------------------------------------------------------
        // Navmesh
        // ------------------------------------------------------------------
        let navMesh: any = null
        let navMeshHelper: any = null

        /**
         * Collect the walkable collider meshes. Prefers the live Blender store
         * (transient copies we own); falls back to collider meshes already rendered
         * in this scene (e.g. a deployment rendered by ProductionViewer), which the
         * scene owns and must not be disposed.
         */
        const buildColliderMeshes = (): {
            meshes: THREE.Mesh[]
            owned: boolean
        } => {
            const store = buildWalkableMeshesFromStore()
            if (store.length > 0) return { meshes: store, owned: true }

            const sceneColliders: THREE.Mesh[] = []
            scene.traverse((obj) => {
                const m = obj as THREE.Mesh
                if (m.isMesh && m.name.toLowerCase().includes('collider')) {
                    sceneColliders.push(m)
                }
            })
            return { meshes: sceneColliders, owned: false }
        }

        let warnedNoCollider = false

        const generateNavMesh = () => {
            if (navMeshHelper?.object) {
                scene.remove(navMeshHelper.object)
                disposeObject(navMeshHelper.object)
                navMeshHelper = null
            }

            const { meshes: colliders, owned } = buildColliderMeshes()
            if (colliders.length === 0) {
                if (!warnedNoCollider) {
                    console.warn(
                        "[NavMeshRig] No *collider* mesh found — name a Blender object 'collider' or include one in the deployment.",
                    )
                    warnedNoCollider = true
                }
                return null
            }

            const [positions, indices] = getPositionsAndIndices(colliders)
            // Only dispose the transient store copies — scene-owned meshes stay.
            if (owned) for (const m of colliders) disposeMesh(m)

            const input: SoloNavMeshInput = { positions, indices }
            const config: SoloNavMeshOptions = {
                cellSize: settings.cellSize,
                cellHeight: settings.cellHeight,
                walkableRadiusWorld: settings.walkableRadius,
                walkableRadiusVoxels: Math.ceil(settings.walkableRadius / settings.cellSize),
                walkableClimbWorld: settings.walkableClimb,
                walkableClimbVoxels: Math.ceil(settings.walkableClimb / settings.cellHeight),
                walkableHeightWorld: settings.walkableHeight,
                walkableHeightVoxels: Math.ceil(settings.walkableHeight / settings.cellHeight),
                walkableSlopeAngleDegrees: settings.walkableSlopeAngle,
                borderSize: 4,
                minRegionArea: 12,
                mergeRegionArea: 20,
                maxSimplificationError: 1.3,
                maxEdgeLength: 12,
                maxVerticesPerPoly: 6,
                detailSampleDistance: 6,
                detailSampleMaxError: 1,
            }

            const result = generateSoloNavMesh(input, config)
            navMesh = result.navMesh

            // Every path that produces a navmesh comes through here, so this is
            // the one place the NPC crowd has to be told about it. `navMesh` is
            // a brand-new object each time — a crowd left pointing at the old
            // one would be steering agents on a mesh with no relation to the
            // scene. Avatars are kept; only the crowd is re-based.
            ensureNpcs()
            // Same reason, same site: a crate seated on the old mesh is now
            // floating over whatever the new one does not cover.
            ensureCrates()

            navMeshHelper = createNavMeshHelper(navMesh)
            navMeshHelper.object.position.y += 0.15
            scene.add(navMeshHelper.object)

            console.log('[NavMeshRig] Navmesh generated')
            return navMesh
        }

        // ------------------------------------------------------------------
        // Player + character
        // ------------------------------------------------------------------
        const playerGroup = new THREE.Group()
        playerGroup.name = 'player' // ZoomControls follows this group
        playerGroup.position.set(0, 2, 0)
        playerGroup.userData.spherical = new Spherical(CAMERA_INITIAL_RADIUS, 0, 0)
        scene.add(playerGroup)

        useGameGlobal.setState({
            playerGroup: playerGroup,
        })

        setPlayer(playerGroup)

        // The player's half of the fight — its own droplet pool, its own gun,
        // and its own copy of the weapon tuning (see `playerCombat` for why the
        // last of those cannot be the `weapon` object above). `playerGroup` is
        // the forward reference: the gun is calibrated to the character's
        // forward, and `rig.scene` cannot serve because it carries the Z-up to
        // Y-up correction, which points its own +Z at the sky.
        const playerCombat: PlayerCombat = createPlayerCombat(scene, playerGroup, {
            // Both close over the picking helpers declared further down this same
            // effect — the forward reference `groundPointFromPointer` already makes
            // to `refreshColliderObjects`. Neither runs before the frame loop, by
            // which point everything below has been built.
            canEngage: (aim) => inEngageRange(aim) && hasLineOfSight(aim),
            onAim: (aim) => faceTowards(aim),
        })
        // Resolved once and reused, so a gun can be attached synchronously the
        // moment an avatar lands — awaiting the load inside `mountAvatar` would
        // race a mode toggle and could attach twice.
        let gunTemplate: THREE.Object3D | null = null

        // The player's own floating bar, exactly as each NPC has one. The HUD
        // repeats the same number in DOM, because the camera trails the player
        // and this can be hidden behind the avatar or the scenery.
        const playerBar = createHealthBar()
        playerBar.sprite.position.set(0, BAR_HEIGHT_ABOVE, 0)
        playerGroup.add(playerBar.sprite)

        /** Set while the player is down: no walking, no shooting, no damage. */
        let playerDowned = false
        let playerRespawnTimer = 0

        const agentHelper = new THREE.Mesh(
            new THREE.CapsuleGeometry(settings.walkableRadius, settings.walkableHeight),
            new THREE.MeshBasicMaterial({ color: 0xff0000, wireframe: true }),
        )
        agentHelper.position.y = 0.9
        playerGroup.add(agentHelper)

        // The composed SDK avatar rides inside the player group. It's driven by the
        // avatar tuning store (DevPage left sidebar): structural changes — the
        // body/head look, or which stay clip feeds each rig state — rebuild the
        // composed avatar; offset / visibility / speed / pause tweaks apply live.
        let avatarRig: AvatarRig | null = null
        let avatarBuildId = 0

        const disposeRig = () => {
            const old = avatarRig
            avatarRig = null
            if (!old) return
            // Take the gun off **before** `disposeObject` walks the rig. The gun
            // hangs off a bone inside `old.scene`, and `disposeObject` disposes
            // `map` / `normalMap` / … on every material it finds — but a gun's
            // material clone still shares its textures by reference with the
            // module-cached template and every NPC's gun, so letting the rig's
            // teardown reach it would strip the textures off the whole crowd.
            playerCombat.detach()
            if (old.scene.parent === playerGroup) playerGroup.remove(old.scene)
            old.dispose()
            disposeObject(old.scene)
        }

        /**
         * Put the whole rig into (or out of) attack mode.
         *
         * One function because the mode has to move three things together — the
         * gun, the clip set, and the crowd's hostility — and applying them from
         * separate call sites is how they end up disagreeing. The crowd reads
         * its half straight off the store, so nothing is pushed to it here.
         */
        const applyAttackMode = (active: boolean) => {
            // Downed overrides attack mode: a corpse holds no gun. Routing both
            // through here keeps one writer for the gun's visibility, so a mode
            // toggle during the down window cannot pop it back into view.
            playerCombat.setActive(active && !playerDowned)
            avatarRig?.setClipSet(active && !playerDowned ? ARMED_SET_KEY : BASE_SET_KEY)
            // Only meaningful while armed, and cheap; kept unconditional so the
            // numbers are already right when the set becomes live.
            const { settings } = useNavRigStore.getState()
            playerCombat.setCadence(settings.playerArmedWalkTimescale, settings.playerArmedRunTimescale)
        }

        /**
         * The player goes down: clear every order, drop the gun, play the fall.
         *
         * Input is not disabled per-source — the frame loop's `canMove` reads
         * `playerDowned`, and firing is blocked by the gun being holstered, so
         * there is nothing else to switch off. A held key is deliberately left
         * held: releasing it while down should not fire a keyup that the loop
         * then acts on, and `canMove` already ignores it.
         */
        const downPlayer = () => {
            if (playerDowned) return
            playerDowned = true
            playerRespawnTimer = Math.max(0, settings.playerRespawnSeconds)
            // Cancel an in-flight walk order and its marker, so the player does
            // not resume mid-route on revive.
            path.length = 0
            targetReached = false
            targetMarker.visible = false
            isJumping = false
            jumpOffset = 0
            jumpVelocity = 0
            // Holsters through the one writer, rather than poking the gun here.
            applyAttackMode(useNavRigStore.getState().attackMode)
            if (DEATH_CLIPS.length > 0) avatarRig?.playEmotionOnce(DEATH_CLIPS[0])
        }

        /**
         * Back on your feet at full health.
         *
         * The HP write is the store's, and it re-enters through the subscription
         * below — which is why that subscription only guards the *crossing* to
         * zero rather than reacting to every change.
         */
        const revivePlayer = () => {
            playerDowned = false
            playerRespawnTimer = 0
            useNavRigStore.getState().resetPlayerHp()
            applyAttackMode(useNavRigStore.getState().attackMode)
        }

        /** Keep the floating bar on the live number. Called on every HP change. */
        const syncPlayerBar = () => {
            const { playerHp, settings: s } = useNavRigStore.getState()
            playerBar.setFraction(playerHp / Math.max(1, s.maxHp), playerHp, s.maxHp)
        }

        const mountAvatar = (config: AvatarConfig) => {
            const id = ++avatarBuildId
            disposeRig()
            loadAvatar(config)
                .then((rig) => {
                    if (disposed || id !== avatarBuildId) {
                        rig.dispose()
                        return
                    }
                    avatarRig = rig
                    playerGroup.add(rig.scene)
                    // Push the current live store state onto the fresh rig.
                    const s = useAvatarStore.getState()
                    rig.setBodyOffset(s.body)
                    rig.setHeadOffset(s.head)
                    rig.setVisibility({ body: s.bodyVisible, face: s.faceVisible })
                    rig.setSpeed(s.speed)
                    rig.setPaused(!s.playing)
                    // Synchronous, because the template was resolved ahead of
                    // time (see `resolveGunTemplate`). A null template just
                    // leaves the player unarmed until the load lands.
                    playerCombat.attach(rig, gunTemplate)
                    // A fresh rig always starts on the base set, so attack mode
                    // has to be re-applied here — otherwise swapping body or face
                    // while armed would silently drop the character back to the
                    // unarmed pose with a gun still in hand. After `attach`, so
                    // the armed cadence lands on the rig that just took the gun.
                    applyAttackMode(useNavRigStore.getState().attackMode)
                })
                .catch((err) => {
                    console.warn('[NavMeshRig] Failed to load avatar:', err)
                })
        }

        mountAvatar(avatarConfigSnapshot())

        const tupleEq = (a: readonly number[], b: readonly number[]) =>
            a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
        const offsetsEqual = (
            a: {
                position: readonly number[]
                rotation: readonly number[]
                scale: readonly number[]
            },
            b: typeof a,
        ) => tupleEq(a.position, b.position) && tupleEq(a.rotation, b.rotation) && tupleEq(a.scale, b.scale)

        // React to store edits without a re-render (this whole rig lives in one
        // effect). Structural changes rebuild the avatar; the rest tune it live.
        const unsubAvatar = useAvatarStore.subscribe((s, prev) => {
            const lookChanged =
                s.assets.body !== prev.assets.body || s.assets.face !== prev.assets.face || s.headBone !== prev.headBone
            const rigChanged = LOCOMOTION_KEYS.some((k) => s.rigClips[k]?.url !== prev.rigClips[k]?.url)
            if (lookChanged || rigChanged) {
                mountAvatar(avatarConfigSnapshot())
                return
            }
            const rig = avatarRig
            if (!rig) return
            if (!offsetsEqual(s.body, prev.body)) rig.setBodyOffset(s.body)
            if (!offsetsEqual(s.head, prev.head)) rig.setHeadOffset(s.head)
            if (s.bodyVisible !== prev.bodyVisible || s.faceVisible !== prev.faceVisible) {
                rig.setVisibility({ body: s.bodyVisible, face: s.faceVisible })
            }
            if (s.speed !== prev.speed) rig.setSpeed(s.speed)
            if (s.playing !== prev.playing) rig.setPaused(!s.playing)
        })

        /**
         * The entry the crowd carries: the first enabled one, or — when none is
         * enabled — the first entry at all.
         *
         * That fallback is load-bearing. `enabled` is the crowd's live *draw*
         * flag (`applyGunTuning` reads it every frame), so the sidebar toggle is
         * an instant show/hide. Selecting strictly on `enabled` would instead
         * make the toggle change *which weapon the crowd carries*, and since
         * url/bone are baked into every built avatar that would force a respawn
         * on every click.
         */
        const pickWeapon = (weapons: WeaponEntry[]): WeaponEntry | null =>
            weapons.find((w) => w.enabled) ?? weapons[0] ?? null

        /**
         * Mirror the active manifest weapon into the crowd's `weapon` object.
         * Returns true when the url/bone changed, which is the one case the
         * already-built avatars cannot absorb.
         */
        const syncWeapon = (weapons: WeaponEntry[]): boolean => {
            const entry = pickWeapon(weapons)
            if (!entry) {
                weapon.enabled = false
                return false
            }
            weaponId = entry.id
            weapon.enabled = entry.enabled
            weapon.scale = entry.scale
            weapon.offset[0] = entry.offset[0]
            weapon.offset[1] = entry.offset[1]
            weapon.offset[2] = entry.offset[2]
            weapon.rotation[0] = entry.rotation[0]
            weapon.rotation[1] = entry.rotation[1]
            weapon.rotation[2] = entry.rotation[2]

            const spec = `${entry.url}~${entry.bone}`
            // `weaponSpec` is latched by `ensureNpcs`, so an empty one means no
            // crowd has been built yet and there is nothing to respawn.
            const changed = weaponSpec !== '' && spec !== weaponSpec
            weapon.url = entry.url
            weapon.bone = entry.bone

            // Mirror the same entry onto the player's own weapon object. Only the
            // tuning is copied — its `enabled` is attack mode, not the manifest's
            // draw flag — but copying it here is what keeps lil-gui edits to
            // scale / offset / rotation live on the player's gun too.
            if (playerCombat.setWeapon(entry)) {
                // url or bone changed: a gun already in the hand cannot absorb
                // either, so drop it and re-resolve against the new template.
                playerCombat.detach()
                resolveGunTemplate(entry.url)
            }
            return changed
        }

        /**
         * Resolve a weapon template ahead of any avatar needing it.
         *
         * Cached by url inside `npcProps`, so this is one download per weapon no
         * matter how many crowds, respawns and rig rebuilds follow — and it means
         * an attach can be synchronous, which is what keeps it race-free.
         */
        const resolveGunTemplate = (url: string) => {
            const wanted = url
            void loadWeaponTemplate(wanted).then((template) => {
                if (disposed || wanted !== weapon.url) return
                gunTemplate = template
                // A rig built while the template was still in flight has no gun;
                // give it one now. Guarded on `avatarRig` because a rebuild may
                // have replaced it — the fresh rig attaches in `mountAvatar`.
                if (avatarRig) playerCombat.attach(avatarRig, gunTemplate)
            })
        }

        // ------------------------------------------------------------------
        // Place the player on the navmesh
        // ------------------------------------------------------------------
        const placePlayer = () => {
            if (!navMesh) return

            // Adopt a resolved placement as the player's start, and publish it so
            // scene props (the welcome sign) can sit at the start without having to
            // reconstruct where that is. This function is the only authority on it:
            // placement prefers a scene *birthplace* marker over anything derivable
            // from the geometry, and re-runs when Blender re-syncs.
            const adoptStart = (position: ArrayLike<number>) => {
                playerGroup.position.fromArray(position)
                useGameGlobal.setState({ startPosition: playerGroup.position.clone() })
            }

            // Prefer a named *birthplace* marker — snap the player onto the navmesh
            // at that location; otherwise fall back to auto-placement below.
            const birthplace = findBirthplacePosition(scene)
            if (birthplace) {
                const result = findNearestPoly(
                    createFindNearestPolyResult(),
                    navMesh,
                    [birthplace.x, birthplace.y, birthplace.z],
                    [50, 50, 50],
                    DEFAULT_QUERY_FILTER,
                )
                if (result.success) {
                    adoptStart(result.position)
                    console.log('[NavMeshRig] Positioned player at birthplace:', result.position)
                    return
                }
                console.warn('[NavMeshRig] Birthplace not on navmesh — falling back to auto placement')
            }

            const { meshes: colliders, owned } = buildColliderMeshes()
            if (colliders.length === 0) return

            const box = new THREE.Box3()
            for (const m of colliders) box.expandByObject(m)
            const boxCenter = box.getCenter(new THREE.Vector3())
            const candidates: Vec3[] = [
                computeStartPosition(colliders),
                [boxCenter.x, boxCenter.y, boxCenter.z],
                [0, 2, 0],
            ]
            if (owned) for (const m of colliders) disposeMesh(m)

            for (const candidate of candidates) {
                const result = findNearestPoly(
                    createFindNearestPolyResult(),
                    navMesh,
                    candidate,
                    [50, 50, 50],
                    DEFAULT_QUERY_FILTER,
                )
                if (result.success) {
                    adoptStart(result.position)
                    console.log('[NavMeshRig] Positioned player at:', result.position)
                    return
                }
            }
            console.warn('[NavMeshRig] Could not find starting position on navmesh')
        }

        // ------------------------------------------------------------------
        // NPC enemies
        // ------------------------------------------------------------------
        // Created lazily from whichever code path first produces a navmesh, and
        // re-based (never rebuilt) when one replaces it. Declared here, above
        // the generate call below, because `generateNavMesh` calls it — the
        // lazy on-demand path inside `updateTargetFromPointer` runs long after
        // this line, so the binding is always initialised by then.
        let npcs: NpcEnemies | null = null
        let crates: HealthCrates | null = null
        let npcsLoading = false
        // Bumped whenever the crowd is torn down, so an avatar load that was
        // already in flight can tell it has been superseded.
        let npcsGeneration = 0

        /**
         * The crates, on the same contract as the crowd: built once, re-based
         * whenever the navmesh is rebuilt. No generation counter and no loading
         * flag — nothing here is asynchronous, so there is no window in which a
         * second call could land on a half-built result.
         */
        const ensureCrates = () => {
            if (!navMesh) return
            if (crates) {
                crates.setNavMesh(navMesh)
                return
            }
            crates = createHealthCrates({
                scene,
                navMesh,
                poolSize: CRATE_POOL_SIZE,
                // lil-gui mutates `settings` in place, so the pool reads the
                // live crate tunables every frame with no wiring.
                tunables: settings,
                getPlayerPosition: () => playerGroup.position,
                // A crate is only taken by a player who can use it: up on their
                // feet, and actually missing health. The downed case matters —
                // at 0 HP `hp < maxHp` is true, so without the `playerDowned`
                // gate a player shot dead on top of a crate would burn it to
                // heal a corpse, and the HUD would flip back to "Health" while
                // the avatar still lay on the floor. The down beat belongs to
                // `playerRespawnTimer`; a crate does not revive.
                canCollect: () =>
                    !playerDowned && useNavRigStore.getState().playerHp < settings.maxHp,
                onCollect: (heal) => useNavRigStore.getState().healPlayer(heal),
            })
        }

        const ensureNpcs = () => {
            if (!navMesh) return
            if (npcs) {
                npcs.setNavMesh(navMesh)
                return
            }
            // Two generates in quick succession would otherwise start two
            // crowds, since `npcs` stays null until the avatars finish loading.
            if (npcsLoading) return
            npcsLoading = true
            const generation = npcsGeneration
            // Latched before the (slow) avatar loads, so the respawn this crowd
            // is built from can be compared against later edits.
            weaponSpec = `${weapon.url}~${weapon.bone}`
            void createNpcEnemies({
                scene,
                navMesh,
                count: settings.npcCount,
                getPlayerPosition: () => playerGroup.position,
                // Read per frame, so attack mode needs no seeding and cannot go
                // stale across a respawn the way a pushed flag would.
                getHostile: () => useNavRigStore.getState().attackMode,
                // A droplet landed on the player. The damage amount comes from
                // the live tunable rather than being baked in, so the GUI slider
                // means something.
                onPlayerHit: () =>
                    useNavRigStore.getState().damagePlayer(settings.dropletDamage),
                // The player's water, so the crowd can see a shot coming and get
                // out of its way (see `PlayerDroplets` — read-only). `playerCombat`
                // is built above this same effect, so the reference is settled; it
                // is handed over as a getter to match `getHostile` and
                // `getPlayerPosition`.
                getPlayerDroplets: () => playerCombat,
                // lil-gui mutates `settings` in place, so the crowd reads the
                // live values every frame with no wiring.
                tunables: settings,
                // Same contract: the crowd holds `weapon` and reads it per frame.
                weapon,
            })
                .then((created) => {
                    npcsLoading = false
                    if (disposed || generation !== npcsGeneration) {
                        // Torn down (or respawned with a new count) while the
                        // avatars loaded. Drop this crowd — it was built from
                        // superseded settings — and let the respawn that
                        // bumped the generation build the current one.
                        created.dispose()
                        if (!disposed) ensureNpcs()
                        return
                    }
                    npcs = created
                })
                .catch((err) => {
                    npcsLoading = false
                    console.warn('[NavMeshRig] Failed to spawn NPCs:', err)
                })
        }

        /**
         * Tear the crowd down and build it again. Everything a built avatar
         * bakes in — its weapon's url and hand bone, its clip sets — can only be
         * changed this way.
         *
         * The generation bump is what makes it safe: an avatar load already in
         * flight sees the bump and drops itself rather than landing on top of
         * the replacement.
         */
        const respawnNpcs = () => {
            npcsGeneration++
            npcs?.dispose()
            npcs = null
            ensureNpcs()
        }

        // Seed before the first crowd exists — a store subscription only fires
        // on *changes*, so without this an untouched manifest would leave the
        // crowd reading the placeholder above.
        syncWeapon(useAvatarStore.getState().weapons)
        const unsubWeapon = useAvatarStore.subscribe((s, prev) => {
            if (s.weapons === prev.weapons) return
            if (syncWeapon(s.weapons)) respawnNpcs()
        })

        // Attack mode is a nav-rig concern, so it rides its own subscription.
        // Seeded from `getState()` for the same reason as the weapon above — a
        // subscription only fires on changes, and the app starts peaceful.
        applyAttackMode(useNavRigStore.getState().attackMode)
        const unsubAttack = useNavRigStore.subscribe((s, prev) => {
            if (s.attackMode === prev.attackMode) return
            applyAttackMode(s.attackMode)
        })

        // Player health. Seeded for the same reason as the two above — a
        // subscription only fires on changes, so without this the bar would show
        // whatever the healthBar module's own default is until the first hit.
        syncPlayerBar()
        const unsubHp = useNavRigStore.subscribe((s, prev) => {
            if (s.playerHp === prev.playerHp) return
            syncPlayerBar()
            // Only the *crossing* to zero starts the down beat. `damagePlayer`
            // clamps at 0, so a droplet still in the air when the player goes
            // down lands as a no-change and never reaches here — but guarding on
            // `playerDowned` as well means a future change to that clamping
            // cannot restart the timer mid-down.
            if (s.playerHp === 0 && !playerDowned) downPlayer()
        })

        // Generate now; if the collider hasn't synced yet, retry for a while.
        let retries = 0
        if (!generateNavMesh()) {
            retryInterval = window.setInterval(() => {
                if (disposed) return
                if (generateNavMesh()) {
                    placePlayer()
                    window.clearInterval(retryInterval)
                    return
                }
                retries++
                if (retries > 20) {
                    console.warn(
                        "[NavMeshRig] Gave up waiting for a *collider* mesh — use the GUI 'Generate NavMesh' once one is synced.",
                    )
                    window.clearInterval(retryInterval)
                }
            }, 1500)
        } else {
            placePlayer()
        }

        // ------------------------------------------------------------------
        // Input
        // ------------------------------------------------------------------
        const input = {
            forward: false,
            back: false,
            left: false,
            right: false,
            sprint: false,
            jump: false,
        }

        const handleKeyDown = (event: KeyboardEvent) => {
            switch (event.code) {
                // case "ArrowUp":
                case 'KeyW':
                    input.forward = true
                    break
                // case "ArrowDown":
                case 'KeyS':
                    input.back = true
                    break
                // case "ArrowLeft":
                case 'KeyA':
                    input.left = true
                    break
                // case "ArrowRight":
                case 'KeyD':
                    input.right = true
                    break
                case 'ShiftLeft':
                case 'ShiftRight':
                    input.sprint = true
                    break
                case 'KeyX': {
                    // Ignore while typing into the lil-gui — a manifest name field
                    // is a text input, and it would otherwise eat every "x".
                    const el = event.target as HTMLElement | null
                    const tag = el?.tagName ?? ''
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) {
                        break
                    }
                    // One toggle per tap: `event.repeat` skips the OS auto-repeat,
                    // which would otherwise flip the mode dozens of times a second.
                    if (!event.repeat) useNavRigStore.getState().toggleAttackMode()
                    break
                }
                case 'Space': {
                    // Ignore while typing into the lil-gui — don't swallow spaces.
                    const el = event.target as HTMLElement | null
                    const tag = el?.tagName ?? ''
                    if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) {
                        break
                    }
                    // One jump per tap (event.repeat skips the OS auto-repeat) and only
                    // once the navmesh is ready.
                    if (!event.repeat && navMesh) {
                        event.preventDefault() // stop the page from scrolling on Space
                        input.jump = true
                    }
                    break
                }
            }
        }

        const handleKeyUp = (event: KeyboardEvent) => {
            switch (event.code) {
                case 'ArrowUp':
                case 'KeyW':
                    input.forward = false
                    break
                case 'ArrowDown':
                case 'KeyS':
                    input.back = false
                    break
                case 'ArrowLeft':
                case 'KeyA':
                    input.left = false
                    break
                case 'ArrowRight':
                case 'KeyD':
                    input.right = false
                    break
                case 'ShiftLeft':
                case 'ShiftRight':
                    input.sprint = false
                    break
            }
        }

        document.addEventListener('keydown', handleKeyDown)
        document.addEventListener('keyup', handleKeyUp)

        // ------------------------------------------------------------------
        // Click-to-move — click the navmesh and the character walks there
        // ------------------------------------------------------------------
        const targetMarker = new THREE.Mesh(
            new THREE.RingGeometry(0.35, 0.55, 24),
            new THREE.MeshStandardMaterial({
                emissive: 0x81d8d0,
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.9,
            }),
        )
        targetMarker.rotation.x = -Math.PI / 2
        targetMarker.visible = false
        scene.add(targetMarker)

        // Destination the marker lerps toward each frame (so it glides instead of
        // snapping as the pointer re-aims while held).
        const targetPosition = new THREE.Vector3()

        let path: Vec3[] = []
        let pathIndex = 0
        let targetReached = false

        const moveTo = (point: THREE.Vector3) => {
            if (!navMesh) return

            const start: Vec3 = [playerGroup.position.x, playerGroup.position.y, playerGroup.position.z]
            const end: Vec3 = [point.x, point.y, point.z]

            const result = findPath(navMesh, start, end, [2, 2, 2], DEFAULT_QUERY_FILTER)
            if (!result.success || result.path.length === 0) {
                console.log('[NavMeshRig] No path to the clicked point')
                return
            }

            const wasVisible = targetMarker.visible
            targetPosition.set(...result.endPosition)
            targetMarker.visible = true
            // Snap only the first appearance — subsequent updates lerp smoothly.
            if (!wasVisible) targetMarker.position.copy(targetPosition)
            path = result.path.map((p) => p.position.slice() as Vec3)
            pathIndex = 0
            targetReached = false

            // Skip waypoints already underneath the player
            while (pathIndex < path.length - 1) {
                const w = path[pathIndex]
                const d = Math.hypot(w[0] - playerGroup.position.x, w[2] - playerGroup.position.z)
                if (d > 0.35) break
                pathIndex++
            }
        }

        // Dedicated raycaster for pointer-to-move — the height-correction raycaster
        // keeps a short `far` plane that would cull the collider at distance.
        const clickRaycaster = new THREE.Raycaster()

        /** Scratch for the shared pointer-to-NDC conversion. */
        const _pickNdc = new THREE.Vector2()
        /** Scratch for projecting an NPC's chest to screen space. */
        const _pickWorld = new THREE.Vector3()
        /** Scratch for the line-of-sight ray — its origin and unit direction. */
        const _losOrigin = new THREE.Vector3()
        const _losDirection = new THREE.Vector3()

        // Hold-to-move: while the mouse is held, the per-frame loop keeps re-aiming
        // the character at the current pointer position. A quick click sets it once.
        let pointerDown = false
        let pointerX = 0
        let pointerY = 0
        // Throttles the (expensive) findPath recompute inside the frame loop.
        let followAccumulator = 0

        /** Client coordinates to normalised device coordinates, in place. Shared
         *  so the walk target and the shot target can never disagree about where
         *  the pointer is. */
        const pointerNdc = (clientX: number, clientY: number, out: THREE.Vector2) => {
            const rect = gl.domElement.getBoundingClientRect()
            return out.set(
                ((clientX - rect.left) / rect.width) * 2 - 1,
                -((clientY - rect.top) / rect.height) * 2 + 1,
            )
        }

        /**
         * Bring the camera's matrices up to date before projecting or casting.
         *
         * The frame loop writes the camera directly (position + lookAt), so
         * `matrixWorld` lags here — `setFromCamera` would otherwise cast a ray
         * that doesn't match the rendered view, and `project` would place a
         * target somewhere other than where it is drawn.
         */
        const syncCameraMatrices = () => {
            camera.updateMatrixWorld()
            camera.matrixWorldInverse.copy(camera.matrixWorld).invert()
        }

        /** Where the pointer ray meets the walkable collider, or null. */
        const groundPointFromPointer = (clientX: number, clientY: number): THREE.Vector3 | null => {
            if (!navMesh && !generateNavMesh()) return null
            syncCameraMatrices()
            clickRaycaster.setFromCamera(pointerNdc(clientX, clientY, _pickNdc), camera)
            refreshColliderObjects()
            const hits = clickRaycaster.intersectObjects(colliderObjects, false)
            return hits.length > 0 ? hits[0].point : null
        }

        /**
         * The enemy nearest the pointer, within `PICK_RADIUS_PX`, or null.
         *
         * Screen-space projection rather than a raycast, for two reasons. The
         * camera sits *behind* the player, so a ray into the scene strikes the
         * player's own body before it reaches the crowd — and `SkinnedMesh`
         * raycasting is per-vertex CPU skinning, which would mean tens of
         * thousands of vertex transforms per click. Projecting six chest points
         * is O(n) in the crowd size and answers the same question.
         */
        const pickEnemy = (clientX: number, clientY: number): NpcTarget | null => {
            if (!npcs) return null
            const rect = gl.domElement.getBoundingClientRect()
            const px = clientX - rect.left
            const py = clientY - rect.top
            syncCameraMatrices()

            let best: NpcTarget | null = null
            let bestSq = PICK_RADIUS_PX * PICK_RADIUS_PX
            for (const child of npcs.group.children) {
                const target = npcs.targetFromObject(child)
                if (!target) continue
                const aim = target.aimPoint()
                if (!aim) continue
                // `project` mirrors a point through the origin once it is behind
                // the camera, so without this an NPC at the player's back would
                // score as a hit in front of them.
                _pickWorld.copy(aim).project(camera)
                if (_pickWorld.z > 1) continue
                const sx = (_pickWorld.x * 0.5 + 0.5) * rect.width
                const sy = (-_pickWorld.y * 0.5 + 0.5) * rect.height
                const dsq = (sx - px) ** 2 + (sy - py) ** 2
                if (dsq < bestSq) {
                    bestSq = dsq
                    best = target
                }
            }
            return best
        }

        /** Turn the player to face a world point, on the same `atan2(x, z)`
         *  convention the movement loop uses — so the gun, which is calibrated to
         *  the group's forward, points at what was just shot at. The movement
         *  loop only rewrites this while walking, so it holds while standing. */
        const faceTowards = (point: THREE.Vector3) => {
            const dx = point.x - playerGroup.position.x
            const dz = point.z - playerGroup.position.z
            if (dx * dx + dz * dz < 1e-6) return
            playerGroup.rotation.y = Math.atan2(dx, dz)
        }

        /** Is the target close enough to shoot at? Measured player-to-target on
         *  the straight line, which is the distance the droplet has to cover. */
        const inEngageRange = (aim: THREE.Vector3): boolean =>
            playerGroup.position.distanceTo(aim) <= settings.playerFireRange

        /**
         * Is the line from the player's chest to the target's chest clear?
         *
         * Fired once per shot rather than per frame: it is a raycast against the
         * terrain, and its answer is only read at the moment a droplet leaves the
         * muzzle.
         *
         * Both ends sit at `AIM_HEIGHT` — the same chest height the aim points and
         * the pool's hit test use — so the ray is drawn along the line a droplet
         * actually travels. The `LOS_CLEARANCE` shortening is what stops that line
         * from being reported as blocked by the ground the target is standing on:
         * a ray that reaches the target's chest has to arrive *through* the slope
         * it is standing on, and the last stretch of it grazes that slope. The
         * clearance only forgives hits in the final stretch, so a hill genuinely
         * between the two still counts.
         */
        const hasLineOfSight = (aim: THREE.Vector3): boolean => {
            refreshColliderObjects()
            if (colliderObjects.length === 0) return true

            _losOrigin.set(playerGroup.position.x, playerGroup.position.y + AIM_HEIGHT, playerGroup.position.z)
            _losDirection.subVectors(aim, _losOrigin)

            const distance = _losDirection.length()
            if (distance < 1e-4) return true

            _losDirection.divideScalar(distance)

            // Deliberately leaves the raycaster's near/far alone — `setFromCamera`
            // does not restore them, so narrowing this ray and then walking away
            // would have the *walk* ray culled at the shot's range. A whole-length
            // ray needs no far plane anyway: the only question is whether the
            // nearest hit lands short of the target, and terrain beyond it answers
            // that by being further away.
            clickRaycaster.set(_losOrigin, _losDirection)

            const hits = clickRaycaster.intersectObjects(colliderObjects, false)
            if (hits.length === 0) return true

            return hits[0].distance >= distance - LOS_CLEARANCE
        }

        /**
         * Lock onto the enemy under the pointer and open fire. Returns true if
         * there was one.
         *
         * Not a single shot: the lock holds fire until the enemy is down, and both
         * the chest read here and the one the loop re-reads before each shot come
         * off the same live handle — so a moving target is still hit, and a target
         * that goes down mid-burst is what ends the burst.
         *
         * The turn happens here as well as in the loop's `onAim`, so the click
         * reads as "face and shoot" instead of waiting a frame for the loop to
         * swing the character round.
         */
        const lockOntoPickedEnemy = (clientX: number, clientY: number): boolean => {
            // A downed player shoots nothing — and returns false, so a tap while
            // down does not get swallowed from whatever else wants it.
            if (playerDowned) return false
            const target = pickEnemy(clientX, clientY)
            if (!target) return false
            const aim = target.aimPoint()
            if (!aim) return false
            faceTowards(aim)
            playerCombat.lockOn(target)
            return true
        }

        /**
         * The deliberate fire command — the right button.
         *
         * An enemy under the cursor is locked onto and held under fire; empty
         * space is a free-aim shot that splashes where it lands. Distinct from the
         * tap handler below, which only ever shoots enemies: a touch device has no
         * right button, so it needs a way to shoot at all, and giving up "tap the
         * ground to walk there" as well would strand it.
         */
        const handleFireCommand = (clientX: number, clientY: number) => {
            if (!useNavRigStore.getState().attackMode) return
            if (lockOntoPickedEnemy(clientX, clientY)) return

            // Aimed at the ground, so there is nothing to hold fire on. Cleared
            // before the ground test rather than after, so a right-click at the
            // sky — no ground hit at all — still releases whoever was locked: the
            // command was "shoot over there", and the answer is not to keep
            // firing at the enemy already being shot.
            playerCombat.lockOn(null)

            const ground = groundPointFromPointer(clientX, clientY)
            if (ground) {
                faceTowards(ground)
                playerCombat.fireAt(ground)
            }
        }

        const updateTargetFromPointer = () => {
            // Generate on demand if the collider synced after the rig mounted
            if (!navMesh && !generateNavMesh()) return
            syncCameraMatrices()
            clickRaycaster.setFromCamera(pointerNdc(pointerX, pointerY, _pickNdc), camera)
            refreshColliderObjects()
            const hits = clickRaycaster.intersectObjects(colliderObjects, false)

            if (hits.length === 0) return

            moveTo(hits[0].point)
        }

        const handlePointerDown = (event: PointerEvent) => {
            // Left button only. Every other button is inert here: without this
            // guard a right-click on the collider sets a walk target, so the
            // character strolls off the moment the context menu is dismissed.
            if (event.button !== 0) return

            // In attack mode a tap on an enemy locks on and opens fire instead of
            // walking to it. This is the only way a touch device can fire — it has
            // no right button — so it has to pre-empt click-to-move, and only for
            // an actual hit: a tap on bare ground still walks.
            if (useNavRigStore.getState().attackMode) {
                if (lockOntoPickedEnemy(event.clientX, event.clientY)) return
                // Bare ground in attack mode is a walk command, so it is also the
                // signal to stop shooting: walking away from a locked enemy would
                // otherwise leave the gun firing behind the player.
                playerCombat.lockOn(null)
            }

            pointerDown = true
            pointerX = event.clientX
            pointerY = event.clientY
            followAccumulator = 0
            updateTargetFromPointer()
        }

        const handlePointerMove = (event: PointerEvent) => {
            if (!pointerDown) return
            pointerX = event.clientX
            pointerY = event.clientY
        }

        const stopFollowing = (event: PointerEvent) => {
            // A non-left button releasing must not end a left-button hold —
            // otherwise right-clicking mid-walk stops the character.
            if (event.type === 'pointerup' && event.button !== 0) return
            pointerDown = false
        }

        // Right-click never means "show the browser menu" over the scene, so it
        // is suppressed in every mode — and in attack mode it is the fire
        // command. Scoped to the canvas, so right-click still behaves normally
        // everywhere else on the page.
        const suppressContextMenu = (event: MouseEvent) => {
            event.preventDefault()
            handleFireCommand(event.clientX, event.clientY)
        }

        gl.domElement.addEventListener('pointerdown', handlePointerDown)
        document.addEventListener('pointermove', handlePointerMove)
        document.addEventListener('pointerup', stopFollowing)
        document.addEventListener('pointercancel', stopFollowing)
        gl.domElement.addEventListener('contextmenu', suppressContextMenu)

        // ------------------------------------------------------------------
        // GUI
        // ------------------------------------------------------------------
        // `container` mounts the GUI into a DOM element (and skips auto-place);
        // `parent` would be for nesting another GUI and expects a GUI, not a div.
        const gui = new GUI({
            container: guiContainer?.current ?? undefined,
        })
        gui.close()
        gui.domElement.style.top = '50px'
        const navMeshFolder = gui.addFolder('Nav Mesh')
        navMeshFolder.add(settings, 'showNavMeshHelper').name('Show Helper')
        navMeshFolder.add(settings, 'showAgentHelper').name('Show Agent Helper')
        navMeshFolder.add(settings, 'cellSize', 0.05, 0.3, 0.01).name('Cell Size')
        navMeshFolder.add(settings, 'cellHeight', 0.05, 0.3, 0.01).name('Cell Height')
        navMeshFolder.add(settings, 'walkableRadius', 0.1, 1, 0.1).name('Walkable Radius')
        navMeshFolder.add(settings, 'walkableSlopeAngle', 0, 90, 1).name('Walkable Slope Angle')
        navMeshFolder.add(settings, 'walkableClimb', 0.1, 1, 0.1).name('Walkable Climb')
        navMeshFolder.add(settings, 'walkableHeight', 0.1, 3, 0.1).name('Walkable Height')
        navMeshFolder
            .add(
                {
                    generateNavMesh: () => {
                        generateNavMesh()
                        placePlayer()
                    },
                },
                'generateNavMesh',
            )
            .name('Generate NavMesh')

        const playerFolder = gui.addFolder('Player Speed')
        playerFolder.add(settings, 'walkingSpeed', 0.1, 50, 0.1).name('Walking Speed')
        playerFolder.add(settings, 'runningSpeed', 0.1, 50, 0.1).name('Running Speed')

        const cameraFolder = gui.addFolder('Camera')
        cameraFolder.add(settings, 'offsetBehind', 5, 30, 1).name('Offset Behind')
        cameraFolder.add(settings, 'offsetAbove', 2, 15, 1).name('Offset Above')

        const npcFolder = gui.addFolder('NPC Enemies')
        npcFolder.add(settings, 'npcAggroRadius', 2, 40, 1).name('Aggro Radius')
        npcFolder.add(settings, 'npcStandoffDistance', 0.5, 20, 0.5).name('Attack Distance')
        npcFolder.add(settings, 'npcScatterSeconds', 1, 30, 1).name('Wander Re-scatter (s)')
        npcFolder.add(settings, 'npcCount', 0, 12, 1).name('Count (respawning)')
        // Gun placement lives in the sidebar's Weapon Settings tab, on the
        // avatar manifest — it describes the *character*, not the scene, so it
        // is not a nav-rig setting and has no controls here.

        // Armed / peace. Every control here is read straight off `settings` by
        // the crowd's own frame loop (through the `tunables` object it holds a
        // reference to), so — like the sliders above — they are bound in place
        // rather than routed through the store's `set()`, which would swap the
        // settings object out from under that reference.
        const armedFolder = npcFolder.addFolder('Armed States')
        armedFolder.add(settings, 'npcArmedEnabled').name('Armed on Aggro')
        armedFolder.add(settings, 'npcFireInterval', 0.2, 6, 0.1).name('Fire Interval (s)')
        armedFolder.add(settings, 'npcFireRange', 2, 40, 1).name('Fire Range')
        armedFolder.add(settings, 'npcProjectileSpeed', 2, 40, 1).name('Droplet Speed')
        armedFolder.add(settings, 'npcArmedWalkTimescale', 0.2, 6, 0.1).name('Armed Walk Rate')
        armedFolder.add(settings, 'npcArmedRunTimescale', 0.2, 6, 0.1).name('Armed Run Rate')
        armedFolder.close()
        npcFolder.add({ respawn: respawnNpcs }, 'respawn').name('Respawn NPCs')

        const attackFolder = gui.addFolder('Player Attack')
        // The range runs well past the crowd's, because the player's numbers are
        // legitimately larger: the armed pack is authored around 0.61 m/s walking
        // and 2.96 m/s running, so the multiplier is `movementSpeed / authored`
        // — 2.2 / 4.5 gives the crowd ~3.6 / 1.5, but the player moves at 4 / 8.
        // These are the values that stop the feet skating; if they are wrong they
        // are wrong loudly, which is why they are live dials rather than
        // constants.
        const pushPlayerCadence = () =>
            playerCombat.setCadence(settings.playerArmedWalkTimescale, settings.playerArmedRunTimescale)
        attackFolder
            .add(settings, 'playerArmedWalkTimescale', 0.2, 12, 0.1)
            .name('Attack Walk Rate')
            .onChange(pushPlayerCadence)
        attackFolder
            .add(settings, 'playerArmedRunTimescale', 0.2, 12, 0.1)
            .name('Attack Run Rate')
            .onChange(pushPlayerCadence)
        // No `onChange`: both are read live, the interval by the frame loop's
        // `setFireInterval` push and the range inside the engage gate, so a drag
        // takes effect on the next shot either way. The interval's lower bound is
        // above the pool ceiling documented on the tunable, so every setting on
        // the slider actually delivers the rate it says.
        attackFolder.add(settings, 'playerFireInterval', 0.08, 1, 0.01).name('Fire Interval')
        attackFolder.add(settings, 'playerFireRange', 5, 40, 0.5).name('Fire Range')
        attackFolder.close()

        // The jump's force field — the defensive move. Everything the field
        // reaches is thrown outward: the crowd's droplets in flight are turned
        // back, and the NPCs it catches are shoved and left dizzy. No `onChange`
        // handlers, because the crowd reads all three live, so a drag applies to
        // the next jump.
        //
        // The radius is the jump ring's radius too — `LoadCollider` draws the floor
        // pulse to this same number — so dragging it moves the visual and the
        // mechanic together, and the ring cannot claim a reach the field does not
        // have.
        const jumpFolder = gui.addFolder('Jump')
        jumpFolder.add(settings, 'forceFieldRadius', 1, 20, 0.5).name('Field Radius')
        jumpFolder.add(settings, 'forceFieldPush', 0, 10, 0.25).name('Shove Distance')
        jumpFolder.add(settings, 'forceFieldStunSeconds', 0, 5, 0.05).name('Stun (s)')
        jumpFolder.close()

        // The crowd's answer to that, and the only place it can be dialled. An NPC
        // that sees one of the player's droplets closing steps out of its path and
        // weaves — no deflect and no shove, so the sidestep is the whole of it.
        //
        // `Dodges (burst)` and `Cool-off (s)` are a pair, and are the two that
        // matter: an NPC can sidestep up to that many times back to back, and then
        // is genuinely hittable for that many seconds. Read live, like everything
        // else.
        const npcDodgeFolder = gui.addFolder('NPC Dodge')
        npcDodgeFolder.add(settings, 'npcDodgeEnabled').name('Enabled')
        npcDodgeFolder.add(settings, 'npcDodgeReactionRange', 1, 20, 0.5).name('Reaction Range')
        npcDodgeFolder.add(settings, 'npcDodgeDistance', 0, 5, 0.1).name('Step Distance')
        npcDodgeFolder.add(settings, 'npcDodgeRecovery', 0.05, 2, 0.05).name('Recovery (s)')
        npcDodgeFolder.add(settings, 'npcDodgeCharges', 0, 20, 1).name('Dodges (burst)')
        npcDodgeFolder.add(settings, 'npcDodgeRecharge', 0, 10, 0.25).name('Cool-off (s)')
        npcDodgeFolder.close()

        // Health crates. No `onChange` handlers anywhere: the crate pool reads
        // `settings` live on every frame, so a slider takes effect immediately —
        // including the count, which only decides how many pooled meshes are
        // shown. The slider's maximum *is* `CRATE_POOL_SIZE`, so it can never
        // ask for a crate the pool does not have.
        const crateFolder = gui.addFolder('Health Crates')
        crateFolder.add(settings, 'crateCount', 0, CRATE_POOL_SIZE, 1).name('Count')
        crateFolder.add(settings, 'crateHealFraction', 0.1, 1, 0.1).name('Heal Fraction')
        crateFolder.add(settings, 'cratePickupRadius', 0.2, 2, 0.05).name('Pickup Radius')
        crateFolder.add(settings, 'crateRespawnSeconds', 1, 30, 1).name('Respawn Seconds')
        crateFolder.close()

        // ------------------------------------------------------------------
        // Movement / animation / camera scratch state
        // ------------------------------------------------------------------
        const movement = { vector: new THREE.Vector3(), sprinting: false }
        let firstPositionUpdate = true

        // Jump physics — a ballistic vertical arc layered over the navmesh
        // following. `jumpOffset` is stripped from the player's y at the top of
        // every frame (so navmesh queries + ground snaps read ground level) and
        // re-applied at the end of the frame to render the lift. The character
        // therefore keeps walking the navmesh horizontally while airborne.
        const JUMP_GRAVITY = 20 // downward accel on the arc (units/s^2)
        const JUMP_SPEED = 6.9 // takeoff impulse (units/s) → ~1.2u apex, ~0.7s
        // Where in the 1.9s jumping.fbx to start each takeoff — the clip begins
        // with an anticipation crouch, so start at its launch (~0.45s) to match
        // the physical arc. Tune to taste.
        const JUMP_CLIP_START = 0.45
        let isJumping = false
        let jumpOffset = 0 // current lift above the navmesh surface
        let jumpVelocity = 0 // vertical velocity of the jump arc
        // Set while a two-finger pinch is active — pauses player walking and
        // hides the target marker for the duration.
        let isPinching = false
        let targetMarkerWasVisible = false

        // --- one-shot emotions (gesture / dance buttons) -----------------------
        // Requests arrive in the store (navRigStore.emotionRequest); the frame loop
        // consumes each one by nonce and hands the clip to the rig. The character
        // parks in place while `avatarRig.isEmotionActive()` is true, then the rig
        // returns to the caller's blend (idle once the player stops moving).
        let lastEmotionNonce = 0
        const runEmotion = (def: EmotionDef) => {
            // Gestures park in place (clear click-to-move / any jump arc) so the pose
            // is seen; dances deliberately do NOT — the character keeps steering /
            // walking and any click-to-move destination stays active. The rig decides
            // loop-vs-one-shot from `def.dance`.
            if (!def.dance) {
                path.length = 0
                targetReached = false
                targetMarker.visible = false
                isJumping = false
                jumpOffset = 0
                jumpVelocity = 0
            }
            avatarRig?.playEmotionOnce(def)
        }

        // The on-screen button requests one jump per tap via navRigStore (nonce
        // advances on every request); consumed once per nonce in the movement loop,
        // exactly like the Space key.
        let lastJumpNonce = 0

        const movementTarget = new THREE.Vector3()
        const raycasterOrigin = new THREE.Vector3()
        const raycasterDirection = new THREE.Vector3()
        const playerEuler = new THREE.Euler()
        const playerQuaternion = new THREE.Quaternion()
        const cameraPosition = new THREE.Vector3()

        const raycaster = new THREE.Raycaster()
        raycaster.near = 0.01
        raycaster.far = 10

        // Rendered *collider* meshes (from SyncViewer) used for height raycasts.
        // Refreshed periodically — the scene changes as Blender re-syncs.
        const colliderObjects: THREE.Object3D[] = []
        let frameCounter = 0
        const refreshColliderObjects = () => {
            colliderObjects.length = 0
            scene.traverse((obj) => {
                if ((obj as THREE.Mesh).isMesh && obj.name.toLowerCase().includes('collider')) {
                    colliderObjects.push(obj)
                }
            })
        }
        refreshColliderObjects()

        camera.position.set(0, 1.5, 2)
        camera.lookAt(0, 0, 0)
        cameraPosition.copy(camera.position)

        // ------------------------------------------------------------------
        // Wheel / pinch zoom — dollies the camera along the follow axis via the
        // shared rig store. radius > 0 pulls in toward the player, radius < 0
        // pushes out. A single controller writes the camera each frame, so the
        // pose used for raycasting always matches the rendered frame.
        // ------------------------------------------------------------------
        const onWheel = (e: WheelEvent) => {
            e.preventDefault()
            useNavRigStore.getState().dolly(-e.deltaY * 0.015)
        }
        gl.domElement.addEventListener('wheel', onWheel, { passive: false })

        const pinchDist = (t: TouchList) => {
            const a = t[0]
            const b = t[1]
            return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
        }
        let lastPinchDist: number | null = null
        const onTouchStart = (e: TouchEvent) => {
            const nowPinching = e.touches.length === 2
            if (nowPinching && !isPinching) {
                // Pinch started — hide the target marker, restore it on pinch end.
                targetMarkerWasVisible = targetMarker.visible
                targetMarker.visible = false
            }
            isPinching = nowPinching
            if (nowPinching) {
                lastPinchDist = pinchDist(e.touches)
            }
        }
        const onTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2) return
            e.preventDefault()
            isPinching = true
            const d = pinchDist(e.touches)
            if (lastPinchDist != null) {
                useNavRigStore.getState().dolly((d - lastPinchDist) * 0.03)
            }
            lastPinchDist = d
        }
        const onTouchEnd = (e: TouchEvent) => {
            const wasPinching = isPinching
            isPinching = e.touches.length === 2
            if (wasPinching && !isPinching) {
                // Pinch ended — restore the target marker's prior visibility.
                targetMarker.visible = targetMarkerWasVisible
            }
            lastPinchDist = null
        }
        gl.domElement.addEventListener('touchstart', onTouchStart, { passive: true })
        gl.domElement.addEventListener('touchmove', onTouchMove, { passive: false })
        gl.domElement.addEventListener('touchend', onTouchEnd)
        gl.domElement.addEventListener('touchcancel', onTouchEnd)

        // ------------------------------------------------------------------
        // Per-frame update
        // ------------------------------------------------------------------
        const frame = (delta: number, _: any) => {
            const clamped = Math.min(delta, 0.1)

            // Strip any jump lift so every position read below (navmesh queries,
            // ground snaps) sees ground level. The lift is re-applied at the end of
            // the frame so the rendered pose is `surface + jumpOffset`.
            playerGroup.position.y -= jumpOffset

            // Down and waiting to get up. Ahead of the movement below, so the
            // revive lands on this frame rather than the next.
            if (playerDowned) {
                playerRespawnTimer -= clamped
                if (playerRespawnTimer <= 0) revivePlayer()
            }

            // Consume an emotion request (button press) — once per nonce. A dance that
            // is already playing is a toggle: tapping its button again stops it.
            const req = useNavRigStore.getState().emotionRequest
            if (req && avatarRig && req.nonce !== lastEmotionNonce) {
                lastEmotionNonce = req.nonce
                const sameDance =
                    req.def.dance && avatarRig.isEmotionActive() && avatarRig.getEmotionId() === req.def.id
                if (sameDance) {
                    avatarRig.cancelEmotion() // tap the dancing button again → stop
                } else {
                    runEmotion(req.def)
                }
            }
            // While an emotion plays the mixers are its own. A *dance* still lets the
            // character steer/walk (not locked); a *gesture* parks it (feet planted).
            const emotionActive = avatarRig?.isEmotionActive() ?? false
            const emotionDanceActive = emotionActive && (avatarRig?.isEmotionDance() ?? false)
            // A *reflex* one-shot — the firing recoil — is not the player's choice
            // of pose, so it does not get to pin them down. Everything the other
            // emotions own (the body, the mixers) it still owns, so this is not a
            // free pass: it says the character may keep moving and jumping, and
            // the two places that act on it below hand the body back to whatever
            // the player is doing — see `isReflexEmotion`.
            const emotionReflex = emotionActive && isReflexEmotion(avatarRig?.getEmotionId() ?? null)

            // Hold-to-move: while the mouse is held, keep re-aiming the target from
            // the current pointer position (throttled to ~150ms — findPath is costly).
            if (pointerDown) {
                followAccumulator += clamped
                if (followAccumulator >= 0.0) {
                    followAccumulator = 0
                    updateTargetFromPointer()
                }
            }

            // Glide the target marker toward the latest destination.
            if (targetMarker.visible) {
                targetMarker.position.lerp(targetPosition, 0.2)
            }

            // --- movement ---
            if (navMesh) {
                const { left, right, forward, back, sprint } = input
                const anyKey = forward || back || left || right
                // On-screen joystick (bottom centre) — analog deflection feeds the same
                // camera-relative steering as WASD. y > 0 = up = forward.
                const stick = useNavRigStore.getState().stick
                const stickActive = Math.hypot(stick.x, stick.y) > 0.12
                const anySteer = anyKey || stickActive
                // Run when Shift is held OR the bottom-left Walk/Run toggle is on.
                const runActive = sprint || useNavRigStore.getState().running

                // Manual input (keys or joystick) cancels click-to-move
                if (anySteer && path.length > 0) {
                    path.length = 0
                    targetReached = false
                    targetMarker.visible = false
                }

                // Jump on Space press or the on-screen button — one impulse per tap,
                // only while grounded and not mid-emotion (a gesture owns the mixers,
                // so no jumping on top).
                const jumpRequest = useNavRigStore.getState().jumpRequest
                const buttonJump = !!jumpRequest && jumpRequest.nonce !== lastJumpNonce
                if (jumpRequest && jumpRequest.nonce !== lastJumpNonce) {
                    lastJumpNonce = jumpRequest.nonce
                }
                const jumpFromSpace = input.jump
                if (jumpFromSpace || buttonJump) {
                    input.jump = false
                    // A reflex one-shot does not lock the player out of jumping.
                    // The firing recoil is re-triggered on every shot, so during
                    // sustained fire `emotionActive` is true almost continuously —
                    // gating on it alone is what made the player unable to jump at
                    // all while shooting. A gesture or a dance still holds the
                    // character: those are the player's own choice of what to do
                    // with the body, not a side effect of firing a gun.
                    if (!isJumping && (!emotionActive || emotionReflex)) {
                        isJumping = true
                        jumpVelocity = JUMP_SPEED
                        // The jump takes the body back from the recoil, and has to
                        // do it explicitly: while an emotion is active the rig
                        // asserts it at full weight and every locomotion action at
                        // zero, so without this the jump would be a silent lift of
                        // the whole group with the pose still firing the gun.
                        if (emotionReflex) avatarRig?.cancelEmotion()
                        // Restart the jump clip at its launch frame (skipping the
                        // anticipation crouch so the pose matches the takeoff).
                        avatarRig?.startJumpAt(JUMP_CLIP_START)
                        // The force field, in attack mode only: it is the counter
                        // to the crowd's fire, so a peaceful jump stays a peaceful
                        // jump and a wandering NPC is never shoved. `npcs` is
                        // nullable — the crowd builds asynchronously — so a jump
                        // before it exists is a no-op rather than a crash.
                        //
                        // Anchored at the player's feet, which is what
                        // `playerGroup.position` holds here: the jump lift is added
                        // later in the frame, and the field is a ground effect.
                        //
                        // Runs before `npcs?.update` below, so the shove, the stun
                        // and the turned droplets all land on this frame.
                        if (useNavRigStore.getState().attackMode) {
                            npcs?.forceField(playerGroup.position)
                        }
                        // Space never touches the navRig store (the on-screen button
                        // does), so broadcast a jump nonce here too — the floor pulse
                        // in LoadCollider keys off the store and plays once per jump.
                        if (jumpFromSpace && !buttonJump) {
                            useNavRigStore.getState().requestJump()
                        }
                    }
                }

                movement.vector.set(0, 0, 0)

                // Pause walking while pinch-zooming, during a one-shot *gesture*
                // (a looping dance never locks the character in place), or while
                // downed. `playerDowned` is the one lever for all three movement
                // sources — WASD, the joystick and click-to-move path following
                // are each gated on this below.
                //
                // `emotionReflex` joins the dance here for the same reason it is
                // let through the jump above: firing is not a reason to stop
                // walking. Together with the cancel at the blend below, this is
                // what lets the player advance while shooting.
                const canMove =
                    !playerDowned && !isPinching && (!emotionActive || emotionDanceActive || emotionReflex)
                if (canMove && anySteer) {
                    if (forward) movement.vector.z -= 1
                    if (back) movement.vector.z += 1
                    if (left) movement.vector.x -= 1
                    if (right) movement.vector.x += 1
                    // Analog stick axes (dead-zoned above). up → forward, right → right.
                    if (stickActive) {
                        movement.vector.x += stick.x
                        movement.vector.z -= stick.y
                    }
                    const scalar = runActive ? settings.runningSpeed : settings.walkingSpeed

                    movement.vector.applyAxisAngle(new Vector3(0, 1, 0), playerGroup.userData.spherical.theta)

                    movement.vector.normalize().multiplyScalar(scalar * clamped)
                } else if (canMove && !targetReached && path.length > 0) {
                    // Steer toward the current path waypoint
                    const w = path[pathIndex]
                    const dx = w[0] - playerGroup.position.x
                    const dz = w[2] - playerGroup.position.z
                    const dist = Math.hypot(dx, dz)

                    movement.vector.set(dx, 0, dz)
                    const scalar = runActive ? settings.runningSpeed : settings.walkingSpeed
                    movement.vector.normalize().multiplyScalar(scalar * clamped)

                    if (dist < 0.35) {
                        if (pathIndex < path.length - 1) {
                            pathIndex++
                        } else {
                            targetReached = true
                            targetMarker.visible = false
                        }
                    }
                }

                if (movement.vector.length() > 0 || firstPositionUpdate) {
                    movementTarget.copy(playerGroup.position).add(movement.vector)

                    const nearestResult = findNearestPoly(
                        createFindNearestPolyResult(),
                        navMesh,
                        [playerGroup.position.x, playerGroup.position.y, playerGroup.position.z],
                        [1, 1, 1],
                        DEFAULT_QUERY_FILTER,
                    )

                    if (nearestResult.success) {
                        const moveResult = moveAlongSurface(
                            navMesh,
                            nearestResult.nodeRef,
                            [playerGroup.position.x, playerGroup.position.y, playerGroup.position.z],
                            [movementTarget.x, movementTarget.y, movementTarget.z],
                            DEFAULT_QUERY_FILTER,
                        )
                        if (moveResult.success && moveResult.position) {
                            playerGroup.position.fromArray(moveResult.position)
                        }
                    }
                    firstPositionUpdate = false
                }
                movement.sprinting = runActive
            }

            // --- animation ---
            const t = 1.0 - 0.01 ** clamped

            if (movement.vector.length() > 0) {
                const rotation = Math.atan2(movement.vector.x, movement.vector.z)
                const targetQuaternion = playerQuaternion.setFromEuler(playerEuler.set(0, rotation, 0))
                playerGroup.quaternion.slerp(targetQuaternion, t * 5)
            }

            const speed = movement.vector.length()
            // Movement takes the body back from a reflex clip, exactly as the jump
            // does. Letting the character move is only half of it: while an emotion
            // is active the rig asserts it at full weight and every locomotion
            // action at zero, so a recoil still playing would hold the firing pose
            // across the ground and the walk would only appear once the clip ran
            // out — a slide, then a walk. Cancelling the moment they set off gives
            // the locomotion blend the body on this same frame, and the recoil gate
            // below keeps the next shot from handing it back a tenth of a second
            // later.
            if (emotionReflex && speed > 0.01) avatarRig?.cancelEmotion()
            let idleWeight: number
            let walkWeight: number
            let runWeight: number
            let jumpWeight: number
            if (isJumping) {
                // Play the jump clip for the whole airborne arc.
                idleWeight = 0
                walkWeight = 0
                runWeight = 0
                jumpWeight = 1
            } else if (speed < 0.01) {
                idleWeight = 1
                walkWeight = 0
                runWeight = 0
                jumpWeight = 0
            } else if (movement.sprinting) {
                idleWeight = 0
                walkWeight = 0
                runWeight = 1
                jumpWeight = 0
            } else {
                idleWeight = 0
                walkWeight = 1
                runWeight = 0
                jumpWeight = 0
            }
            // Note: while a one-shot emotion plays, AvatarRig.advance() asserts the
            // emotion at full weight and every locomotion action at 0 itself — it
            // ignores these targets until the clip finishes and idle resumes.
            // Crossfade the composed avatar's clips toward these targets (body + head
            // mixers) — same lerp rate the old single-mixer engine used.
            avatarRig?.blend({ idle: idleWeight, walk: walkWeight, run: runWeight, jump: jumpWeight }, t * 5)

            // Height correction against the rendered collider meshes
            frameCounter++
            if (frameCounter % 45 === 0) refreshColliderObjects()
            // Skip the ground snap while airborne — otherwise it pulls the player
            // back to the surface before the jump lift has a chance to render.
            if (navMesh && !isJumping && colliderObjects.length > 0) {
                const origin = raycasterOrigin.copy(playerGroup.position)
                origin.y += 1
                raycaster.set(origin, raycasterDirection.set(0, -1, 0))
                const hits = raycaster.intersectObjects(colliderObjects, false)
                const hit = hits.sort((a, b) => a.distance - b.distance)[0]
                if (hit) {
                    const yDiff = Math.abs(hit.point.y - playerGroup.position.y)
                    if (yDiff < 1) playerGroup.position.y = hit.point.y
                }
            }

            // --- jump (space) ---
            // Integrate the ballistic arc and re-apply the lift that was stripped at
            // the top of this frame, so the rendered y is `surface + jumpOffset`.
            if (isJumping) {
                jumpVelocity -= JUMP_GRAVITY * clamped
                jumpOffset += jumpVelocity * clamped
                // Landed — clear the arc and settle flush on the surface again.
                if (jumpOffset <= 0) {
                    jumpOffset = 0
                    jumpVelocity = 0
                    isJumping = false
                }
            }
            playerGroup.position.y += jumpOffset

            // --- camera follow ---
            // Baseline follow offset (above/behind from the GUI), dollied along its
            // own axis by the wheel / pinch zoom radius. This is the only controller
            // writing the camera, so its pose is what every raycast must match.
            // const offsetVector = cameraOffset.set(
            //   0,
            //   settings.offsetAbove,
            //   settings.offsetBehind,
            // );
            // const baseOffsetLen = offsetVector.length();
            // const dollyDist = THREE.MathUtils.clamp(
            //   baseOffsetLen - useNavRigStore.getState().zoomRadius,
            //   MIN_CAMERA_DISTANCE,
            //   MAX_CAMERA_DISTANCE,
            // );
            // offsetVector.normalize().multiplyScalar(dollyDist);

            // const target = cameraPositionTarget
            //   .copy(playerGroup.position)
            //   .add(offsetVector);
            // cameraPosition.lerp(target, t / 1.1);
            // camera.position.copy(cameraPosition);
            // camera.lookAt(cameraLookAt.copy(cameraPosition).sub(offsetVector));

            //

            // --- avatar + helpers ---
            avatarRig?.advance(clamped)

            // --- player combat ---
            // Strictly after `advance`, which is what poses the skeleton: the
            // gun's aim is re-solved from the bones, so running it first would
            // align the barrel against last frame's pose.
            //
            // The cadence is pushed rather than captured, exactly as the gun
            // tuning is: `settings` is mutated in place by lil-gui, so dragging
            // the fire-interval slider has to land on the next shot with no
            // rebuild and no stale copy to go out of step.
            playerCombat.setFireInterval(settings.playerFireInterval)
            // Whatever else the character is doing owns the body: the recoil clip
            // is held back while airborne and while walking, because the next shot
            // — at most a tenth of a second later — would otherwise take the mixers
            // straight back off the jump or the walk, and the character would fly
            // through the air, or advance across the ground, miming a recoil.
            //
            // So the kick shows when the player is standing still and firing, which
            // is where a recoil reads anyway. The gun itself is unaffected: the
            // droplet, the damage, the cadence and the aim all carry on regardless
            // — this holds back an animation, not a shot.
            playerCombat.setRecoilEnabled(!isJumping && speed <= 0.01)
            playerCombat.update(clamped)

            if (navMeshHelper?.object) {
                navMeshHelper.object.visible = settings.showNavMeshHelper
            }
            agentHelper.visible = settings.showAgentHelper

            // --- NPC enemies ---
            // Stepped after the player has moved, so a chase re-aim this frame
            // aims at where the player actually is rather than last frame's
            // position.
            npcs?.update(clamped)

            // --- Health crates ---
            // After the player has moved, so a crate triggers on where they
            // actually are. The pickup test is horizontal, so the jump lift
            // re-applied above is irrelevant to it either way.
            crates?.update(clamped)
        }

        frameRef.current = { frame }

        // ------------------------------------------------------------------
        // Cleanup
        // ------------------------------------------------------------------
        return () => {
            disposed = true
            window.clearInterval(retryInterval)
            frameRef.current = { frame: () => {} }

            document.removeEventListener('keydown', handleKeyDown)
            document.removeEventListener('keyup', handleKeyUp)
            pointerDown = false
            gl.domElement.removeEventListener('pointerdown', handlePointerDown)
            gl.domElement.removeEventListener('wheel', onWheel)
            gl.domElement.removeEventListener('touchstart', onTouchStart)
            gl.domElement.removeEventListener('touchmove', onTouchMove)
            gl.domElement.removeEventListener('touchend', onTouchEnd)
            gl.domElement.removeEventListener('touchcancel', onTouchEnd)
            document.removeEventListener('pointermove', handlePointerMove)
            document.removeEventListener('pointerup', stopFollowing)
            document.removeEventListener('pointercancel', stopFollowing)
            gl.domElement.removeEventListener('contextmenu', suppressContextMenu)
            gui.destroy()

            if (navMeshHelper?.object) {
                scene.remove(navMeshHelper.object)
                disposeObject(navMeshHelper.object)
            }
            // Removes its own group from the scene and disposes the avatars'
            // GPU resources. `disposed` is already true above, so a crowd still
            // loading will tear its partial result down instead of attaching.
            npcs?.dispose()
            npcs = null
            // Removes its own group from the scene (the rig does not sweep it)
            // and releases the one geometry / material / texture the whole pool
            // shares.
            crates?.dispose()
            crates = null
            scene.remove(playerGroup)
            scene.remove(targetMarker)
            targetMarker.geometry.dispose()
            targetMarker.material.dispose()
            unsubAvatar()
            unsubWeapon()
            unsubAttack()
            unsubHp()
            // Before the rig is torn down, for the reason in `disposeRig`: this
            // detaches the gun and frees only what the gun owns, so
            // `disposeObject` below cannot reach the textures it shares with the
            // module-cached template and the crowd.
            playerCombat.dispose()
            // Owns a material and a canvas texture of its own, and a Sprite is
            // not a mesh, so the rig teardown below would walk straight past it.
            playerBar.dispose()
            playerGroup.remove(playerBar.sprite)
            if (avatarRig) {
                avatarRig.dispose()
                disposeObject(avatarRig.scene)
            }
            agentHelper.geometry.dispose()
            agentHelper.material.dispose()
        }
    }, [scene, camera, gl])

    useFrame((_, delta) => {
        frameRef.current.frame(delta, _)
    })

    return (
        <>
            {player && <ImmersiveControls player={player}></ImmersiveControls>}
            {/* <ZoomControls></ZoomControls> */}
        </>
    )
}
