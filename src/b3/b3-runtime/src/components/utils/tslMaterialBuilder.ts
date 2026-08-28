import * as THREE from "three/webgpu";
import { vec3, texture as tslTexture, uv as tslUV } from "three/tsl";
import type { GeoBuffer } from "../types/blenderTypes";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single input socket on a Blender shader node. */
interface BlenderSocket {
  name: string;
  /** Value when the socket is not connected (may be number, array, string). */
  value?: unknown;
  /** Connected node ID + output socket name. */
  fromNode?: string;
  fromSocket?: string;
}

/** A single color stop in a Blender Color Ramp. */
interface ColorStop {
  position: number;
  color: [number, number, number, number]; // RGBA
}

/** Serialised Color Ramp data from a VALTORGB node. */
interface ColorRampData {
  interpolation: string; // 'LINEAR' | 'CONSTANT' | 'EASE'
  stops: ColorStop[];
}

/** Serialized Blender shader node. */
interface BlenderNode {
  id: string;
  type: string;
  label: string;
  /** Color Ramp data — present on VALTORGB nodes. */
  colorRamp?: ColorRampData;
  inputs: BlenderSocket[];
}

/** The full shader graph for one material. */
export interface ShaderGraph {
  nodes: BlenderNode[];
}

/** Material parameters extracted from the shader graph. */
export interface TSLMaterialParams {
  geometry: THREE.BufferGeometry;
  graph?: ShaderGraph;
  color: [number, number, number];
  roughness: number;
  metalness: number;
  emissiveColor: [number, number, number];
  emissiveIntensity: number;
  map: THREE.Texture | null;
  roughnessMap: THREE.Texture | null;
  metalnessMap: THREE.Texture | null;
  normalMap: THREE.Texture | null;
  emissiveMap: THREE.Texture | null;
  transparent: boolean;
  opacity: number;
  alphaTest: number;
  flatShading: boolean;
  /** True (default) renders both sides — matches Blender's double-sided default. */
  doubleSided?: boolean;
  // Physical material properties
  transmission: number;
  transmissionMap: THREE.Texture | null;
  thickness: number;
  thicknessMap: THREE.Texture | null;
  ior: number;
  clearcoat: number;
  clearcoatRoughness: number;
  clearcoatMap: THREE.Texture | null;
  clearcoatRoughnessMap: THREE.Texture | null;
  clearcoatNormalMap: THREE.Texture | null;
  sheen: number;
  sheenRoughness: number;
  sheenColor: [number, number, number];
  sheenColorMap: THREE.Texture | null;
  sheenRoughnessMap: THREE.Texture | null;
  specularIntensity: number;
  specularColor: [number, number, number];
  specularColorMap: THREE.Texture | null;
  specularIntensityMap: THREE.Texture | null;
  iridescence: number;
  iridescenceMap: THREE.Texture | null;
  iridescenceIOR: number;
  iridescenceThicknessRange: [number, number];
  iridescenceThicknessMap: THREE.Texture | null;
  anisotropy: number;
  anisotropyMap: THREE.Texture | null;
  attenuationDistance: number;
  attenuationColor: [number, number, number];
}

// ---------------------------------------------------------------------------
// Color Ramp — canvas-based gradient texture
// ---------------------------------------------------------------------------

/** Cached gradient textures keyed by a hash of the stop data. */
const _rampTextureCache = new Map<string, THREE.CanvasTexture>();

