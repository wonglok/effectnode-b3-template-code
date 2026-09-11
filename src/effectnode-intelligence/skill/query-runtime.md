# Query Runtime

Inspect and patch the live Three.js scene running in the browser at
`http://localhost:4343`.

The backend holds no scene state. Every request is forwarded over a WebSocket to
a connected **editor** — a browser tab running the app with the Dev or Preview
page open — and the editor's answer is relayed back. So: **the app must be open
in a browser, or every query returns 503.**

## Check health first

```
GET http://localhost:4343/api/health
```

```json
{ "uptime": 41203, "editors": 1, "warning": "…" }
```

`editors` is how many tabs can answer. Requests are broadcast to all of them and
**the first reply wins**, so with `editors > 1` results are not deterministic —
a mutation may land in a tab you are not looking at. Close the extra tabs.

## Failure modes

| Status | Meaning |
|---|---|
| `503 no editor connected` | No tab is open, or it hasn't connected yet. |
| `503 editor disconnected before answering` | The tab closed mid-request (often an HMR reload). |
| `504 <facet> request timed out` | An editor was connected but never answered within 15s. |
| `502` | The editor answered, but failed — usually a bad selector or a collector error. The message says which. |
| `403` | You called a mutation from a non-local origin. |

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

# Mutations

> **Local only.** These routes refuse non-loopback callers and cross-origin
> browser requests, and the editor disables them outside a dev build. `eval`
> executes arbitrary JavaScript in the page — treat it as RCE by design.

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
    "applied": 3, "partial": false, "rebuildRisk": ["/material/wireframe"],
    "target": { "uuid": "…", "name": "player", "type": "Group" },
    "results": [ { "op": "replace", "path": "/position/y", "ok": true, "previous": 0 } ]
} }
```

- **`partial: true` means an op failed and the rest were skipped — the scene is
  left partly modified.** Ops run in order and the patch stops at the first
  failure; it does not roll back. `results` says exactly how far it got.
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
    "ok": true, "result": [0, 1.8, 0], "elapsedMs": 1.42,
    "target": { "uuid": "…", "name": "player", "type": "Group" }
} }
```

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
    "ok": true, "geometryCount": 2, "materialCount": 2, "textureCount": 1,
    "detachedFrom": "scene", "target": { "uuid": "…", "name": "Rock_14" }
} }
```

**Destructive and not undoable by a patch.** It refuses the scene root — dispose
a subtree, not the world. Disposed resources are dropped from the leak registry,
so re-querying `/api/query/memory` should show the candidate cleared.

---

# Worked example: frame drops after an avatar swap

```bash
# 1. Baseline. Is it drawing or CPU-bound?
curl -s localhost:4343/api/query/performance | jq '.totals, .runtime.load.drawCalls, .runtime.framerate'

# 2. Which object costs the most draw calls?
curl -s localhost:4343/api/query/drawcalls | jq '.objects[:5]'

# 3. Nothing looks heavy in the scene graph, but the measured count is far higher
#    — the gap is passes. Check effect timing.
curl -s localhost:4343/api/query/performance | jq '.runtime.slowEffects'

# 4. Confirm the shader isn't the problem: read it, then its live uniform values.
curl -s 'localhost:4343/api/query/shader?object=$0' | jq '.language, .uniforms.from, .uniforms.entries[:5]'

# 5. Hypothesis test: hide the suspect and re-measure, without editing code.
curl -s -X POST localhost:4343/api/mutation/patch \
  -H 'Content-Type: application/json' \
  -d '{"patch":[{"op":"replace","path":"/Tree/visible","value":false}]}'
curl -s localhost:4343/api/query/performance | jq '.runtime.load.drawCalls'

# 6. Undo.
curl -s -X POST localhost:4343/api/mutation/patch \
  -H 'Content-Type: application/json' \
  -d '{"patch":[{"op":"replace","path":"/Tree/visible","value":true}]}'

# 7. Memory: was anything leaked? Query once, do the thing, query again.
curl -s localhost:4343/api/query/memory | jq '.totals, .gpu'   # both times
```
