# Query Runtime

Inspect and patch the live Three.js scene running in the browser at
`http://localhost:4343`.

The backend holds no scene state. Every request is forwarded over a WebSocket to
the connected **editors** — browser tabs running the app — and **every editor
answers**. A response is a list of per-editor answers, each labelled with the
device behind it, so a single call compares an iPhone, an Android and a laptop
against the same scene. So: **at least one tab must be open, or every query
returns 503.**

## Check health first

```
GET http://localhost:4343/api/health
```

```json
{ "uptime": 41203, "editors": 2, "identified": 2, "unidentified": 0, "duplicates": [] }
```

`editors` is how many tabs can answer. Every request goes to all of them and
every answer comes back, so more than one is the *useful* case, not a problem.

`unidentified` counts tabs that joined without announcing themselves — still
answerable, but not nameable. `duplicates` lists editor ids presented by more
than one live tab (duplicating a tab copies its id), which makes `?editor=` on
that id ambiguous.

To see who is connected, and get the ids `?editor=` takes:

```
GET http://localhost:4343/api/editors
```

```json
{ "editors": [
    { "id": "959e7c1b-9fcb-4387-a93b-f4e08c932b2d", "loadId": "60502996-c646-47a4-9333-b81d3d77ed89",
      "label": "macOS · Chrome · /production", "platform": "macOS", "browser": "Chrome",
      "page": "/production", "viewport": { "width": 1728, "height": 854 },
      "devicePixelRatio": 1, "userAgent": "Mozilla/5.0 …",
      "socketId": "JF3iecjYkdf0L1K4AAAA", "connectedAt": 1789349358273, "identified": true } ],
  "duplicates": [] }
```

This route is loopback-guarded like the mutations — it lists user agents and
viewports, which have no business being readable from the rest of the wifi.

## Reading a response

Every route returns one shape:

```json
{ "reqID": "performance_1a2b", "ok": true,
  "result": {
    "count": 2, "expected": 2, "timedOut": false, "partial": false,
    "allFailed": false, "warnings": [],
    "responses": [
      { "editor": { "label": "macOS · Chrome · /production", "…": "…" },
        "ok": true, "elapsedMs": 2, "result": { "…this facet, on this device…" } },
      { "editor": { "label": "iOS · Safari · /production", "…": "…" },
        "ok": true, "elapsedMs": 3, "result": { "…this facet, on this device…" } }
    ] } }
```

- **Every example in this document shows one editor's `result`** — the contents
  of `responses[].result`, not the whole body. Destructure before comparing:
  `jq '.result.responses[] | {who: .editor.label, fps: .result.runtime.framerate.fps}'`
- `count` is how many answered; `expected` is how many were asked. They differ
  when an editor dropped out mid-request.
- One editor failing its own collector is `ok: false` **on its answer only** — a
  bad selector or a slow device does not cost you the other answers. `partial`
  says at least one failed, `allFailed` says every one did. `warnings` carries
  caveats about reading the set as a whole.
- An editor that never answers is reported as `ok: false` with
  `"did not answer before the timeout"` — you still get everyone else, but the
  request waits the full 15s for it.

## Targeting one editor

```
GET /api/query/performance?editor=safari
GET /api/query/performance?editor=959e7c1b-9fcb-4387-a93b-f4e08c932b2d
POST /api/mutation/eval?editor=iphone
```

Resolved in order: exact `id`, exact `label`, then a case-insensitive substring
of either — so `?editor=safari` or `?editor=iphone` usually just works. An
**ambiguous** selector is refused with `400` and the candidate list rather than
picked at random; no match is `404`.

Aim mutations at one device with it. Without it, a mutation applies to **every**
connected editor — which is what you want for "run this probe everywhere" and is
a footgun for `dispose`, which would detach the subtree on all of them.