function generateColorRampTexture(
  stops: ColorStop[],
  _interpolation: string,
): THREE.CanvasTexture {
  const hash = JSON.stringify({ stops });
  const cached = _rampTextureCache.get(hash);
  if (cached) {
    cached.needsUpdate = true;
  }
  if (cached) return cached;

  const width = 256;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;

  const grad = ctx.createLinearGradient(0, 0, width, 0);
  for (const stop of stops) {
    const r = Math.round(stop.color[0] * 255);
    const g = Math.round(stop.color[1] * 255);
    const b = Math.round(stop.color[2] * 255);
    const a = stop.color.length >= 4 ? stop.color[3] : 1;
    grad.addColorStop(stop.position, `rgba(${r},${g},${b},${a})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  _rampTextureCache.set(hash, tex);
  return tex;
}

function evaluateColorRampAt(
  factor: number,
  stops: ColorStop[],
  interpolation: string,
): [number, number, number] {
  const t = Math.max(0, Math.min(1, factor));

  for (let i = 0; i < stops.length - 1; i++) {
    const p0 = stops[i].position;
    const p1 = stops[i + 1].position;
    if (t < p0 || t > p1) continue;

    const range = p1 - p0;
    if (Math.abs(range) < 0.00001)
      return stops[i].color.slice(0, 3) as [number, number, number];

    let segT = (t - p0) / range;
    if (interpolation === "CONSTANT") segT = segT >= 0.5 ? 1 : 0;
    else if (interpolation === "EASE") segT = segT * segT * (3 - 2 * segT);

    return [
      stops[i].color[0] + (stops[i + 1].color[0] - stops[i].color[0]) * segT,
      stops[i].color[1] + (stops[i + 1].color[1] - stops[i].color[1]) * segT,
      stops[i].color[2] + (stops[i + 1].color[2] - stops[i].color[2]) * segT,
    ];
  }

  const last = stops[stops.length - 1];
  return last.color.slice(0, 3) as [number, number, number];
}

/** Marker returned by VALTORGB evaluation to signal a ramp texture override. */
interface RampTextureMarker {
  __rampTexture: true;
  texture: THREE.CanvasTexture;
  constantColor?: [number, number, number];
}

// ---------------------------------------------------------------------------
// Recursive shader graph evaluator
// ---------------------------------------------------------------------------

/** Union of possible results from a single node evaluation. */
type EvalResult = unknown;

/**
 * Recursively evaluate one Blender shader node by walking upstream connections.
 *
 * Each node resolves its inputs by recursing into connected nodes — a true
 * recursive tree loop with automatic cycle detection via the `visited` set.
 */
function evaluateNode(
  graph: ShaderGraph,
  visited: Set<string>,
  nodeId: string,
): EvalResult {
  // Cycle guard — a node referencing itself (or a cycle) returns undefined.
  if (visited.has(nodeId)) return undefined;
  visited.add(nodeId);

  // console.log(graph);

  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node) return undefined;

  // Resolve an input socket: if connected → recurse; otherwise → default value.
  const getInput = (socketName: string): EvalResult => {
    const sock = node.inputs.find((s) => s.name === socketName);
    if (!sock) return undefined;
    if (sock.fromNode) {
      const up = evaluateNode(graph, new Set(visited), sock.fromNode);
      // Multi-output upstream (SEPXYZ) — pick the named socket.
      if (
        up &&
        typeof up === "object" &&
        !Array.isArray(up) &&
        sock.fromSocket &&
        sock.fromSocket in (up as Record<string, unknown>)
      ) {
        return (up as Record<string, unknown>)[sock.fromSocket];
      }
      return up;
    }
    return sock.value as EvalResult;
  };

  // ------------------------------------------------------------------
  // Per-node-type dispatching (recursive descent)
  // ------------------------------------------------------------------
  switch (node.type) {
    // -- Terminal: follow the Surface link ----------------------------
    case "output-material":
      return getInput("surface");

    // -- Principled BSDF — collect top-level material parameters ------
    case "bsdf-principled":
      return {
        baseColor: getInput("base-color"),
        roughness: getInput("roughness"),
        metallic: getInput("metallic"),
        emissionColor: getInput("emission-color"),
        emissionStrength: getInput("emission-strength"),
        alpha: getInput("alpha"),
        normal: getInput("normal"),
        // Physical properties
        transmission: getInput("transmission"),
        transmissionRoughness: getInput("transmission-roughness"),
        ior: getInput("ior"),
        clearcoat: getInput("clearcoat"),
        clearcoatRoughness: getInput("clearcoat-roughness"),
        sheen: getInput("sheen"),
        sheenRoughness: getInput("sheen-roughness"),
        sheenTint: getInput("sheen-tint"),
        specular: getInput("specular"),
        specularTint: getInput("specular-tint"),
        anisotropic: getInput("anisotropic"),
        anisotropicRotation: getInput("anisotropic-rotation"),
      };

    // -- Image Texture — return a TSL marker with UV awareness ---------
    case "tex-image": {
      const imageName = getInput("image") as string | undefined;
      const vecInput = getInput("vector");
      // Check if Vector is connected to a Texture Coordinate / UV Map node
      const useTexCoord =
        vecInput &&
        typeof vecInput === "object" &&
        "_isTexCoord" in (vecInput as any);
      return {
        _isTSLTexture: true,
        imageName,
        useTexCoord: !!useTexCoord,
      };
    }

    // -- Normal Map ---------------------------------------------------
    case "normal-map": {
      const strength = (getInput("strength") as number) ?? 1.0;
      const color = getInput("color") as string | undefined;
      return { type: "normalMap", strength, color };
    }

    // -- Mix RGB — blend two inputs -----------------------------------
    case "mix-rgb": {
      const fac = (getInput("fac") as number) ?? 0.5;
      const a = getInput("color1");
      const b = getInput("color2");
      return { type: "mix", fac, a, b };
    }

    // -- Math node — arithmetic ---------------------------------------
    case "math": {
      const a = (getInput("value") as number) ?? 0;
      const b = (getInput("value-001") as number) ?? a;
      const op = (node.label || "ADD").toUpperCase();
      return { type: "math", op, a, b };
    }

    // -- Bump map -----------------------------------------------------
    case "bump": {
      return {
        type: "bump",
        strength: (getInput("strength") as number) ?? 1.0,
        distance: (getInput("distance") as number) ?? 0.1,
        height: getInput("height"),
      };
    }

    // -- Texture Coordinate / UV Map → TSL uv() node -------------------
    case "tex-coord":
    case "uvmap":
      return { _isTexCoord: true };

    // -- Color Ramp / ValToRGB ----------------------------------------
    case "valtorgb": {
      const fac = getInput("fac") as number | undefined;
      const rampData = (node as BlenderNode & { colorRamp?: ColorRampData })
        .colorRamp;
      if (!rampData || !rampData.stops || rampData.stops.length < 2) {
        const fv = typeof fac === "number" ? fac : 0.5;
        return [fv, fv, fv] as number[];
      }
      const tex = generateColorRampTexture(
        rampData.stops,
        rampData.interpolation,
      );

      if (typeof fac === "number") {
        return {
          __rampTexture: true,
          texture: tex,
          constantColor: evaluateColorRampAt(
            fac,
            rampData.stops,
            rampData.interpolation,
          ),
        } satisfies RampTextureMarker;
      }
      return { __rampTexture: true, texture: tex } satisfies RampTextureMarker;
    }

    // -- Separate XYZ — returns per-component swizzle markers when ------
    // upstream is TSL-based, otherwise plain {X,Y,Z} values.
    case "sepxyz":
    case "seprgb": {
      const v = getInput("vector") ?? getInput("image");
      if (Array.isArray(v) && v.length >= 3) {
        return { x: v[0], y: v[1], z: v[2] };
      }
      // TSL-based upstream — wrap each output as a channel swizzle marker
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const swizzle = (ch: string) => ({
          _isSwizzled: true,
          source: v,
          channel: ch,
        });
        return {
          x: swizzle("r"),
          y: swizzle("g"),
          z: swizzle("b"),
        };
      }
      return { x: 0, y: 0, z: 0 };
    }

    // -- Combine XYZ — merge scalars → [x, y, z] ---------------------
    case "combxyz":
    case "combrgb": {
      return [
        (getInput("x") as number) ?? 0,
        (getInput("y") as number) ?? 0,
        (getInput("z") as number) ?? 0,
      ] as number[];
    }

    // -- Hue / Saturation / Value -------------------------------------
    case "hue-sat":
      return {
        type: "hueSat",
        hue: (getInput("hue") as number) ?? 0.5,
        saturation: (getInput("saturation") as number) ?? 1.0,
        value: (getInput("value") as number) ?? 1.0,
        color: getInput("color"),
      };

    // -- RGB Curves — pass-through ------------------------------------
    case "curve-rgb":
      return getInput("color") ?? ([0.5, 0.5, 0.5] as number[]);

    // -- Fallback — first connected or default input -------------------
    default:
      for (const sock of node.inputs) {
        if (sock.value !== undefined) return sock.value as EvalResult;
        if (sock.fromNode)
          return evaluateNode(graph, new Set(visited), sock.fromNode);
      }
      return undefined;
  }
}

/**
 * Entry point — walk the graph from OUTPUT_MATERIAL.
 * Returns whatever the output node chains to (typically BSDF params).
 */
function evaluateShaderGraph(
  graph: ShaderGraph,
): Record<string, unknown> | null {
  const outNode = graph.nodes.find((n) => n.type === "output-material");
  if (!outNode) return null;
  return evaluateNode(graph, new Set(), outNode.id) as Record<
    string,
    unknown
  > | null;
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

function _setStandardProperties(
  mat: THREE.MeshPhysicalNodeMaterial,
  params: TSLMaterialParams,
): void {
  mat.color.setRGB(params.color[0], params.color[1], params.color[2]);
  mat.roughness = params.roughness;
  mat.metalness = params.metalness;
  if (params.emissiveIntensity > 0) {
    // Bake intensity into emissive color so the TSL `emissive` builtin
    // (used by BloomNode) captures the full emissive contribution.
    const ei = params.emissiveIntensity;
    // mat.emissive.setRGB(
    //   params.emissiveColor[0] * ei,
    //   params.emissiveColor[1] * ei,
    //   params.emissiveColor[2] * ei,
    // );
    mat.emissiveIntensity = 1.0 * ei;
  }
  mat.emissiveMap = params.emissiveMap;
  mat.map = params.map;
  mat.roughnessMap = params.roughnessMap;
  mat.metalnessMap = params.metalnessMap;
  mat.normalMap = params.normalMap;
  mat.transparent = params.transparent;
  if (params.opacity < 1.0) mat.opacity = params.opacity;
  if (params.alphaTest > 0) mat.alphaTest = params.alphaTest;
  mat.flatShading = params.flatShading;
  // Blender renders both sides by default; honour "Backface Culling" → FrontSide.
  mat.side = (params.doubleSided ?? true) ? THREE.DoubleSide : THREE.FrontSide;

  // Physical material properties
  mat.transmission = params.transmission;
  if (params.transmissionMap) mat.transmissionMap = params.transmissionMap;
  mat.thickness = params.thickness;
  if (params.thicknessMap) mat.thicknessMap = params.thicknessMap;
  mat.ior = params.ior;
  mat.clearcoat = params.clearcoat;
  mat.clearcoatRoughness = params.clearcoatRoughness;
  if (params.clearcoatMap) mat.clearcoatMap = params.clearcoatMap;
  if (params.clearcoatRoughnessMap)
    mat.clearcoatRoughnessMap = params.clearcoatRoughnessMap;
  if (params.clearcoatNormalMap)
    mat.clearcoatNormalMap = params.clearcoatNormalMap;
  mat.sheen = params.sheen;
  mat.sheenRoughness = params.sheenRoughness;
  mat.sheenColor.setRGB(
    params.sheenColor[0],
    params.sheenColor[1],
    params.sheenColor[2],
  );
  if (params.sheenColorMap) mat.sheenColorMap = params.sheenColorMap;
  if (params.sheenRoughnessMap)
    mat.sheenRoughnessMap = params.sheenRoughnessMap;
  mat.specularIntensity = params.specularIntensity;
  mat.specularColor.setRGB(
    params.specularColor[0],
    params.specularColor[1],
    params.specularColor[2],
  );
  if (params.specularColorMap) mat.specularColorMap = params.specularColorMap;
  if (params.specularIntensityMap)
    mat.specularIntensityMap = params.specularIntensityMap;
  mat.iridescence = params.iridescence;
  if (params.iridescenceMap) mat.iridescenceMap = params.iridescenceMap;
  mat.iridescenceIOR = params.iridescenceIOR;
  mat.iridescenceThicknessRange = params.iridescenceThicknessRange;
  if (params.iridescenceThicknessMap)
    mat.iridescenceThicknessMap = params.iridescenceThicknessMap;
  mat.anisotropy = params.anisotropy;
  if (params.anisotropyMap) mat.anisotropyMap = params.anisotropyMap;
  mat.attenuationDistance = params.attenuationDistance;
  mat.attenuationColor.setRGB(
    params.attenuationColor[0],
    params.attenuationColor[1],
    params.attenuationColor[2],
  );
}

/**
 * Resolve a shader-graph marker to a TSL node.
 *
 *  _isTSLTexture  →  texture(map, uv())
 *  _isSwizzled    →  resolve source then apply channel swizzle (.r / .g / .b)
 */
function resolveTSLNode(marker: any, mapTex: THREE.Texture | null): any {
  if (!marker || typeof marker !== "object") return null;

  // Swizzle marker — resolve source first, then swizzle
  if (marker._isSwizzled) {
    const src = resolveTSLNode(marker.source, mapTex);
    if (!src) return null;
    const ch = marker.channel as string;
    // TSL supports .r .g .b .a and .x .y .z .w swizzles
    return (src as any)[ch];
  }

  // TSL texture marker
  if (marker._isTSLTexture && mapTex) {
    return tslTexture(mapTex, tslUV());
  }

  // Unknown object — assume it's already a TSL node
  return marker;
}

export function buildTSLMaterial(
  params: TSLMaterialParams,
): THREE.MeshPhysicalNodeMaterial {
  const { graph } = params;

  // ------------------------------------------------------------------
  // Shader graph path
  // ------------------------------------------------------------------
  if (graph && Array.isArray(graph.nodes) && graph.nodes.length > 0) {
    const mat = new THREE.MeshPhysicalNodeMaterial();
    _setStandardProperties(mat, params);

    const bsdf = evaluateShaderGraph(graph);
    const baseColor: any = bsdf?.baseColor;
    const roughnessInput: any = bsdf?.roughness;
    const metallicInput: any = bsdf?.metallic;

    // --- Resolve color node ---
    if (baseColor) {
      if (baseColor.__rampTexture) {
        const marker = baseColor as RampTextureMarker;
        if (marker.constantColor) {
          mat.color.setRGB(
            marker.constantColor[0],
            marker.constantColor[1],
            marker.constantColor[2],
          );
        } else {
          mat.map = marker.texture;
          mat.color.setRGB(1, 1, 1);
        }
      } else if (baseColor._isTSLTexture && params.map) {
        mat.colorNode = tslTexture(params.map, tslUV()) as any;
        mat.map = null; // clear legacy map — colorNode takes precedence
        mat.color.setRGB(1, 1, 1);
      } else if (typeof baseColor === "object" && !Array.isArray(baseColor)) {
        mat.colorNode = baseColor as ReturnType<typeof vec3>;
        mat.map = null; // clear legacy map — colorNode takes precedence
      }
    }

    // --- Roughness: swizzle marker (SEPXYZ Y→rough) or direct texture ---
    if (roughnessInput?._isSwizzled) {
      const node = resolveTSLNode(roughnessInput, params.roughnessMap);
      if (node) (mat as any).roughnessNode = node;
    } else if (params.roughnessMap) {
      (mat as any).roughnessNode = tslTexture(params.roughnessMap, tslUV());
    }

    // --- Metallic: swizzle marker or direct texture ---
    if (metallicInput?._isSwizzled) {
      const node = resolveTSLNode(metallicInput, params.metalnessMap);
      if (node) (mat as any).metalnessNode = node;
    } else if (params.metalnessMap) {
      (mat as any).metalnessNode = tslTexture(params.metalnessMap, tslUV());
    }

    // --- Other maps ---
    if (params.normalMap) mat.normalMap = params.normalMap;
    if (params.emissiveMap) {
      (mat as any).emissiveNode = tslTexture(params.emissiveMap, tslUV());
    }

    // --- Physical properties from shader graph ---
    const wireMapNode = (
      input: any,
      map: THREE.Texture | null,
      nodeProp: string,
    ) => {
      if (input?._isSwizzled) {
        const node = resolveTSLNode(input, map);
        if (node) (mat as any)[nodeProp] = node;
      } else if (map) {
        (mat as any)[nodeProp] = tslTexture(map, tslUV());
      }
    };

    const bsdfAny = bsdf as Record<string, any> | null;

    wireMapNode(
      bsdfAny?.transmission,
      params.transmissionMap,
      "transmissionNode",
    );
    wireMapNode(bsdfAny?.clearcoat, params.clearcoatMap, "clearcoatNode");
    wireMapNode(
      bsdfAny?.clearcoatRoughness,
      params.clearcoatRoughnessMap,
      "clearcoatRoughnessNode",
    );
    wireMapNode(bsdfAny?.sheen, params.sheenColorMap, "sheenNode");
    wireMapNode(
      bsdfAny?.sheenRoughness,
      params.sheenRoughnessMap,
      "sheenRoughnessNode",
    );
    wireMapNode(bsdfAny?.sheenTint, null, "sheenColorNode");
    wireMapNode(
      bsdfAny?.specular,
      params.specularIntensityMap,
      "specularIntensityNode",
    );
    wireMapNode(
      bsdfAny?.specularTint,
      params.specularColorMap,
      "specularColorNode",
    );
    wireMapNode(bsdfAny?.anisotropic, params.anisotropyMap, "anisotropyNode");
    wireMapNode(
      bsdfAny?.transmissionRoughness,
      params.thicknessMap,
      "thicknessNode",
    );

    if (bsdfAny?.ior && typeof bsdfAny.ior === "number") {
      mat.ior = bsdfAny.ior;
    }

    return mat;
  }

  // ------------------------------------------------------------------
  // No graph — standard MeshPhysicalNodeMaterial
  // ------------------------------------------------------------------
  const mat = new THREE.MeshPhysicalNodeMaterial();
  _setStandardProperties(mat, params);
  // When a base color texture is present, set color to white so the
  // texture shows through un-darkened (Blender colour-picker is ignored
  // when an Image Texture is connected to Base Color).
  if (params.map) {
    mat.color.setRGB(1, 1, 1);
  }
  return mat;
}

// ---------------------------------------------------------------------------
// Convenience — build geometry + material from a GeoBuffer
// ---------------------------------------------------------------------------

export function buildGeometryWithTSL(
  buf: GeoBuffer,
  params: Omit<TSLMaterialParams, "geometry">,
): {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshPhysicalMaterial | THREE.MeshPhysicalNodeMaterial;
} {
  const geo = new THREE.BufferGeometry();

  geo.setAttribute("position", new THREE.BufferAttribute(buf.vertices, 3));
  geo.setIndex(new THREE.BufferAttribute(buf.indices, 1));

  // UVs are float64 in the GeoBuffer — downcast to float32 for the WebGL attribute
  if (buf.uvs && buf.uvs.length > 0) {
    geo.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(buf.uvs), 2));
  }

  geo.computeVertexNormals();

  if (params.normalMap) {
    geo.computeTangents();
  }

  const mat = buildTSLMaterial({ geometry: geo, ...params });

  return { geometry: geo, material: mat };
}
