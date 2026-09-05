# mixamo-adapter avatar SDK

A portable **React Three Fiber** avatar system: compose a rigged body GLB with a
face/head GLB on a shared mixamorig skeleton, and play Mixamo FBX (or baked GLB)
motion clips on it. Everything under `src/AvatarSDK/` is self-contained and
ready to **copy into a new project**.

The demo app in this repo is just a consumer: it imports the SDK from
`'../AvatarSDK'` (see `src/components/PlanScene.tsx`). The SDK has **no
dependency on
the demo store** (no zustand), on the scene/stage components, or on any
`/char` asset path.

---

## Copy-paste into a new project

1. **Copy this folder** (`src/AvatarSDK/`) into your project. You can keep the
   `AvatarSDK` name or rename it to something shorter (e.g. `sdk`) — just update
   the import below to match.
   - Keep the `sample/` subfolder if you want the EffectNode `/char` catalogs as
     a template (see *Sample data* below); drop it if you build your own
     manifests — the core has zero `/char` knowledge.
   - Make sure your `tsconfig` includes this folder and the ambient module
     declaration `meshopt.d.ts` (used for three's inlined meshopt decoder).
2. **Peer dependencies** (install these):
   ```bash
   npm i three @react-three/fiber react react-dom
   npm i -D @types/three
   ```
   The meshopt decoder is bundled from `three/examples`, so no extra file.
3. **Host your non-code assets** somewhere reachable at runtime:
   - the **Draco decoder files** (`draco_decoder.js`, `draco_decoder.wasm`,
     `draco_wasm_wrapper.js`). Default location `/lib/draco/`; point the SDK
     elsewhere with `setDracoDecoderPath('/your/path/')` **before the first
     load**, or pass a `decoderPath` to `createGltfLoader`/`loadGLB`.
   - your **rigged body + face GLBs** and **bone-only Mixamo FBX motion files**,
     referenced by URL in your manifest.
4. **Minimal usage:**
   ```tsx
   import { Canvas } from '@react-three/fiber'
   import { Suspense } from 'react'
   import { Avatar, makeDefaultManifest, type AvatarManifest } from './AvatarSDK'

   const manifest: AvatarManifest = makeDefaultManifest({
     name: 'hero',
     gender: 'male',                          // sample catalog; omit for custom
     // assets/motion from the sample set, or provide your own:
     // assets: { body: '/models/hero.glb', face: '/models/hero-head.glb' },
     // motion: { clips: [ { name: 'run', url: '/motions/run.fbx' } ], default: 'run' },
   })

   export function App() {
     return (
       <Canvas>
         <Suspense fallback={null}>
           <Avatar manifest={manifest} />
         </Suspense>
       </Canvas>
     )
   }
   ```
   > `<Avatar manifest={…} />` **requires** a `manifest` at runtime and throws
   > without one (each field can still be overridden via the other props, e.g.
   > `assets`, `headMode`, `motion`, `playing`, `visible`, `revealWhenUpright`).

---

## Rig/export conventions the SDK assumes

- Body & face are **mixamorig-skeleton** rigs. GLB node names are sanitized
  (`mixamorig:Head` → `mixamorigHead`); FBX tracks are remapped to whatever the
  loaded scene actually calls its bones (`mapClipBones`).
- Rigs export **lying along +Z** (~0.97 m). The SDK stands the avatar up on its
  own motion root via the default body offset — `defaultBodyFor()` returns a
  **−90° X "home"** — so `<Avatar>` renders upright in any scene at identity.
  An already-upright custom GLB overrides this by tuning the combo's `body`
  offset (`rotation: [0,0,0]`).
- **Faces** are composed onto the body's head bone:
  - Rigged head whose skeleton rests congruent with the body's → **co-located
    dual-drive** (both rigs play the same clip; exact skin sync).
  - Foreign/remixed rigged head → **seat glue**: size-fit by neck→head ratio,
    its Head bone moved to the seat origin, rigid-glued onto the live head bone.
  - Static head (no skeleton) → rigid glue onto the head bone.
  - `headMode: 'seat'` forces seat glue at authored size (skip dual-drive) —
    for cross-look combos whose rests are near-congruent but whose proportions
    drift mid-clip.
- Clips can open with the character lying down and standing over the first
  seconds. `revealWhenUpright` (default `true`) hides the avatar until its
  skeleton stands, so the floor-splayed intro never shows.

---

## Manifest shape (the interchange format)

A `AvatarManifest` describes one composed avatar: `assets` (body + face URLs),
`headBone`, `head`/`body` insertion+placement offsets (per body × face combo in
`offsets`), and `motion` (clips, default, loop/speed/playing). Build/validate it
with the SDK helpers, or hand-write it (see `types.ts`).

- `assembleManifest(input)` (core) — fills structure only; asset-agnostic.
- `parseManifest(json)` (core) — validate + normalize arbitrary JSON (neutral).
- `serializeManifest` / `downloadManifest` — export back to JSON.

---

## Sample data (`src/AvatarSDK/sample/charAssets.ts`)

The EffectNode `/char` look pool used by the demo app: `GENDER_ASSETS`,
`GENDER_PARTS`, `partsFor`/`variantForUrl`/`genderFromAssets`,
`MOTION_NAMES`/`createMotionCatalog`, `DEFAULT_GENDER`, and the char-aware
`makeDefaultManifest()` (default male + the demo's motion library). It lives in
its own folder so the core stays asset-agnostic — re-point the URLs or delete it
and supply your own manifest.

---

## File map

| File | Role |
| --- | --- |
| `index.ts` | Public barrel (component + core + sample exports) |
| `Avatar.tsx` | `<Avatar/>` orchestrator (loading, rig lifecycle, playback, reveal) |
| `avatarProps.ts` | Props/types + `resolveProps` (manifest-required) |
| `avatarPose.ts` | Upright reveal + body-offset "home" math |
| `headCompose.ts` | Face measurement + congruent/seat/fallback attachment |
| `motionLibrary.ts` | FBX clip loading + remap |
| `manifest.ts` | Manifest schema/normalize/parse/serialize + core `assembleManifest` |
| `types.ts` | Shared types & constants |
| `decoders.ts` | Draco + meshopt-aware GLTF loader, FBX loader, configurable path |
| `rig.ts` | Bone lookup, head-bone detect, FBX→GLB clip remap |
| `attachHead.ts` | Mount a face onto a bone (offset/rigid modes) |
| `seating.ts` | Seat-alignment math for foreign heads |
| `measure.ts` | Bounding-box measure helper (generic util) |
| `meshopt.d.ts` | Ambient types for three's inlined meshopt decoder |
| `sample/charAssets.ts` | EffectNode `/char` catalogs + char-aware defaults (optional) |
