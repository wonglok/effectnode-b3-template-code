# Three.js AI Agent Debugging Tool: Feature Specification

## Overview

Building an AI agent capable of debugging and optimizing a 3D runtime environment requires bridging the gap between highly optimized, cyclic JavaScript/WebGL objects and the linear, text-based reasoning engine of a Large Language Model (LLM). This specification outlines the core features required for a robust Three.js Agent Debugging Tool.

The tool operates on a **pull-and-patch** methodology. Rather than streaming the entire state of the engine (which would exceed context windows and crash the agent), it exposes a suite of modular introspection tools and a standardized mutation API.

---

## 1. Scene Graph & Spatial Context Translation

Agents cannot naturally interpret visual 3D spaces or parse cyclic object graphs. The Scene Graph feature acts as a translator, providing the agent with an acyclic, text-friendly understanding of the 3D world.

### 1.1. Acyclic Hierarchy Extraction

- **Description:** A method to extract the scene tree without massive geometry data or circular references (e.g., `parent -> child -> parent`).
- **Agent Utility:** Allows the agent to understand the "What" and "Where" of the scene hierarchy.
- **Data Payload Example:**
    ```json
    {
        "uuid": "A1B2-C3D4",
        "name": "PlayerCharacter",
        "type": "Group",
        "children": ["uuid-mesh-1", "uuid-light-2"]
    }
    ```

### 1.2. Absolute Spatial Bounding Boxes

- **Description:** Exposing computed `THREE.Box3` data in world space, rather than forcing the agent to multiply local transform matrices.
- **Agent Utility:** Gives the agent spatial awareness to answer prompts like "Place the apple on the table without clipping through the wall." The agent can read the min/max coordinates of both objects' bounding boxes to calculate the precise `y` offset needed.

### 1.3. Culling & Visibility Flags

- **Description:** Surfacing critical rendering flags such as `visible`, `castShadow`, `receiveShadow`, `frustumCulled`, and `renderOrder`.
- **Agent Utility:** Enables the agent to diagnose issues like "Why is my shadow missing?" or "Why does this object disappear when I pan the camera?"

---

## 2. Memory Management & Resource Tracking

Memory leaks are notoriously difficult to track in WebGL applications because JavaScript garbage collection does not automatically clear GPU buffers. This feature gives the agent deep insight into VRAM usage.

### 2.1. Centralized Asset Registries

- **Description:** Exposes tracked arrays of active `THREE.BufferGeometry`, `THREE.Material`, and `THREE.Texture` instances.
- **Agent Utility:** Allows the agent to query the total footprint of loaded assets and check if multiple meshes are unnecessarily duplicating heavy textures.

### 2.2. Orphan Resource Detection

- **Description:** A diagnostic tool that cross-references loaded GPU resources against the active Scene Graph.
- **Agent Utility:** The agent can detect resources that are in memory but not attached to any active scene node. It can then automatically suggest or inject the missing `.dispose()` calls to free up memory.

### 2.3. Instancing Optimization Analysis

- **Description:** Scans the scene graph for multiple `Mesh` objects using identical `Geometry` and `Material` combinations.
- **Agent Utility:** The agent flags these instances as optimization targets and can propose a code refactor to consolidate them into a single `THREE.InstancedMesh`, drastically reducing GPU draw calls.

---

## 3. Real-Time Performance Profiling

Streaming 60fps telemetry is impractical. This feature set aggregates performance data into on-demand snapshots that the agent can request when diagnosing frame drops.

### 3.1. Engine Render Metrics

- **Description:** Direct extraction from `renderer.info.render`, capturing `calls` (draw calls), `triangles`, `points`, and `lines`.
- **Agent Utility:** The agent can establish a performance baseline and determine if a scene is geometry-bound (too many triangles) or CPU-bound (too many draw calls). Note: The tool must aggregate these calls across _all_ render passes (e.g., shadow maps, post-processing) for an accurate total.

### 3.2. Sliding Window Frame Timing

- **Description:** Provides an average CPU and GPU frame time over a sliding window (e.g., the last 100 frames) instead of a single instantaneous millisecond reading.
- **Agent Utility:** Prevents the agent from acting on anomalous frame spikes (like asset loading hitches) and provides a reliable metric of sustained performance.

### 3.3. Draw Call Dependency Mapping

- **Description:** A graph mapping meshes to materials, and materials to textures, specifically highlighting which combinations generate the most draw calls.
- **Agent Utility:** Allows the agent to trace a heavy render sequence back to its source asset (e.g., identifying a specific multi-material mesh that is triggering 15 separate draw calls per frame).

---

## 4. Shader & Material Introspection

To debug visual anomalies (e.g., black meshes, broken lighting, inverted normals), the agent requires access to the low-level rendering instructions sent to the GPU.

### 4.1. Compiled GLSL/TSL Extraction

- **Description:** Intercepts WebGL Program creation to extract the final, compiled vertex and fragment shader strings. In WebGPU contexts, it extracts the reconstructed Three.js Shading Language (TSL) nodes.
- **Agent Utility:** The agent can read the actual math being executed on the GPU to find syntax errors, precision issues, or logic flaws in custom shaders.

### 4.2. Active Uniform Snapshots

- **Description:** Captures the current values of variables being passed to the shader (e.g., `u_time`, `u_resolution`, light colors, camera positions).
- **Agent Utility:** Allows the agent to verify if a visual bug is caused by the shader code itself or by incorrect uniform data being passed in from JavaScript.

### 4.3. Material `#define` Configurations

- **Description:** Three.js dynamically recompiles shaders based on active material flags (e.g., `#define USE_ENVMAP`). This feature surfaces the active defines for a given material.
- **Agent Utility:** The agent can debug why certain lighting features or textures are failing to render by verifying if the necessary shader constants were successfully injected during compilation.

---

## 5. Safe Mutation & Execution API

Diagnosis is only half the battle; the agent must be able to test its hypotheses. Instead of rewriting the entire application, this API provides surgical mutation tools.

### 5.1. JSON Patch Application

- **Description:** An endpoint that accepts JSON Patch arrays (RFC 6902) to mutate the live scene state safely.
- **Agent Utility:** The agent can tweak positions, colors, and flags instantly without refreshing the page or altering source files.
- **Payload Example:**
    ```json
    [
        { "op": "replace", "path": "/uuid-1234/position/y", "value": 15 },
        { "op": "replace", "path": "/uuid-5678/material/wireframe", "value": true }
    ]
    ```

### 5.2. Targeted REPL Injection

- **Description:** A restricted JavaScript execution environment where the agent can run small snippets of code against the runtime.
- **Agent Utility:** Allows the agent to perform complex queries or mutations that are difficult to express in JSON patch format. Useful bindings (like `$0` for the currently selected object) should be provided to the agent's REPL environment.
