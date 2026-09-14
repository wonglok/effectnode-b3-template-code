# Blender Three.JS WebSocket Sync Protocol (B3)

A Vite + React + Three.js (WebGPU) template built around three systems:

- **Blender → Three.js sync** — the **B3 Blender add-on** streams your scene over WebSocket and it renders in the browser live, then snapshots, optimises and deploys as a self-contained zip.
- **Three.js runtime diagnosis** — a local agent bridge that inspects and patches the *running* scene: draw calls, triangle cost, live frame budget, GPU memory and leak candidates, WGSL shader source.
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

**The app must be open in a browser tab, or every query answers `503`.**

```bash
# is an editor connected?
curl -s localhost:4343/api/health

# what is a frame actually costing?
curl -s localhost:4343/api/query/performance | jq '.result.runtime.framerate, .result.runtime.load'

# why is GPU memory growing?
curl -s localhost:4343/api/query/memory | jq '.result.gpu, .result.leakCandidates'
```

| Route | Answers |
|---|---|
| `GET /api/query/scene` | scene graph, world-space bounds, cull flags |
| `GET /api/query/performance` | geometry cost + live fps / frame budget / effect timing / browser environment |
| `GET /api/query/memory` | GPU registry, leak candidates, instancing candidates |
| `GET /api/query/drawcalls` | per-object draw calls and their bound textures |
| `GET /api/query/shader` | captured WGSL source, live uniforms, wired feature slots |
| `POST /api/mutation/patch` | RFC 6902 JSON Patch against any object |
| `POST /api/mutation/eval` | run a snippet with `$0` / `scene` / `camera` / `gl` in scope |
| `POST /api/mutation/dispose` | detach a subtree and release its GPU resources |

Mutations are **local-only** — they refuse non-loopback callers and cross-origin browser requests, and the editor disables them outside a dev build. `eval` is arbitrary JavaScript execution in the page, by design.

The full protocol — selector resolution, failure modes, how to read each facet, and the WebGPU optimisation heuristics — lives in [`src/runtime-intelligence/skill/query-runtime.md`](src/runtime-intelligence/skill/query-runtime.md).

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
        └── components/AvatarSDK/   # avatar wardrobe: manifest, head compose, rig, motion library
```

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
