"use client";

import { useRef, useEffect } from "react";
import * as THREE from "three";
import type { BlenderObject } from "../../types/blenderTypes";

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * Manages Three.js transform nodes for Blender EMPTY objects.
 *
 * Blender sends every visible scene object — including empties — as
 * transform-only entries (`objectType: "EMPTY"`) with no geometry. This hook
 * creates a named `THREE.Object3D` per empty, keeps its transform in sync with
 * Blender, and removes it when the object leaves the scene.
 *
 * The node keeps the Blender object's name so it can be found via
 * `scene.getObjectByName(...)` and used as a parent / locator / rig target —
 * the same role an empty plays in Blender. Meshes are handled by
 * `useMeshSync`, lights by `LightFromData`, cameras by `CameraSync`.
 */
export function useEmptySync({
  scene,
  objects,
}: {
  scene: THREE.Scene;
  objects: BlenderObject[];
}) {
  const emptiesRef = useRef<Map<string, THREE.Object3D>>(new Map());

  useEffect(() => {
    if (!scene) return;

    const empties = emptiesRef.current;
    const incomingNames = new Set<string>();

    for (const obj of objects) {
      if (obj.objectType !== "EMPTY") continue;
      incomingNames.add(obj.name);

      let empty = empties.get(obj.name);
      if (!empty) {
        empty = new THREE.Object3D();
        empty.name = obj.name;
        scene.add(empty);
        empties.set(obj.name, empty);
      }

      // Set the transform directly (avoids allocating objects each sync run)
      empty.position.set(obj.position[0], obj.position[1], obj.position[2]);
      empty.quaternion.set(
        obj.quaternion[0],
        obj.quaternion[1],
        obj.quaternion[2],
        obj.quaternion[3],
      );
      empty.scale.set(obj.scale[0], obj.scale[1], obj.scale[2]);
    }

    // ---- Cleanup: drop empties that no longer exist in Blender ----
    for (const [name, empty] of empties) {
      if (!incomingNames.has(name)) {
        scene.remove(empty);
        empties.delete(name);
      }
    }
  }, [scene, objects]);
}
