import type { Camera, Object3D, Scene } from 'three'
import type { RendererInfoLike } from './store/useRuntimePerf'

/**
 * The renderer surface this module actually uses.
 *
 * R3F types `gl` as a `THREE.WebGLRenderer`, whose `debug` has no
 * `getShaderAsync` and whose `info` is missing the WebGPU memory fields — so
 * every collector would otherwise hand-cast the same shape. Declaring it once
 * keeps the casts in a single place.
 */
export type IntelligenceGL = {
    info?: RendererInfoLike
    debug?: {
        /** Compiles on demand and returns the built source; null when unavailable. */
        getShaderAsync?: (
            scene: Scene,
            camera: Camera,
            object: Object3D,
        ) => Promise<{ vertexShader: string | null; fragmentShader: string | null }>
        /**
         * Fires just after a node builder is created, before it is built — so
         * `nodeBuilder.vertexShader` is still null at that moment and the
         * builder must be read later.
         */
        onNodeBuilderCreated?: ((nodeBuilder: unknown, renderObject: unknown) => void) | null
    }
}

/** Narrow R3F's `gl` to the members we use. */
export function asIntelligenceGL(gl: unknown): IntelligenceGL {
    return gl as IntelligenceGL
}
