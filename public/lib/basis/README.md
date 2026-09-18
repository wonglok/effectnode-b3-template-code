# Basis Universal binaries

Third-party WASM served from a stable same-origin path. Nothing here is authored
in this repo — each file is a byte-for-byte copy of what a package ships, and is
in `public/` because **the packages cannot serve it themselves under Vite**.

## Why these are mirrored here

Both packages locate their WASM with a URL relative to their own module
(`new URL('../basis/basis_encoder.wasm', import.meta.url)`, and three's
equivalents). Vite pre-bundles dependencies into `node_modules/.vite/deps/`, so
that relative path resolves next to a *generated* chunk and 404s at runtime.

Copying them to `public/lib/basis/` and pointing the loaders at the absolute path
sidesteps the issue entirely. This is the same pattern `public/draco/` already
uses for the Draco decoder/encoder.

## Files

| File | Role | Source | Copied from |
| --- | --- | --- | --- |
| `basis_encoder.wasm` | **Encode** → KTX2 (used when building a deployment) | `ktx2-encoder@0.6.0` | `node_modules/ktx2-encoder/dist/basis/basis_encoder.wasm` |
| `basis_transcoder.js` | **Decode** → GPU formats (used when viewing one) | `three@0.186.0` | `node_modules/three/examples/jsm/libs/basis/basis_transcoder.js` |
| `basis_transcoder.wasm` | **Decode** (wasm half) | `three@0.186.0` | `node_modules/three/examples/jsm/libs/basis/basis_transcoder.wasm` |

The split matters: the **encoder** is only reached by the OPFS optimiser, and the
**transcoder** only by the production viewer. They are not interchangeable, and
neither is loaded unless something actually uses it — both are reached through
dynamic imports, so a deployment that ships no `.ktx2` files never fetches either.

### How each is wired

- Encoder — `src/b3/b3-runtime/src/components/utils/opfs/ktx2.ts` passes
  `wasmUrl: '/lib/basis/basis_encoder.wasm'` to `encodeToKTX2`.
- Transcoder — `src/b3/b3-runtime/src/components/utils/ktx2Decode.ts` calls
  `KTX2Loader.setTranscoderPath('/lib/basis/')`, which makes three fetch
  `basis_transcoder.js` and `basis_transcoder.wasm` from this directory.

### Note on `basis_encoder.js`

`ktx2-encoder` also ships `dist/basis/basis_encoder.js` (the emscripten glue) and
that one is **not** mirrored here — the package's own JS entry is bundled by Vite
and only its sibling `.wasm` needs a stable URL.

## Updating

Re-copy after bumping either dependency, then verify the copy is exact:

```sh
cp node_modules/ktx2-encoder/dist/basis/basis_encoder.wasm public/lib/basis/
cp node_modules/three/examples/jsm/libs/basis/basis_transcoder.{js,wasm} public/lib/basis/

shasum -a 256 public/lib/basis/* node_modules/three/examples/jsm/libs/basis/* \
  node_modules/ktx2-encoder/dist/basis/basis_encoder.wasm
```

A version skew between `basis_transcoder.js` and `.wasm` fails at runtime rather
than at build time, so keep the pair in step.

## Licence

Basis Universal is Apache-2.0 (Binomial LLC). `ktx2-encoder` additionally ships a
`THIRD_PARTY_NOTICES.md`. These files are redistributed unmodified.