> `$0` is resolved **per editor** — it is the object *that tab* last addressed,
> not a scene address. Fanning `?object=$0` out to three tabs asks about three
> different objects, and `patch`es three different subtrees. The envelope warns
> when it sees one, but prefer a real path or uuid when targeting several tabs.

## Failure modes

| Status | Meaning |
|---|---|
| `503 no editor connected` | No tab is open, or it hasn't connected yet. |
| `403` | You called a guarded route (a mutation, or `/api/editors`) from a non-local origin. |
| `404` | `?editor=` matched no connected editor. |
| `400` | `?editor=` matched more than one — the error lists them. |
| `200` with `partial: true` | The request ran, but at least one editor failed or dropped out. Read `responses[]`. |

There is no `504`: a request that outruns its editors still answers `200`, with
the late ones marked `ok: false` and `timedOut: true`. Losing every answer is
`allFailed`. A bare error body means the request never reached an editor at all.

**A backgrounded tab still answers, but its frame numbers are stale.** It keeps
receiving socket messages, so it will reply — but with `requestAnimationFrame`
suspended, `runtime.framerate` reads zero. A device reporting `fps: 0` is a tab
nobody is looking at, not a bug.

## Addressing an object

Every request that targets an object takes a **selector** (`?object=` on a GET,
`"object"` in a POST body). Resolved in this order:

| Form | Example | Meaning |
|---|---|---|
| `$0` | `$0` | The object the last successful request addressed. |
| uuid | `a1b2c3d4-…` | Exact `Object3D.uuid` match (from `/api/query/scene`). |
| path | `player/Avatar/head` | Walk children from the scene root by name or uuid. |
| name | `player` | First object in depth-first order with that name. |

There is no selection UI in the app, so `$0` is populated by exactly this
mechanism: address something and it becomes `$0`. Known useful entry points:
`player` (the character group), `Avatar` (the avatar root), `collider`.

---

# Queries

## Scene graph — hierarchy, bounds, cull flags

```
GET /api/query/scene
GET /api/query/scene?object=player       # scope to a subtree
GET /api/query/scene?maxDepth=2          # truncate the tree (root = 0)
```

Every node carries:

```json
{
  "uuid": "a1b2c3d4-…",
  "name": "PlayerCharacter",
  "type": "Group",
  "visible": true,
  "castShadow": true,
  "receiveShadow": true,
  "frustumCulled": true,
  "renderOrder": 0,
  "position": [0, 8.005, -29.23],
  "rotation": [0, 1.5707, 0],
  "scale": [1, 1, 1],
  "bbox": { "min": [-0.5, 0, -0.5], "max": [0.5, 1.8, 0.5] },
  "material": { "name": "MeshPhysicalNodeMaterial", "type": "…", "color": 16777215 },
  "children": []
}
```

- **`bbox` is world-space and already includes every descendant.** Use it to
  answer "place the apple on the table" without multiplying matrices yourself.
  It is `null` for a node with no geometry beneath it.
- **Cull flags** answer "why is my shadow missing?" (`castShadow`) and "why does
  this disappear when I pan?" (`frustumCulled`).
- `maxDepth` truncates the *emitted tree* only — bounds stay correct.
- **Local vs world:** `position` / `rotation` / `scale` are the **local**
  transform — exactly the properties `/api/mutation/patch` writes, so you can
  verify a patch by re-querying. `bbox` is **world-space** and includes every
  descendant. Under a scaled or rotated parent the two do not agree, so do not
  do world-space arithmetic on `position`. `rotation` is XYZ Euler, in radians.

## Performance — geometry cost + live frame timing

```
GET /api/query/performance
```

