import { useThree } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three/webgpu'
import { NURBSCurve } from 'three/addons/curves/NURBSCurve.js'
import type { BlenderObject } from '../types/blenderTypes'
import { add, color, float, positionGeometry, sin, texture, time, uv, vec2, vec3, vec4 } from 'three/tsl'

// ---------------------------------------------------------------------------
// LoadCurve — reconstructs Blender CURVE objects.
//
// The Blender plugin samples each curve's splines into dense local-space
// points (`sampledPoints`) and also exports the original control points
// (`controlPoints`). Each spline is refit as a NURBSCurve over those samples
// (see buildSplineCurve), then tessellated into a THREE.Mesh via TubeGeometry.
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

// #region nurbs-helpers
// Blender's default curve order is 4, i.e. a cubic NURBS.
const NURBS_DEGREE = 3

/**
 * Clamped uniform knot vector for an OPEN spline. The first and last knots are
 * repeated degree + 1 times, which pins the curve to its first and last control
 * points. Evaluable domain is [knots[degree], knots[n]].
 */
function clampedKnots(n: number, degree: number): number[] {
    const knots: number[] = []
    for (let i = 0; i <= n + degree; i++) {
        if (i <= degree) knots.push(0)
        else if (i >= n) knots.push(n - degree)
        else knots.push(i - degree)
    }
    return knots
}

/**
 * Uniform knot vector for a CLOSED (periodic) spline, where `n` is the number
 * of control points before padding (see buildSplineCurve).
 *
 * Evenly spaced knots make the basis periodic, so the curve wraps and the seam
 * is exactly as smooth as any other joint. Nothing is clamped, so the curve
 * approximates rather than passes through its first/last control points.
 */
function periodicKnots(n: number, degree: number): number[] {
    const knots: number[] = []
    for (let i = 0; i <= n + 2 * degree; i++) knots.push(i)
    return knots
}

const _tangentA = new THREE.Vector3()
const _tangentB = new THREE.Vector3()

/**
 * NURBSCurve whose getTangent() honours the curve's own parameter domain.
 *
 * The addon maps t over [knots[0], knots[last]] instead of
 * [knots[startKnot], knots[endKnot]]. Those coincide for clamped knots, but a
 * periodic knot vector's evaluable domain is only [degree, n + degree] — and
 * NURBSUtils.findSpan clamps to the boundary outside it, so the addon returns
 * tangents read off the wrong stretch of the curve. TubeGeometry builds its
 * Frenet frames from getTangentAt(), so closed tubes came out with ring planes
 * skewed by up to ~90 degrees near the seam. A central difference over the
 * curve's own points keeps getPoint and getTangent on one mapping.
 */
class DomainCorrectNURBSCurve extends NURBSCurve {
    getTangent(t: number, optionalTarget = new THREE.Vector3()): THREE.Vector3 {
        const EPS = 1e-4
        const a = this.getPoint(Math.max(0, t - EPS), _tangentA)
        const b = this.getPoint(Math.min(1, t + EPS), _tangentB)
        return optionalTarget.subVectors(b, a).normalize()
    }
}

/**
 * Refit one spline's sampled points as a NURBS curve.
 *
 * The samples become control points, so the curve approximates them rather than
 * interpolating them. That is only faithful because the Blender side resamples
 * every spline to a fixed, dense point count (CURVE_SAMPLE_COUNT): the error
 * shrinks with sample spacing, and at that density it stays far below the tube
 * radius. Bias is toward the inside of bends, since a B-spline is a convex
 * combination of its control points.
 *
 * Open splines take clamped knots. Closed splines need a periodic knot vector,
 * which in turn needs the control points padded by one degree so the evaluable
 * domain covers a full turn.
 */
function buildSplineCurve(vecs: THREE.Vector3[], closed: boolean): NURBSCurve {
    const n = vecs.length
    const degree = Math.min(NURBS_DEGREE, n - 1)

    if (closed) {
        // Pad with the first `degree` control points: the periodic domain is
        // [degree, n + degree] and findSpan rejects anything past knots[n], so
        // the trailing control points have to exist. startKnot/endKnot are
        // passed explicitly — the constructor defaults would map t across the
        // padding instead of the period.
        const controlPoints: THREE.Vector4[] = []
        for (let i = 0; i < n + degree; i++) {
            const v = vecs[i % n]
            controlPoints.push(new THREE.Vector4(v.x, v.y, v.z, 1))
        }
        return new DomainCorrectNURBSCurve(degree, periodicKnots(n, degree), controlPoints, degree, n + degree)
    }

    const controlPoints = vecs.map((v) => new THREE.Vector4(v.x, v.y, v.z, 1))
    return new DomainCorrectNURBSCurve(degree, clampedKnots(n, degree), controlPoints)
}
// #endregion nurbs-helpers

const texArrow = new THREE.TextureLoader().load(`/texture/arrows@1x.png`)
texArrow.generateMipmaps = false
texArrow.colorSpace = THREE.SRGBColorSpace
texArrow.wrapS = texArrow.wrapT = THREE.RepeatWrapping
const colorNodeA = texture(
    texArrow,
    uv()
        .mul(vec2(30, 1.0))
        .mul(2)
        .add(vec2(time.mul(0.35), 0.0)),
)

const colorNodeB = texture(
    texArrow,
    uv()
        .mul(vec2(30, 1.0))
        .mul(2)
        .add(vec2(time.mul(0.35).add(0.5), 0.0)),
)

// Shared red material — matches the reference recipe. Module-level so all
// curve lines share one program (never disposed per entry).
// const LINE_MATERIAL = new THREE.LineBasicMaterial({ color: 0xff0000 });
const MESH_MATERAIL = new THREE.MeshPhysicalNodeMaterial({
    colorNode: vec4(
        colorNodeA.rgb.mul(color('#05e2ff')),

        add(
            //
            colorNodeA.r.mul(0.5).mul(sin(uv().x.mul(100).add(time.mul(5)))),
            colorNodeA.r.mul(0.3),
            colorNodeB.r.mul(0.05),
        ),
    ),
    emissiveNode: vec4(vec3(color('#05e2ff').rgb), 1.0),
    transparent: true,
})

function buildCurveEntry(obj: BlenderObject): CurveEntry {
    const group = new THREE.Group()
    group.name = obj.name

    const geometries: THREE.BufferGeometry[] = []

    ;(obj.sampledPoints ?? []).forEach((points, i) => {
        if (!points || points.length < 2) return // a NURBS needs at least 2 control points

        const vecs = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]))
        const closed = obj.curveClosed?.[i] ?? false

        const curve = buildSplineCurve(vecs, closed)

        const tube = 2
        const geometry2 = new THREE.TubeGeometry(curve, subdivisionsFor(vecs.length), tube, 32, closed)

        const line = new THREE.Mesh(geometry2, MESH_MATERAIL)
        line.scale.y = 0.05

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
