"use client";

import { useRef, useEffect } from "react";
import * as THREE from "three";
import type { BlenderObject } from "../../types/blenderTypes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CachedMesh {
  mesh: THREE.Mesh;
  version: string;
}

interface InstanceSlot {
  mesh: THREE.InstancedMesh;
  index: number;
}

export interface InstancedGroupEntry {
  mesh: THREE.InstancedMesh;
  names: Set<string>;
}

/** Shallow set equality check. */
function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

/** Resolved texture map for a single object. */
export interface ResolvedTextures {
  map: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
}

/** Result of building geometry + material for a group of identical objects. */
export interface BuiltGeometryMaterial {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
}

export interface MeshSyncOptions {
  scene: THREE.Scene;
  objects: BlenderObject[];
  /** Resolve all texture references for a single object.
   *  Return null for any texture that doesn't exist. */
  resolveTextures: (obj: BlenderObject) => ResolvedTextures;
  /** Compute a unique cache key that identifies the geometry + material
   *  combination. Used for grouping objects into InstancedMesh batches
   *  and for cache invalidation. */
  computeCacheKey: (obj: BlenderObject, textures: ResolvedTextures) => string;
  /** Build geometry + material for a group of objects sharing the same
   *  cache key. Called once per unique group. Return null to skip the
   *  object (e.g. when geometry data isn't available yet). */
  buildGeometryMaterial: (
    obj: BlenderObject,
    textures: ResolvedTextures,
  ) => BuiltGeometryMaterial | null;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages Three.js meshes in a scene — creates, updates, batches (InstancedMesh),
 * and cleans up — driven by a reactive list of {@link BlenderObject}.
 *
 * Shared between {@link SyncViewer} (live Blender data) and
 * {@link ProductionViewer} (static zip export).
 */
export function useMeshSync({
  scene,
  objects,
  resolveTextures,
  computeCacheKey,
  buildGeometryMaterial,
}: MeshSyncOptions) {
  const meshesRef = useRef<Map<string, CachedMesh>>(new Map());
  const instancedRef = useRef<Map<string, InstancedGroupEntry>>(new Map());
  const slotsRef = useRef<Map<string, InstanceSlot>>(new Map());

  // Cache of built geometry+material, keyed by cacheKey.
  // Persists across sync runs to avoid rebuilding identical groups.
  const geoMatCache = useRef<Map<string, BuiltGeometryMaterial>>(new Map());

  useEffect(() => {
    if (!scene) return;

    const meshes = meshesRef.current;
    const instanced = instancedRef.current;
    const slots = slotsRef.current;
    const incomingNames = new Set<string>();

    // ---- Phase 0: resolve textures & compute cache keys ----

    interface Resolved {
      obj: BlenderObject;
      cacheKey: string;
      textures: ResolvedTextures;
    }

    const resolved: Resolved[] = [];

    for (const obj of objects) {
      const textures = resolveTextures(obj);
      const cacheKey = computeCacheKey(obj, textures);
      resolved.push({ obj, cacheKey, textures });
    }

    // ---- Phase 1: group by cache key ----

    const groups = new Map<string, Resolved[]>();
    for (const r of resolved) {
      if (!groups.has(r.cacheKey)) groups.set(r.cacheKey, []);
      groups.get(r.cacheKey)!.push(r);
    }

    // ---- Phase 2: build / update meshes per group ----

    for (const [cacheKey, items] of groups) {
      for (const item of items) incomingNames.add(item.obj.name);

      if (items.length > 1) {
        // ================================================================
        // INSTANCED path — N objects share the same geometry + material
        // ================================================================
        const first = items[0];

        const currentNames = new Set(items.map((it) => it.obj.name));
        let entry = instanced.get(cacheKey);

        // Rebuild if membership changed or doesn't exist yet
        const needsRebuild =
          !entry ||
          entry.mesh.count !== items.length ||
          !setsEqual(entry.names, currentNames);

        if (needsRebuild) {
          // Remove old instanced mesh
          if (entry) {
            for (const n of entry.names) slots.delete(n);
            scene.remove(entry.mesh);
          }

          // Build geometry + material (once for the group)
          let geoMat = geoMatCache.current.get(cacheKey);
          if (!geoMat) {
            const built = buildGeometryMaterial(first.obj, first.textures);
            if (!built) continue;
            geoMat = built;
            geoMatCache.current.set(cacheKey, geoMat);
          }

          const im = new THREE.InstancedMesh(
            geoMat.geometry,
            geoMat.material,
            items.length,
          );
          im.castShadow = true;
          im.receiveShadow = true;
          scene.add(im);

          entry = { mesh: im, names: currentNames };
          instanced.set(cacheKey, entry);
        }

        // Track slots & set instance matrices directly
        items.forEach((item, i) => {
          const name = item.obj.name;
          const matrix = new THREE.Matrix4().compose(
            new THREE.Vector3(
              item.obj.position[0],
              item.obj.position[1],
              item.obj.position[2],
            ),
            new THREE.Quaternion(
              item.obj.quaternion[0],
              item.obj.quaternion[1],
              item.obj.quaternion[2],
              item.obj.quaternion[3],
            ),
            new THREE.Vector3(
              item.obj.scale[0],
              item.obj.scale[1],
              item.obj.scale[2],
            ),
          );

          slots.set(name, { mesh: entry!.mesh, index: i });
          entry!.mesh.setMatrixAt(i, matrix);
        });

        if (entry) entry.mesh.instanceMatrix.needsUpdate = true;

        // Ensure there's no stale regular mesh for any of these objects
        if (entry) {
          for (const item of items) {
            const old = meshes.get(item.obj.name);
            if (old) {
              scene.remove(old.mesh);
              meshes.delete(item.obj.name);
            }
          }
        }
      } else {
        // ================================================================
        // SINGLE-INSTANCE path — regular Mesh
        // ================================================================
        const { obj, cacheKey, textures } = items[0];

        // Remove from any previous instanced group
        const slot = slots.get(obj.name);
        if (slot) {
          slots.delete(obj.name);
        }

        let cached = meshes.get(obj.name);

        if (!cached || cached.version !== cacheKey) {
          if (cached) {
            scene.remove(cached.mesh);
            cached = undefined;
          }

          let geoMat = geoMatCache.current.get(cacheKey);
          if (!geoMat) {
            const built = buildGeometryMaterial(obj, textures);
            if (!built) {
              // Geometry data not ready yet — skip this object
              continue;
            }
            geoMat = built;
            geoMatCache.current.set(cacheKey, geoMat);
          }

          const mesh = new THREE.Mesh(geoMat.geometry, geoMat.material);
          mesh.name = obj.name;
          mesh.castShadow = true;
          mesh.receiveShadow = true;
          scene.add(mesh);

          cached = { mesh, version: cacheKey };
          meshes.set(obj.name, cached);
        }

        // Set transform directly (avoids creating new objects each frame)
        if (cached) {
          cached.mesh.position.set(
            obj.position[0],
            obj.position[1],
            obj.position[2],
          );
          cached.mesh.quaternion.set(
            obj.quaternion[0],
            obj.quaternion[1],
            obj.quaternion[2],
            obj.quaternion[3],
          );
          cached.mesh.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
        }
      }
    }

    // ---- Phase 3: cleanup ----

    // Remove stale regular meshes
    for (const [name, entry] of meshes) {
      if (!incomingNames.has(name)) {
        scene.remove(entry.mesh);
        meshes.delete(name);
      }
    }

    // Remove stale instanced groups
    for (const [cacheKey, entry] of instanced) {
      if (!groups.has(cacheKey)) {
        for (const n of entry.names) slots.delete(n);
        scene.remove(entry.mesh);
        instanced.delete(cacheKey);
      }
    }

    // Remove stale slots (objects that moved from instanced → single or removed)
    for (const [name] of slots) {
      if (!incomingNames.has(name)) {
        slots.delete(name);
      }
    }
  }, [scene, objects, resolveTextures, computeCacheKey, buildGeometryMaterial]);
}
