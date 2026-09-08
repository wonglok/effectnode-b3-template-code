// ---------------------------------------------------------------------------
// Blender-sync exclusions
// ---------------------------------------------------------------------------
// Names of Blender objects whose MATERIAL is owned by a three.js component and
// must never be replaced by the generic Blender material sync (useMeshSync).
//
// For an object on this list the sync still:
//   - creates / updates the mesh geometry
//   - updates the mesh transform every Blender push
//   - rebuilds the mesh when Blender bumps its version
// but it NEVER assigns the generic synced material, and it keeps the object out
// of InstancedMesh batching so it stays findable by `scene.getObjectByName`.
//
// The matching component (e.g. LoadCollider's custom node shader for
// 'collider') owns the material instead — add the object name here and it will
// stop being clobbered on every Blender edit/sync.
export const SYNC_SKIP_MATERIAL_OBJECTS: readonly string[] = [
    // The collider floor uses a hand-written TSL shader in LoadCollider.tsx —
    // don't let the synced Blender material overwrite it.
    'collider',
]
