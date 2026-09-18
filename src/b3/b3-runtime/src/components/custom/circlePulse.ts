// ---------------------------------------------------------------------------
// circlePulse — the expanding ring shockwave
// ---------------------------------------------------------------------------
// Extracted from `LoadCollider`, which uses it to sweep a hexagonal glow across
// the floor, because `grassTSLMaterial` wants the same ring on the grass when the
// player jumps. Two copies of a shader function drift; one shared copy cannot.
//
// **It works on both because `positionWorld` is not the raw geometry position.**
// `NodeMaterial.setupPositionNode` *assigns* `positionNode` into `positionLocal`,
// and `positionWorld` is `modelWorldMatrix * positionLocal` — so a material that
// displaces its vertices (as the grass does, adding the per-blade `offset`) still
// reports the displaced point here. That is what lets the ring read real world
// space everywhere, and is why this needs no "measure from" parameter.
//
// Caveat for the grass: the ring therefore follows each *vertex*, including the
// blade's bend, rather than its root. The cull radius measures from the root, so
// the ring and the field edge are anchored to slightly different points — by the
// blade's height, which is a few centimetres. Nothing depends on the two agreeing.
// ---------------------------------------------------------------------------

import { Fn, abs, distance, float, positionWorld, smoothstep } from 'three/tsl'
import type { Node } from 'three/webgpu'

/**
 * Build the ring: a band `thickness` world-units wide sweeping from the
 * character outward to `maxRadius`, as a `0..1` intensity.
 *
 * @param characterPos where the ring is centred, in world space.
 * @param maxRadius how far the edge travels. `progress` scales it, so a sweep
 *   past the visible field costs nothing — it is simply never reached.
 * @param thickness half-width of the band on each side of the ring edge.
 *   `1.0` is the collider's original look.
 * @param progress sweep position, `0` at the centre and `1` at `maxRadius`.
 *   Driven as a tween on a uniform, not by time, so a re-trigger restarts it
 *   from the middle rather than jumping to wherever a clock happens to be.
 */
export const circlePulse: (
    characterPos: Node<'vec3'>,
    maxRadius: Node<'float'>,
    thickness: Node<'float'>,
    progress: Node<'float'>,
) => Node<'float'> = Fn(([characterPos, maxRadius, thickness = float(1), progress = float(0)]: any) => {
    // Ground-plane distance from the character (XZ — the ring lives on the floor)
    const dist = distance(positionWorld.xz, characterPos.xz)

    // Ring edge travels outwards from the character (progress 0) to maxRadius (1)
    const radius = maxRadius.mul(progress)

    // How far this fragment is from the ring edge
    const ringDist = abs(dist.sub(radius))

    // The pulse is a band `thickness` world-units wide on each side of the ring
    // edge, with smooth (not hard) edges. thickness = 1.0 reproduces the old look.
    const band = smoothstep(thickness, 0.0, ringDist)

    // Envelope, expressed on progress ([0,1]) so it's invariant to maxRadius:
    // fade in over the first 8% of the sweep (so progress 0 does not park a
    // bright dot under the character) and fade out over the last 10% so the
    // one-shot sweep ends cleanly instead of clipping mid-travel.
    const fadeIn = smoothstep(0.0, 0.08, progress)
    const fadeOut = float(1.0).sub(smoothstep(0.9, 1.0, progress))

    return band.mul(fadeIn).mul(fadeOut)
}) as any
