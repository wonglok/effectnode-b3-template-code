# Blender Three.JS WebSocket Sync Protocol (B3)

A Vite + React + Three.js template with the **B3 Blender add-on** integrated into the workflow — build your scene in Blender, watch it live-sync into the browser over WebSocket, then snapshot and deploy it as a self-contained zip.

<img width="3840" height="2160" alt="image" src="https://github.com/user-attachments/assets/baa11558-c132-4901-bd81-0ae33ccd8285" />

## Blender example file:

https://github.com/wonglok/effectnode-b3-template-code/releases/tag/r001

## What is this?

- A Vite + React 19 + React Three Fiber + WebGPU template
- Ships a **Blender add-on** (`src/b3/b3-blender`) that runs a WebSocket server (default `localhost:8765`) and streams the scene — geometry, materials, lights, camera, HDRIs and textures — to the browser
- A **live dev page** that renders the Blender scene in real time, with snapshot → optimizer → zip export workflow
- A **production viewer** and a **deployment page** that plays a packaged `scene.zip` statically, with navmesh + character rig layered on top

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

## Pages

| Route | Page | What it does |
|---|---|---|
| `/` | Home | Landing page |
| `/dev` | Dev | Live WebGPU sync canvas, snapshot → OPFS → optimizer, zip export |
| `/production` | Production | Production viewer for the synced scene |
| `/deployment` | Deployed | Renders `/deploy/scene.zip` statically with navmesh + character rig |

## Project structure

```
src/
├── main.tsx                # entry
├── AppRouter.tsx           # routes
├── pages/                  # Home / Dev / Production / Deployed
├── components/             # app components (rig, navmesh, site menu, zustand stores)
└── b3/                     # the B3 packages
    ├── b3-blender/         # Blender add-on — WebSocket server + scene streaming (Python)
    └── b3-runtime/         # @effectnode/b3-runtime — React runtime library (published to npm)
```

## Stack

- React 19, React Router 7, Zustand (state)
- Three.js r185, React Three Fiber 9, drei, WebGPU (`three/webgpu` + TSL materials)
- gltf-transform, draco3d, meshoptimizer, jszip
- navcat (navmesh), nipplejs (virtual joystick), mathcat, lil-gui
- Tailwind CSS 4, TypeScript 6, Vite 8

## Credits / thank you list

- ThreeJS r185
- Blender 5.2
- Ambine CG texture
- Survival Guy in CGTrader
- Mixamo
- Google Gemini Nano Banana
- Dear GOD: The Father, The Son The Holy Spirit
- Dear beloved Jesus <3
