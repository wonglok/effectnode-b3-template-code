import * as THREE from "three";
import { useBlenderStore } from "../b3/b3-runtime/src";

/**
 * Build world-space THREE.Mesh objects from the Blender-synced scene
 * (geometry + per-object transforms). These are the walkable collider
 * surfaces fed into the navmesh.
 *
 * Called imperatively at navmesh-generation time, so it always reads the
 * latest store state — safe to keep as a stable function reference.
 */
export function buildWalkableMeshesFromStore(): THREE.Mesh[] {
  const { sceneData, geoBuffers } = useBlenderStore.getState();
  const meshes: THREE.Mesh[] = [];

  for (const obj of sceneData.objects) {
    // Only meshes named *collider* are treated as walkable navmesh surfaces.
    if (!obj.name.toLowerCase().includes("collider")) continue;
    const buf = geoBuffers.get(obj.name);
    if (!buf || !buf.vertices || !buf.indices) continue;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(buf.vertices, 3),
    );
    geometry.setIndex(new THREE.BufferAttribute(buf.indices, 1));

    const mesh = new THREE.Mesh(geometry);
    mesh.position.fromArray(obj.position);
    mesh.quaternion.fromArray(obj.quaternion);
    mesh.scale.fromArray(obj.scale);
    mesh.updateMatrix();
    mesh.userData.walkable = true;

    meshes.push(mesh);
  }

  return meshes;
}