```json
{
  "totals": {
    "objects": 412, "drawCalls": 96, "uniqueGeometries": 38,
    "uniqueMaterials": 31, "uniqueTextures": 12,
    "vertices": 118004, "triangles": 39201,
    "drawnVertices": 240118, "drawnTriangles": 79002
  },
  "geometries": [ { "uuid": "…", "triangleCount": 12000, "references": 3, "owners": ["a","b","c"], "bytes": 576000 } ],
  "slowObjects": [ { "name": "Terrain", "instances": 1, "triangleCount": 12000 } ],
  "runtime": {
    "sampling": true, "frames": 900,
    "environment": {
      "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) …",
      "userAgentData": { "brands": [ { "brand": "Chromium", "version": "140" } ],
                         "mobile": false, "platform": "macOS" }
    },
    "framerate": { "fps": 58.2, "frameMs": 17.2, "p95FrameMs": 24.1, "minFps": 31.0, "slowFrames": 4 },
    "budgetTargets": [ { "target": 60, "budgetMs": 16.67, "headroomPct": -3.2, "overBudget": true } ],
    "load": {
      "drawCalls": 118, "frameCalls": 4, "calls": 108420,
      "triangles": 79002, "points": 0, "lines": 0,
      "textures": 12, "geometries": 38, "totalBytes": 41883648,
      "memory": { "geometries": 38, "textures": 12, "programs": 31,
                  "attributesSize": 34000000, "texturesSize": 7800000,
                  "programsSize": 84000, "uniformBuffersSize": 2048,
                  "indexAttributesSize": 1900000, "totalBytes": 41883648 }
    },
    "slowEffects": [ { "name": "bloom", "avgMs": 6.4, "maxMs": 11.2, "frames": 900 } ]
  }
}
```

Read it like this:

- **`totals.drawCalls` vs `runtime.load.drawCalls`.** The first is a static
  estimate from the scene graph; the second is the **measured whole-frame
  count**, including shadow-map and post-processing passes. A large gap is
  expected (the bloom pipeline and shadows are not scene-graph objects) — but a
  gap that *grows* points at a pass doing more work over time.
- **`runtime.load.frameCalls`** is how many `render()` invocations made up the
  frame — i.e. how many passes ran.
- **Geometry-bound vs CPU-bound:** compare `triangles` against `drawCalls`. Many
  draw calls and few triangles means CPU-bound (batching will help — see
  `/api/query/memory`). The reverse means geometry-bound (decimate).
- `slowObjects` ranks *static* primitive cost, not frame time. `runtime` is the
  only place real milliseconds appear.
- **`runtime.environment`** records which browser produced those numbers — frame
  timings only compare across machines when you know the machine. `userAgentData`
  is Chromium-only, so `null` means Firefox or Safari; it carries the low-entropy
  hints only (brands, `mobile`, `platform`), not `architecture` or
  `platformVersion`, which are async.

## Memory — registry, leaks, instancing candidates

```
GET /api/query/memory
```

```json
{
  "totals": { "objects": 412, "geometries": 38, "materials": 31, "textures": 12,
              "geometryBytes": 35900000, "textureBytes": 7800000, "textureBytesEstimated": true },
  "gpu": { "geometries": 44, "textures": 19, "programs": 33, "totalBytes": 48200000 },
  "geometries": [], "materials": [], "textures": [],
  "truncated": { "geometries": 0, "materials": 0, "textures": 0 },
  "leakCandidates": [
    { "uuid": "…", "kind": "texture", "name": "studio_hdr", "type": "Texture",
      "firstSeenMs": 12040, "lastSeenMs": 88120, "observations": 14,
      "disposeHint": "texture.dispose()" }
  ],
  "instancingCandidates": [
    { "geometryUuid": "…", "objectCount": 24, "triangles": 7200,
      "drawCallsNow": 24, "drawCallsAfter": 1, "names": ["Rock_1", "Rock_2"] }
  ],
  "notes": ["…"]
}
```

- **`gpu` vs `totals` is the leak signal.** `gpu.geometries` / `gpu.textures`
  come from `renderer.info.memory` and only decrement on a real `.dispose()`.
  They count what is resident on the GPU. A persistent gap between `gpu` and the
  scene-referenced `totals` means something is still resident that the scene no
  longer references.
