/**
 * Ambient types for three's inlined meshopt decoder module. The module ships
 * the WASM binary base64-embedded as a plain `var`, so it has no .d.ts of its
 * own; this shim mirrors the shape GLTFLoader.setMeshoptDecoder() expects.
 */
declare module 'three/examples/jsm/libs/meshopt_decoder.module.js' {
  export interface MeshoptDecoderApi {
    supported: boolean
    ready: Promise<void>
    useWorkers: (count: number) => void
    decodeVertexBuffer: (
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      filter?: string,
    ) => void
    decodeIndexBuffer: (
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
    ) => void
    decodeIndexSequence: (
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
    ) => void
    decodeGltfBuffer: (
      target: Uint8Array,
      count: number,
      size: number,
      source: Uint8Array,
      mode?: string,
      filter?: string,
    ) => void
    decodeGltfBufferAsync: (
      count: number,
      size: number,
      source: Uint8Array,
      mode: string,
      filter?: string,
    ) => Promise<Uint8Array>
  }

  export const MeshoptDecoder: MeshoptDecoderApi
}
