import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three/webgpu'
import type { BlenderObject } from '../types/blenderTypes'
import { float, texture, time, uv, vec2, vec4 } from 'three/tsl'

// ---------------------------------------------------------------------------
// LoadCurve — reconstructs Blender CURVE objects.
//
// The Blender plugin samples each curve's splines into dense local-space
// points (`sampledPoints`) and also exports the original control points
// (`controlPoints`). Each spline is refit as a CatmullRomCurve3 built from
// `sampledPoints` (centripetal parametrisation), then tessellated into a
// THREE.Mesh via TubeGeometry — mirroring the standard Three.js recipe:
//
//   const curve = new THREE.CatmullRomCurve3(vecs, closed, "centripetal", 1.0);
//   const pts = curve.getPoints(50);
//   const geometry = new THREE.BufferGeometry().setFromPoints(pts);
//   const material = new THREE.LineBasicMaterial({ color: 0xff0000 });
//   const curveObject = new THREE.Line(geometry, material);
//
// Curves are grouped under an object-named THREE.Group carrying the object's
// position / quaternion / scale (same convention as useMeshSync).
// ---------------------------------------------------------------------------

// Subdivision count for getPoints() — the recipe uses 50; scale up for longer
// splines so they stay smooth.
function subdivisionsFor(count: number): number {
    return Math.max(500, count * 2)
}

interface CurveEntry {
    group: THREE.Group
    version: string
    geometries: THREE.BufferGeometry[]
}

/** Fallback signature when the Blender plugin doesn't send curveVersion yet. */
function computeCurveSignature(obj: BlenderObject): string {
    return JSON.stringify([
        obj.sampledPoints ?? [],
        obj.controlPoints ?? [],
        obj.curveClosed ?? [],
        obj.bevelDepth ?? 0,
    ])
}

const texArrow = new THREE.TextureLoader().load(`/texture/arrows@1x.png`)
texArrow.generateMipmaps = false
texArrow.colorSpace = THREE.SRGBColorSpace
texArrow.wrapS = texArrow.wrapT = THREE.RepeatWrapping
const colorNode = texture(
    texArrow,
    uv()
        .mul(vec2(-20.0, 1.0))
        .add(vec2(time.mul(0.5), 0)),
)

// Shared red material — matches the reference recipe. Module-level so all
// curve lines share one program (never disposed per entry).
// const LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0xff0000 });
const MESH_MATERAIL = new THREE.MeshStandardNodeMaterial({
    colorNode: vec4(colorNode.rgb, colorNode.r),
    emissiveNode: vec4(0.25, 0.25, 0.25, colorNode.r),
    transparent: true,
})

function buildCurveEntry(obj: BlenderObject): CurveEntry {
    const group = new THREE.Group()
    group.name = obj.name

    const geometries: THREE.BufferGeometry[] = []

    ;(obj.sampledPoints ?? []).forEach((points, i) => {
        if (!points || points.length < 2) return // CatmullRomCurve3 needs ≥ 2 points

        const vecs = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
        const closed = obj.curveClosed?.[i] ?? false

        const curve = new THREE.CatmullRomCurve3(vecs, closed, 'catmullrom', 0.0)

        const tube = 2
        const geometry2 = new THREE.TubeGeometry(curve, subdivisionsFor(vecs.length), tube, 32, closed)

        const line = new THREE.Mesh(geometry2, MESH_MATERAIL)
        line.scale.y = 0.05

        // line.name = `${obj.name}`

        group.add(line)
        geometries.push(geometry2)
    })

    // Object transform — local-space points + object transform, same convention
    // as useMeshSync applies to meshes.
    group.position.set(obj.position[0], obj.position[1], obj.position[2])
    group.quaternion.set(obj.quaternion[0], obj.quaternion[1], obj.quaternion[2], obj.quaternion[3])
    group.scale.set(obj.scale[0], obj.scale[1], obj.scale[2])

    return {
        group,
        version: obj.curveVersion ?? computeCurveSignature(obj),
        geometries,
    }
}

export function LoadCurve({ objects = [] }: { objects?: BlenderObject[] }) {
    const scene = useThree((s) => s.scene)
    const cacheRef = useRef<Map<string, CurveEntry>>(new Map())

    useEffect(() => {
        if (!scene) return
        const cache = cacheRef.current
        const incoming = new Set<string>()

        for (const obj of objects) {
            if (obj.objectType !== 'CURVE') continue
            if (!obj.sampledPoints || obj.sampledPoints.length === 0) continue
            incoming.add(obj.name)

            const sig = obj.curveVersion ?? computeCurveSignature(obj)
            const existing = cache.get(obj.name)

            if (existing && existing.version === sig) {
                // Unchanged — cheap transform sync only (objects re-created every 5 Hz).
                existing.group.position.set(obj.position[0], obj.position[1], obj.position[2])
                existing.group.quaternion.set(
                    obj.quaternion[0],
                    obj.quaternion[1],
                    obj.quaternion[2],
                    obj.quaternion[3],
                )
                existing.group.scale.set(obj.scale[0], obj.scale[1], obj.scale[2])
                continue
            }

            if (existing) {
                scene.remove(existing.group)
                for (const g of existing.geometries) g.dispose()
                cache.delete(obj.name)
            }

            const entry = buildCurveEntry(obj)
            if (entry.group.children.length > 0) {
                scene.add(entry.group)
                cache.set(obj.name, entry)
            }
        }

        // Cleanup: drop curves that left the Blender scene.
        for (const [name, entry] of cache) {
            if (!incoming.has(name)) {
                scene.remove(entry.group)
                for (const g of entry.geometries) g.dispose()
                cache.delete(name)
            }
        }
    }, [scene, objects])

    // Dispose everything on unmount.
    useEffect(() => {
        const cache = cacheRef.current
        return () => {
            for (const entry of cache.values()) {
                scene?.remove(entry.group)
                for (const g of entry.geometries) g.dispose()
            }
            cache.clear()
        }
    }, [scene])

    return null
}