- **`leakCandidates` is a differential heuristic, not a verdict.** three exposes
  no way to enumerate every live texture, so a resource can only be recognised
  as "gone" by comparing one walk against earlier ones. **Query twice** — before
  and after the action you suspect — or the list will be empty simply because
  this is the first walk.
- **`instancingCandidates`** groups separate meshes sharing one geometry+material
  that could collapse into a single `InstancedMesh` (`drawCallsNow` → 1). It
  cannot see two meshes with *identical-looking but distinct* geometries — this
  app keys its own batching on the Blender object name, so identically-shaped
  objects with different names never collide.

## Draw-call dependency map

```
GET /api/query/drawcalls
```

One entry per drawable object — its draw calls, its materials, and each
material's bound textures — heaviest first. This is the view that exposes a
single expensive object (`drawCalls: 15` on one mesh), which no aggregate total
can show. `totals.measuredFrameDrawCalls` is the measured ground truth to check
the estimate against.

## Shader — source, uniforms, feature slots

```
GET /api/query/shader?object=Terrain
GET /api/query/shader?object=$0&maxChars=40000
```

```json
{
  "object": { "uuid": "…", "name": "Terrain", "type": "Mesh" },
  "material": { "uuid": "…", "name": "MeshPhysicalNodeMaterial", "type": "…" },
  "language": "wgsl",
  "source": "captured",
  "vertexShader": "@vertex fn main(…",
  "fragmentShader": "@fragment fn main(…",
  "truncated": false,
  "uniforms": {
    "from": "node-builder",
    "entries": [ { "name": "uPlayerPosition", "type": "vec3", "value": [1.2, 0, -4.5] } ]
  },
  "features": {
    "defines": [],
    "materialDefines": null,
    "activeSlots": [ { "slot": "map", "kind": "texture" }, { "slot": "emissiveNode", "kind": "node" } ]
  },
  "notes": ["…"], "warnings": []
}
```

**This is a WebGPU renderer, and that changes three things the original design
assumed. Read this before interpreting the response:**

1. **The source is WGSL, not GLSL.** `language` says which. There is no GLSL
   preprocessor in WGSL, so `features.defines` is normally empty — that is
   correct, not a bug.
2. **`features.activeSlots` is the real "which defines are on" signal.** TSL
   expresses features by which slots are wired, not by `#define`. It lists
   populated map slots, wired TSL nodes, and booleans that are `true`.
