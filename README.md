# Blender Three.JS WebSocket Sync Protocol (B3)



https://github.com/user-attachments/assets/4cd626ed-7793-496c-ba41-52e697fe2207



A Vite + React + Three.js (WebGPU) template built around three systems:

- **Blender → Three.js sync** — the **B3 Blender add-on** streams your scene over WebSocket and it renders in the browser live, then snapshots, optimises and deploys as a self-contained zip.
- **Three.js performance optimisation** — a build-time optimiser (AVIF textures + Draco geometry → `scene.zip`) plus a local agent bridge that measures and patches the *running* scene: draw calls, triangle cost, live frame budget, GPU memory and leak candidates, WGSL shader source. See [Three.js performance optimisation](#threejs-performance-optimisation)
- **Avatar wardrobe system** — a manifest-driven character assembler: swap body, head and motion set at runtime, with per-combination seating offsets.

<img width="3840" height="2160" alt="image" src="https://github.com/user-attachments/assets/baa11558-c132-4901-bd81-0ae33ccd8285" />

## Blender example file:

https://github.com/wonglok/effectnode-b3-template-code/releases/tag/r001

## What is this?

- A Vite + React 19 + React Three Fiber + WebGPU template
- Ships a **Blender add-on** (`src/b3/b3-blender`) that runs a WebSocket server (default `localhost:8765`) and streams the scene — geometry, materials, lights, camera, HDRIs and textures — to the browser
- A **live dev page** that renders the Blender scene in real time, with snapshot → optimizer → zip export workflow
- A **production viewer** and a **deployment page** that plays a packaged `scene.zip` statically, with navmesh + character rig layered on top
- Ships the **runtime-intelligence bridge** (`src/runtime-intelligence`) — a local REST + WebSocket service that answers questions about the live scene graph and applies mutations, so a coding agent (or you, over `curl`) can diagnose and tweak the running app without a rebuild. See [Three.js runtime diagnosis](#threejs-runtime-diagnosis)
- Measures **performance on demand rather than by eye** — snapshot draw calls, triangle cost, rolling fps percentiles, per-pass timings, GPU-resident bytes and leak candidates, all labelled per device, so the same question compares a phone against a laptop. See [Three.js performance optimisation](#threejs-performance-optimisation)
- **Offloads simulation to the GPU** — the renderer is WebGPU with TSL end to end, so per-entity JavaScript work (particles, flocking, procedural terrain, the NPC crowd) can move to compute shaders instead of competing with the render loop
- Ships the **avatar wardrobe** (`src/b3/b3-runtime/src/components/AvatarSDK`) — a manifest-driven body/head/motion assembler with a live picker UI. See [Avatar wardrobe system](#avatar-wardrobe-system)

## Getting started

```bash
# install
bun install

# run the dev server
bun run dev

# type-check + production build
bun run build

# lint
bun run lint

# preview the production build
bun run preview
```

### 1. Install the Blender add-on

1. bun run dev, then download the plugin at the home page.
2. In Blender, open **Edit → Preferences → Add-ons → Install…** and select the plugin file
3. Enable **B3 Sync** — it lives at **Properties → Render → B3 Sync**
4. It will auto-install `websockets` into Blender's bundled Python on first use

### 2. Live-sync in the browser

1. Start the add-on's server in Blender (B3 Sync panel)
2. Open `http://localhost:5173/dev` — the **Dev** page connects to Blender and renders the scene in real time
3. Edit in Blender; the canvas updates live

### 3. Snapshot → deploy

The **Dev** page sidebar can:

- **Snapshot** the current scene into the browser's OPFS storage
- Run the **optimiser** (draco / meshoptimizer via gltf-transform)
- **Export `scene.zip`** — pick a folder via the File System Access API (persisted in IndexedDB), and every snapshot is written there automatically. Tip: point it at `public/deploy/` so the deployment page picks it up; Vite is configured to serve it without hot-reloading
- **Deployment** page (`/deployment`) fetches `/deploy/scene.zip` and plays it with the walkable navmesh + character rig

## Three.js runtime diagnosis

`src/runtime-intelligence` is a local agent bridge in two halves: a **backend** (Express + socket.io, default `localhost:4343`) that holds no scene state and merely forwards requests, and an **editor** (`IntelligenceScan`) mounted inside each page's R3F canvas that answers them about the live scene. `bun run dev` starts it next to Vite, and Vite proxies `/api` + `/socket.io` to it, so everything works same-origin from `http://localhost:5173`.

**At least one tab must be open, or every query answers `503`.** Every request fans out to *all* connected tabs and comes back with one labelled answer per device, so a single call compares an iPhone, an Android and a laptop against the same scene.

```bash
# who is connected? These labels are what `?editor=` takes.
curl -s localhost:4343/api/editors | jq '.editors[] | {label, viewport, devicePixelRatio}'

# what is a frame costing, on every device at once?
curl -s localhost:4343/api/query/performance \
  | jq '.result.responses[] | {who: .editor.label, fps: .result.runtime.framerate.fps}'

# why is GPU memory growing? (aimed at one device)
curl -s 'localhost:4343/api/query/memory?editor=mac' \
  | jq '.result.responses[0].result | {gpu, leakCandidates}'
```

| Route | Answers |
|---|---|
| `GET /api/editors` | who is connected — label, platform, viewport, DPR |
| `GET /api/query/scene` | scene graph, world-space bounds, cull flags |
| `GET /api/query/performance` | geometry cost + live fps / frame budget / effect timing / browser environment |
| `GET /api/query/memory` | GPU registry, leak candidates, instancing candidates |
| `GET /api/query/drawcalls` | per-object draw calls and their bound textures |
| `GET /api/query/shader` | captured WGSL source, live uniforms, wired feature slots |
| `POST /api/mutation/patch` | RFC 6902 JSON Patch against any object |
| `POST /api/mutation/eval` | run a snippet with `$0` / `scene` / `camera` / `gl` in scope |
| `POST /api/mutation/dispose` | detach a subtree and release its GPU resources |

Add `?editor=<id or label substring>` to any route, GET or POST, to aim it at one tab instead of all of them — `?editor=safari`, `?editor=iphone`. An ambiguous selector is refused rather than guessed at.

Mutations are **local-only** — they refuse non-loopback callers and cross-origin browser requests, and the editor disables them outside a dev build. `eval` is arbitrary JavaScript execution in the page, by design. Note that a mutation without `?editor=` lands on **every** connected tab.

The full protocol — selector resolution, failure modes, and every facet's field-by-field reading — lives in [`src/runtime-intelligence/skill/query-runtime.md`](src/runtime-intelligence/skill/query-runtime.md). What to *do* about what it reports is the next section.

## Three.js performance optimisation

Two halves that feed each other: a **build-time optimiser** that shrinks what ships, and a **runtime bridge** that measures what a *running* scene actually costs — and can patch it live, so a hypothesis is proved before you touch the source.

### Build-time — the optimiser pipeline

`OpfsOptimiser` ([`utils/opfs/optimizer.ts`](src/b3/b3-runtime/src/components/utils/opfs/optimizer.ts)) reads the raw snapshot out of OPFS and writes an optimised view, which is then packaged as `scene.zip`:

| Stage | What it does | Why it is that and not something else |
|---|---|---|
| **Textures** | Re-encode to **AVIF**, WebP fallback, via `OffscreenCanvas` | A decoded PNG/JPG dominates VRAM. The encoder is probed with `supportsAvifEncode()` first, so a browser without AVIF support degrades instead of failing. |
| **HDR** | Raw copy, deliberately uncompressed | AVIF and WebP are 8-bit formats. Re-encoding an HDR would flatten the float precision the lighting depends on. |
| **Geometry** | Deduplicate, then **Draco**-compress via `draco3d` WASM (served from `/draco/`) | Shrinks both the download payload and the GPU attribute size. |
| **Scene JSON** | Copy-through, with instance groups and rewritten references | The optimiser can collapse repeated objects into instanced groups, so the scene graph has to be rewritten to match. |

### Runtime — what the bridge measures

The queries say *what* is expensive; the mutations let you test the fix without a rebuild.

| Query | The performance question it answers |
|---|---|
| `GET /api/query/performance` | `drawCalls` and `triangles`, live `fps` / `frameMs` / `p95FrameMs`, frame-budget headroom, per-pass effect timing, and the browser environment the numbers came from |
| `GET /api/query/memory` | `gpu` vs `totals` (the leak signal), `leakCandidates`, and `instancingCandidates` with their projected `drawCallsNow → drawCallsAfter` |
| `GET /api/query/drawcalls` | per-object draw calls and each material's bound textures, heaviest first |
| `GET /api/query/shader` | captured WGSL source, live uniform values, wired feature slots |
| `GET /api/query/scene` | hierarchy, world-space bounds, cull flags |

Reading the numbers, the things that are easy to get wrong:

- **`totals.drawCalls` is a static estimate; `runtime.load.drawCalls` is the measured whole frame**, including shadow-map and post-processing passes. A gap is expected — but a gap that *grows* points at a pass doing more work over time. `runtime.load.frameCalls` is how many `render()` invocations made up the frame.
- **Geometry-bound or CPU-bound?** Many draw calls with few triangles means CPU-bound (batching will help). The reverse means geometry-bound (decimate).
- **`slowObjects` ranks static primitive cost, not frame time.** Only `runtime` holds real milliseconds.
- **The frame timings are a rolling window, not a spot reading.** Samples are held in a bounded history (`MAX_SAMPLES = 480`, about 8 seconds at 60fps), so a single asset-loading hitch does not read as a permanently slow scene — and the percentiles describe sustained cost rather than whatever the last frame happened to do.
- **Frame timings only compare across machines when you know the machine** — `runtime.environment` records the browser that produced them.

### The levers, most impactful first

1. **Swapping in `WebGPURenderer` is not itself the optimisation.** The win is moving CPU-bound work — particle systems, flocking, procedural terrain, anything looping per-entity in JavaScript — onto the GPU as a **TSL compute shader**. The power is in the offload, not the backend. Fingerprint: low `triangles` but high `frameMs` and a *modest* `drawCalls` means the cost is simulation, not rasterisation. This app already runs TSL end to end; `/api/query/shader` answering `language: "wgsl"` with `uniforms.from: "node-builder"` is the fingerprint.
2. **CPU timings are not GPU timings.** `framerate` and `slowEffects` are built from `performance.now()`, so they include JS overhead and queue wait — they tell you *a frame* was slow, not *which pass*. GPU ground truth needs the renderer built with `new WebGPURenderer({ trackTimestamp: true })` and `await renderer.resolveTimestampsAsync()` after a pass. If `slowEffects` blames a pass the timestamp says is cheap, the cost is in JS, not the shader.
3. **Consolidate draw calls — target < 100.** CPU→GPU draw calls stay expensive under WebGPU. Use **`InstancedMesh`** for many copies of one geometry (grass, debris, rocks) — `/api/query/memory` already ranks these as `instancingCandidates`, so treat that list as the work queue. Use **`BatchedMesh`** to merge *varied* geometries sharing a material, which is the case `instancingCandidates` cannot see. Always verify against the re-measured `runtime.load.drawCalls`, not the estimate.
4. **VRAM-optimised asset formats.** `totals.textureBytes` is the number to watch. **KTX2** keeps textures compressed *on the GPU* — the single biggest VRAM lever, since the texture is never blown out to raw RGBA. **Draco / Meshopt** compress the geometry behind `geometryBytes`. Confirm through `gpu.textures` and `gpu.totalBytes`, which count only what the GPU actually holds.
5. **Dispose, or the tab crashes.** WebGPU memory leaks crash browser tabs, and Three.js does **not** garbage-collect unused GPU assets — a removed mesh's geometry, material and textures stay resident until you call `geometry.dispose()` / `material.dispose()` / `texture.dispose()`. `/api/mutation/dispose` does it for a subtree; for entities spawned and destroyed repeatedly, prefer **object pooling** so nothing is disposed on the hot path at all.

### The loop

Queries tell you what is expensive → form one hypothesis → prove it against the live scene with `POST /api/mutation/eval` (or hide the suspect with `POST /api/mutation/patch` and re-measure) → then edit the source and confirm with the same query. Because every answer is labelled per device, the same call gives you the before/after on an iPhone, an Android and a laptop at once — which is the whole point, since a scene that runs at 60fps on your laptop is not evidence about a phone.

Worked end to end in the skill doc: [*frame drops after an avatar swap*](src/runtime-intelligence/skill/query-runtime.md#worked-example-frame-drops-after-an-avatar-swap) — who is answering, baseline across every device, find the object that costs the most draw calls, separate the passes from the scene graph, confirm the shader is innocent, then patch it out, re-measure and undo.

## Avatar wardrobe system

Characters are assembled at runtime from three swappable parts, described by the manifest at `public/char/avatar.manifest.json`:

```json
{
  "sdk": "mixamo-adapter/avatar", "version": 2,
  "gender": "male",
  "assets": {
    "body": "/char/male/body/water-guy.glb",
    "face": "/char/male/face/low-poly-west-head.glb"
  },
  "body": { "position": [0, -0.045, 0], "rotation": [-90, 0, 0], "scale": [1, 1, 1] },
  "head": { "position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1] }
}
```

- **Body** (outfit) — 20 male / 11 female GLBs under `/char/{male,female}/body`
- **Head** (face) — 11 male / 8 female GLBs under `/char/{male,female}/face`
- **Motion** — clip packs under `/char/motion-2/fbx` (locomotion, gesture, gun, longbow, breakdance, pro-magic, shooter, stay)

Every body↔head pairing seats differently, so the manifest carries an `offsets` table keyed by the body/head URL pair; `classifyHeadCompose` selects the plan and seats the head on the shared mixamorig skeleton at load. Parts are GLBs, so the texture budget is enforced on load — embedded images are capped to `MAX_TEXTURE_SIZE` and shared across clones.

In the UI, `AvatarPicker` is the bottom-right button on the Dev / Preview / Production canvases. Gender, body and head chips **live-apply** to the Zustand `useAvatarStore` that `NavMeshRig` subscribes to, so the walking character restyles in place; the "stay motion" chips are preview-only and loop inside the popup's own preview canvas.

## Pages

| Route | Page | What it does |
|---|---|---|
| `/` | Home | Landing page + add-on download |
| `/dev` | Dev | Live WebGPU sync canvas, snapshot → OPFS → optimizer, zip export, navmesh mode |
| `/preview` | Preview | Plays the deployment zip out of **OPFS** — whatever the Dev page last exported |
| `/production` | Production | Plays the **static** `/deploy/scene.zip`, with navmesh + character rig + avatar wardrobe |
| `/deployment` | Deployed | Alias of `/production` — routes to the same `ProductionPage` |

## Project structure

```
src/
├── main.tsx                # entry
├── AppRouter.tsx           # routes
├── pages/                  # Home / Dev / Preview / Production (+ /deployment alias)
├── components/             # app components (navmesh rig, joystick, emotion buttons, avatar store)
├── runtime-intelligence/   # agent bridge — Express + socket.io backend, in-canvas editor, skill doc
└── b3/                     # the B3 packages
    ├── b3-blender/         # Blender add-on — WebSocket server + scene streaming (Python)
    └── b3-runtime/         # @effectnode/b3-runtime — React runtime library (published to npm)
        └── components/
            ├── AvatarSDK/            # avatar wardrobe: manifest, head compose, rig, motion library
            └── utils/opfs/           # OPFS snapshot storage + the optimiser pipeline (AVIF / Draco → scene.zip)
```

Performance tooling lives in two places: the **optimiser** at `src/b3/b3-runtime/src/components/utils/opfs/optimizer.ts`, and the **measurement bridge** at `src/runtime-intelligence` (backend + in-canvas editor) with its protocol in `src/runtime-intelligence/skill/query-runtime.md`.

## Stack

- React 19, React Router 7, Zustand (state)
- Three.js r186, React Three Fiber 9, drei, WebGPU (`three/webgpu` + TSL materials)
- gltf-transform, draco3d, meshoptimizer, jszip
- navcat (navmesh), nipplejs (virtual joystick), mathcat, lil-gui
- Express 5 + socket.io (the runtime-intelligence backend)
- Tailwind CSS 4, TypeScript 6, Vite 8

## Credits / thank you list

- ThreeJS r186
- Blender 5.2
- Ambine CG texture
- Survival Guy in CGTrader
- Mixamo
- Google Gemini Nano Banana
- Dear GOD: The Father, The Son The Holy Spirit
- Dear beloved Jesus <3