3. **Materials here have no `.uniforms` table.** `NodeMaterial` keeps uniforms in
   the node graph, and some (e.g. the collider's pulse) live in closures the
   material never sees. `uniforms.from` says where values came from:
   - `"node-builder"` — live values read from the compiled builder. This is the
     useful one. **The values are real; the names are not.** TSL emits synthetic
     names (`nodeUniform0`, `nodeUniform1`, …), so match a uniform by its value
     and position in the list, not by reading its name.
   - `"material.uniforms"` — a `ShaderMaterial` uniform table. Rare here.
   - `"none"` — the object has not been rendered yet, so nothing was captured.
     Render it once and re-query.

**On `maxChars`:** truncation clips from the *start*, and a compiled shader opens
with licence and directive comments — so a small cap returns only the header,
with `truncated: true` and none of the actual code. Typical sizes here are ~3KB
vertex / ~24KB fragment, so the 400,000 default covers them whole. Raise the cap
rather than lowering it; use a small one only to confirm which shader variant is
in play.

**Use this to separate "bad shader code" from "bad data":** if the source looks
right and the value in `uniforms.entries` is wrong, the bug is in JavaScript, not
GLSL/TSL.

`source: "captured"` means the shader came from an actually-rendered pipeline
variant. `"compiled-on-demand"` means it was compiled for this query and
reflects the default render context, not necessarily the variant in use.

---

# Optimization heuristics (WebGPU)

The queries above say *what* is expensive. These are the levers that actually
change it, most-impactful first. Each is a change to app code, not a query — use
`/api/mutation/eval` to prototype against the live scene, then edit the source.

## Swapping in `WebGPURenderer` is not itself the optimization

Simply replacing `WebGLRenderer` with `WebGPURenderer` does not yield massive
gains. The win is moving CPU-bound work — particle systems, flocking physics,
procedural terrain, anything looping per-entity in JavaScript — onto the GPU as
a **compute shader** written in TSL (Three Shader Language). The power is in the
offload, not the backend.

This app already runs TSL end to end: `/api/query/shader` answering
`language: "wgsl"` with `uniforms.from: "node-builder"` is the fingerprint.

Where to look: low `triangles` but high `frameMs` and a *modest*
`runtime.load.drawCalls` means the cost is simulation on the CPU, not
rasterization — that is your compute-shader candidate.

## CPU timings are not GPU timings

`runtime.framerate` and `runtime.slowEffects` are built from
`performance.now()`, so they include JavaScript overhead and queue wait. They
tell you *a frame* was slow, not *which pass* was slow. The GPU timestamp query
is the ground truth, and it needs the renderer constructed with:

```js
new WebGPURenderer({ trackTimestamp: true })
```

then `await renderer.resolveTimestampsAsync()` after a pass to read the exact
GPU milliseconds for compute and render work. If `slowEffects` blames a pass
that the timestamp says is cheap, the cost is in JS, not the shader.

## Consolidate draw calls (target < 100)

CPU→GPU draw calls stay expensive under WebGPU. Two tools:

- **`InstancedMesh`** for many copies of one geometry — grass, debris, rocks.
  `/api/query/memory` already ranks exactly these as `instancingCandidates`,
  with the projected `drawCallsNow → drawCallsAfter`. Treat that list as the
  work queue.
- **`BatchedMesh`** to merge *varied* geometries into a single call. Reach for
  it when `instancingCandidates` is empty yet `/api/query/drawcalls` still shows
  many small objects sharing a material — distinct geometries don't collide in
  the instancing heuristic.

Verify against the measured number, not the estimate: re-run
`/api/query/performance` and compare `runtime.load.drawCalls` (whole frame,
passes included) before and after.

## VRAM-optimized asset formats

`totals.textureBytes` is the number to watch. Full-resolution PNG/JPG decodes
into uncompressed VRAM and dominates memory bandwidth at sample time.

- **KTX2** keeps textures compressed *on the GPU*, which is the single biggest
  VRAM lever — the texture is never blown out to raw RGBA.
- **Draco / Meshopt** compress the geometry payloads that show up as
  `geometryBytes` and `load.memory.attributesSize`.

Confirm through `/api/query/memory`: `gpu.textures` and `gpu.totalBytes` come
from `renderer.info.memory` and count only what the GPU actually holds, so they
are the honest before/after.

## Dispose, or the tab crashes

WebGPU memory leaks crash browser tabs. Three.js does **not** garbage-collect
unused GPU assets; a removed mesh's geometry, material and textures stay
resident until you release them explicitly:

```js
geometry.dispose()
material.dispose()
texture.dispose()
```

The two queries that catch this:

- `/api/query/memory` **`gpu` vs `totals`** — a persistent gap is unreferenced
  but still-resident memory.
- **`leakCandidates`** — a differential walk, not a verdict. Query *twice*,
  before and after the suspected action, or the list is empty merely because it
  was the first walk.

`/api/mutation/dispose` performs the subtree disposal for you. For entities
spawned and destroyed repeatedly, prefer **object pooling** — reuse the
instances and never dispose on the hot path at all.

---

# Mutations

> **Local only.** These routes refuse non-loopback callers and cross-origin
> browser requests, and the editor disables them outside a dev build. `eval`
> executes arbitrary JavaScript in the page — treat it as RCE by design.
>
> **A mutation lands on every connected editor** unless you pass `?editor=`.
> That is what makes "run this probe on all three devices" work — and it means
> an `eval` runs everywhere at once, while a `patch` that throws on one device
> leaves the tabs silently divergent with no rollback. Check the envelope's
> `partial` before assuming they still agree.

## Patch — RFC 6902 JSON Patch

```
POST /api/mutation/patch
Content-Type: application/json

{
  "object": "player",
  "patch": [
    { "op": "replace", "path": "/position/y", "value": 15 },
    { "op": "replace", "path": "/material/wireframe", "value": true },
    { "op": "test",    "path": "/visible", "value": true }
  ]
}
```

**Paths are relative to `object`** when you pass one, and the first token is a
selector otherwise: `"/player/position/y"` ≡ `{"object":"player"}` +
`"/position/y"`. `~0` → `~`, `~1` → `/`. Supported ops: `add`, `remove`,
`replace`, `move`, `copy`, `test`.

```json
{ "reqID": "patch_1a2b", "ok": true, "result": {
    "count": 1, "expected": 1, "partial": false, "timedOut": false, "warnings": [],
    "responses": [
      { "editor": { "label": "macOS · Chrome · /production" }, "ok": true, "elapsedMs": 1,
        "result": {
          "applied": 3, "partial": false, "rebuildRisk": ["/material/wireframe"],
          "target": { "uuid": "…", "name": "player", "type": "Group" },
          "results": [ { "op": "replace", "path": "/position/y", "ok": true, "previous": 0 } ]
        } }
    ] } }
```

- **`partial: true` means an op failed and the rest were skipped — the scene is
  left partly modified.** Ops run in order and the patch stops at the first
  failure; it does not roll back. `results` says exactly how far it got.
- **Two different `partial`s.** The one inside `responses[].result` is the
  patch's own (an op failed on that device); the one on the envelope means *some
  editor's whole answer failed*. Both being `false` is the only "clean" reading.
- **`rebuildRisk`** lists paths whose change likely altered three's pipeline
  cache key (e.g. toggling `wireframe` or `side`, or a value crossing zero),
  forcing a shader rebuild that allocates a new GPU pipeline. Check
  `/api/query/memory` afterwards — a rebuild is exactly the kind of thing that
  shows up there as growth.
- After a patch, world matrices are refreshed, so a following
  `/api/query/scene` reflects the change immediately.

## Eval — run a snippet

```
POST /api/mutation/eval
Content-Type: application/json

{ "object": "player", "code": "return $0.position.y" }
```

In scope: `$0`, `scene`, `camera`, `gl`, `THREE`, `requestAnimationFrame`.

**The snippet must `return` what you want back** — the body is a function body,
not an expression. `$0.position.y` alone returns `null`.

```json
{ "reqID": "eval_9x8y", "ok": true, "result": {
    "count": 2, "expected": 2, "partial": false, "timedOut": false, "warnings": [],
    "responses": [
      { "editor": { "label": "macOS · Chrome · /production" }, "ok": true, "elapsedMs": 2,
        "result": { "ok": true, "result": [0, 1.8, 0], "elapsedMs": 1.42,
                    "target": { "uuid": "…", "name": "player", "type": "Group" } } },
      { "editor": { "label": "iOS · Safari · /production" }, "ok": true, "elapsedMs": 3,
        "result": { "ok": true, "result": [0, 1.8, 0], "elapsedMs": 0.9,
                    "target": { "uuid": "…", "name": "player", "type": "Group" } } }
    ] } }
```

This is the sharpest tool for comparing devices: the same snippet runs on every
editor at once, so `return navigator.userAgentData` or a timing probe comes back
once per device. Add `?editor=` to run it on just one.

Values are projected onto JSON-safe data: textures, matrices and typed arrays
become short descriptors, `Object3D` becomes `{ "object3D": uuid }`, depth is
capped.

## Dispose — free a subtree

```
POST /api/mutation/dispose
Content-Type: application/json

{ "object": "Rock_14" }
```

Detaches the subtree from its parent and disposes every geometry, material and
texture it referenced (deduped by identity). This is the remedy for a
`leakCandidates` entry.

```json
{ "reqID": "dispose_1", "ok": true, "result": {
    "count": 1, "expected": 1, "partial": false, "timedOut": false, "warnings": [],
    "responses": [
      { "editor": { "label": "macOS · Chrome · /production" }, "ok": true, "elapsedMs": 4,
        "result": { "ok": true, "geometryCount": 2, "materialCount": 2, "textureCount": 1,
                    "detachedFrom": "scene", "target": { "uuid": "…", "name": "Rock_14" } } }
    ] } }
```

**Destructive and not undoable by a patch.** It refuses the scene root — dispose
a subtree, not the world. Disposed resources are dropped from the leak registry,
so re-querying `/api/query/memory` should show the candidate cleared.

**Always pass `?editor=` to `dispose` unless you mean it.** Fanned out, this
frees the same subtree on every connected tab at once — including the phone in
the other room you then have to walk over and reload.

---

# Worked example: frame drops after an avatar swap

```bash
# 0. Who is answering? These are the labels `?editor=` takes.
curl -s localhost:4343/api/editors | jq '.editors[] | {label, viewport, devicePixelRatio}'

# 1. Baseline across every device at once. Is it drawing, or CPU-bound?
#    One responses[] entry per connected editor.
curl -s localhost:4343/api/query/performance | jq '
  .result.responses[] | { who: .editor.label,
    fps: .result.runtime.framerate.fps, frameMs: .result.runtime.framerate.frameMs,
    drawCalls: .result.runtime.load.drawCalls, passes: .result.runtime.load.frameCalls }'
#    A device stuck at a low fps while the others sit at 60 is the one to chase.

# 2. Which object costs the most draw calls? Ask one device — the counts are
#    per-scene, and a phone may legitimately differ.
curl -s 'localhost:4343/api/query/drawcalls?editor=mac' | jq '.result.responses[0].result.objects[:5]'

# 3. Nothing looks heavy in the scene graph, but the measured count is far
#    higher — the gap is passes. Check effect timing on the slowest device.
curl -s 'localhost:4343/api/query/performance?editor=safari' \
  | jq '.result.responses[0].result.runtime.slowEffects'

# 4. Confirm the shader isn't the problem: read it, then its live uniform values.
#    Name the object outright. `$0` would work here too, but it is per-tab and
#    only set once that tab has addressed something, so it is null on a fresh
#    tab — and aiming it at several editors would read a different object on each.
curl -s 'localhost:4343/api/query/shader?object=buildibng&editor=mac' \
  | jq '.result.responses[0].result | .language, .uniforms.from, .uniforms.entries[:5]'

# 5. Hypothesis test: hide the suspect and re-measure, without editing code.
#    No `?editor=` — this hides it everywhere, which is what we want for a
#    before/after that is comparable across devices.
curl -s -X POST localhost:4343/api/mutation/patch \
  -H 'Content-Type: application/json' \
  -d '{"patch":[{"op":"replace","path":"/Tree/visible","value":false}]}'
curl -s localhost:4343/api/query/performance \
  | jq '.result.responses[] | {who: .editor.label, drawCalls: .result.runtime.load.drawCalls}'

# 6. Undo.
curl -s -X POST localhost:4343/api/mutation/patch \
  -H 'Content-Type: application/json' \
  -d '{"patch":[{"op":"replace","path":"/Tree/visible","value":true}]}'

# 7. Memory: was anything leaked? Query once, do the thing, query again —
#    compare `gpu` against `totals` on the same device both times.
curl -s 'localhost:4343/api/query/memory?editor=mac' \
  | jq '.result.responses[0].result | .totals, .gpu'   # both times

# 8. Confirm the change landed everywhere before moving on. `partial` on the
#    envelope means at least one tab disagreed.
curl -s localhost:4343/api/query/performance | jq '{count: .result.count, partial: .result.partial}'
```
