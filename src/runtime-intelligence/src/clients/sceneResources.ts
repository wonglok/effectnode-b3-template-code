import type { BufferGeometry, Material, Object3D, Texture } from 'three'

/**
 * One traversal of the live scene, recording every GPU resource it references.
 *
 * Shared by the performance, memory and draw-call collectors so that "what
 * counts as the same geometry" / "how many triangles" / "which slots hold
 * textures" have exactly one definition. Keeping three copies of that logic in
 * sync was the alternative, and they drift.
 */

/** How many referencing objects a record names before it stops listing them. */
export const MAX_OWNERS = 5

/** A material slot that holds a texture, e.g. `{ slot: 'normalMap', uuid }`. */
export type TextureSlot = {
    slot: string
    uuid: string
}

/** One distinct geometry in the scene, with its sharing information. */
export type GeometryRecord = {
    uuid: string
    name: string
    type: string
    /** vertices in the position attribute */
    vertexCount: number
    /** vertices covered by the index attribute; 0 when non-indexed */
    indexCount: number
    /** triangles: index.length/3 when indexed, else vertexCount/3 */
    triangleCount: number
    /** bytes held by this geometry's buffers (attributes + index) */
    bytes: number
    /** number of scene objects drawing this geometry (1 = used once) */
    references: number
    /** names of the first few referencing objects, so it's findable by name */
    owners: string[]
}

/** One distinct material in the scene. */
export type MaterialRecord = {
    uuid: string
    name: string
    type: string
    references: number
    owners: string[]
    /** which of its slots hold a texture, and which texture */
    textureSlots: TextureSlot[]
}

/** One distinct texture in the scene. */
export type TextureRecord = {
    uuid: string
    name: string
    type: string
    references: number
    owners: string[]
    width: number | null
    height: number | null
    /** bytes if derivable from the backing data, else null (see `estimatedBytes`) */
    bytes: number | null
    /** true when `bytes` assumes a 4-byte-per-pixel RGBA upload */
    estimatedBytes: boolean
}

/** A drawable object: something that carries a geometry and costs draw calls. */
export type DrawableObject = {
    object: Object3D
    uuid: string
    name: string
    type: string
    geometryUuid: string
    /** times this object repeats its geometry per frame (instancing) */
    instances: number
    /** 1 normally; >1 for a multi-material mesh, which issues one draw each */
    drawCalls: number
    materials: MaterialRecord[]
    vertexCount: number
    triangleCount: number
}

export type ResourceWalk = {
    /** every Object3D visited */
    objects: number
    drawables: DrawableObject[]
    geometries: Map<string, GeometryRecord>
    materials: Map<string, MaterialRecord>
    textures: Map<string, TextureRecord>
}

/** The three GPU resource types the memory report tracks. */
export type ResourceKind = 'geometry' | 'material' | 'texture'

/** A resource identity, as handed to the asset registry for leak tracking. */
export type ObservedResource = {
    uuid: string
    kind: ResourceKind
    name: string
    type: string
}

/** Flatten a walk into the resource identities the asset registry observes. */
export function observedResources(walk: ResourceWalk): ObservedResource[] {
    const out: ObservedResource[] = []
    for (const r of walk.geometries.values()) {
        out.push({ uuid: r.uuid, kind: 'geometry', name: r.name || r.type, type: r.type })
    }
    for (const r of walk.materials.values()) {
        out.push({ uuid: r.uuid, kind: 'material', name: r.name || r.type, type: r.type })
    }
    for (const r of walk.textures.values()) {
        out.push({ uuid: r.uuid, kind: 'texture', name: r.name || r.type, type: r.type })
    }
    return out
}

type DrawableNode = Object3D & {
    geometry?: BufferGeometry | null
    isInstancedMesh?: boolean
    /** InstancedMesh.instanceCount is null unless overridden — the real instance
     *  count is `count` (the number of instances this mesh draws). */
    count?: number
    material?: Material | Material[] | null
}

type MaterialLike = { uuid?: string; name?: string; type?: string } & Record<string, unknown>

type TextureLike = {
    isTexture?: boolean
    uuid?: string
    name?: string
    type?: string
    image?: { width?: number; height?: number; videoWidth?: number; data?: { byteLength?: number } } | null
}

/** Buffer-derived counts that are instancing-agnostic. */
export function geomCounts(geometry: BufferGeometry) {
    const position = geometry.getAttribute('position')
    const vertexCount = position ? position.count : 0
    const index = geometry.index
    const indexCount = index ? index.count : 0
    // Triangles only make sense for indexed triangle meshes; for non-indexed
    // geometry (or lines/points) this is a best-effort vertex/3 estimate.
    const triangleCount = indexCount > 0 ? Math.floor(indexCount / 3) : Math.floor(vertexCount / 3)
    return { vertexCount, indexCount, triangleCount }
}

/** Bytes held by a geometry's attribute + index buffers. */
export function geometryBytes(geometry: BufferGeometry): number {
    let bytes = 0
    for (const key of Object.keys(geometry.attributes)) {
        const attribute = geometry.attributes[key] as { array?: { byteLength?: number } } | undefined
        bytes += attribute?.array?.byteLength ?? 0
    }
    bytes += (geometry.index?.array as { byteLength?: number } | undefined)?.byteLength ?? 0
    return bytes
}

/**
 * Bytes held by a texture, and whether that number is a guess. Data textures
 * carry their exact byte length; everything else is assumed to be an RGBA8
 * upload (4 bytes/pixel), which is right for the common case and an
 * over-estimate for compressed formats.
 */
export function textureBytes(texture: Texture): { bytes: number | null; estimated: boolean } {
    const image = (texture as unknown as TextureLike).image
    const data = image?.data
    if (data && typeof data.byteLength === 'number') {
        return { bytes: data.byteLength, estimated: false }
    }
    const width = image?.width ?? image?.videoWidth ?? 0
    const height = image?.height ?? 0
    if (width > 0 && height > 0) {
        return { bytes: width * height * 4, estimated: true }
    }
    return { bytes: null, estimated: false }
}

function textureDimensions(texture: Texture): { width: number | null; height: number | null } {
    const image = (texture as unknown as TextureLike).image
    const width = image?.width ?? image?.videoWidth ?? null
    const height = image?.height ?? null
    return { width: width || null, height: height || null }
}

/**
 * A readable type name for a texture.
 *
 * Note `Texture.type` is a *numeric* `TextureDataType` (UnsignedByteType, …),
 * unlike `Object3D.type` / `Material.type` / `BufferGeometry.type` which are
 * class-name strings. So the class name is what an agent actually wants here.
 */
function textureTypeName(texture: Texture): string {
    return texture.constructor?.name || 'Texture'
}

/**
 * The material's texture-bearing slots, keeping the Texture itself so callers
 * can read its dimensions / byte size — `material.map`, `material.normalMap`, …
 */
export function materialTextures(material: Material): { slot: string; texture: Texture }[] {
    const found: { slot: string; texture: Texture }[] = []
    const m = material as unknown as MaterialLike
    for (const key of Object.keys(m)) {
        const value = m[key]
        if (!value || typeof value !== 'object') {
            continue
        }
        const tex = value as TextureLike
        if (tex.isTexture === true && typeof tex.uuid === 'string') {
            found.push({ slot: key, texture: value as unknown as Texture })
        }
    }

    // ShaderMaterial keeps its textures inside `uniforms` rather than on
    // top-level slots, so a plain own-key scan would miss every one of them.
    const uniforms = (material as unknown as { uniforms?: Record<string, { value?: unknown }> }).uniforms
    if (uniforms && typeof uniforms === 'object') {
        for (const key of Object.keys(uniforms)) {
            const value = uniforms[key]?.value
            const tex = value as TextureLike | null | undefined
            if (tex && typeof tex === 'object' && tex.isTexture === true && typeof tex.uuid === 'string') {
                found.push({ slot: `uniforms.${key}`, texture: value as unknown as Texture })
            }
        }
    }

    return found
}

/** The material's texture-bearing slots as plain `{ slot, uuid }` pairs. */
export function materialTextureSlots(material: Material): TextureSlot[] {
    return materialTextures(material).map(({ slot, texture }) => ({ slot, uuid: texture.uuid }))
}

/**
 * Walk `root` once and return every drawable object plus the deduped
 * geometry / material / texture registries it references.
 */
export function scanScene(root: Object3D): ResourceWalk {
    const geometries = new Map<string, GeometryRecord>()
    const materials = new Map<string, MaterialRecord>()
    const textures = new Map<string, TextureRecord>()
    const drawables: DrawableObject[] = []
    let objects = 0

    const nameOf = (object: Object3D) => object.name || object.type

    const recordTexture = (texture: Texture, owner: string): TextureRecord => {
        let record = textures.get(texture.uuid)
        if (!record) {
            const { bytes, estimated } = textureBytes(texture)
            const { width, height } = textureDimensions(texture)
            record = {
                uuid: texture.uuid,
                name: texture.name || '',
                type: textureTypeName(texture),
                references: 0,
                owners: [],
                width,
                height,
                bytes,
                estimatedBytes: estimated,
            }
            textures.set(texture.uuid, record)
        }
        record.references++
        if (record.owners.length < MAX_OWNERS) {
            record.owners.push(owner)
        }
        return record
    }

    const recordMaterial = (material: Material, owner: string): MaterialRecord => {
        let record = materials.get(material.uuid)
        if (!record) {
            record = {
                uuid: material.uuid,
                name: material.name || material.type,
                type: material.type,
                references: 0,
                owners: [],
                textureSlots: materialTextureSlots(material),
            }
            materials.set(material.uuid, record)
        }
        record.references++
        if (record.owners.length < MAX_OWNERS) {
            record.owners.push(owner)
        }
        return record
    }

    const visit = (object: Object3D) => {
        objects++
        const node = object as DrawableNode
        const geometry = node.geometry

        if (geometry) {
            const owner = nameOf(object)
            const { vertexCount, indexCount, triangleCount } = geomCounts(geometry)

            // Instancing multiplies the per-instance geometry at draw time.
            let instances = 1
            if (node.isInstancedMesh && typeof node.count === 'number') {
                instances = Math.max(1, Math.floor(node.count))
            }

            const materialList = (
                Array.isArray(node.material) ? node.material : node.material ? [node.material] : []
            ).filter((m): m is Material => Boolean(m))

            const materialRecords: MaterialRecord[] = []
            for (const material of materialList) {
                materialRecords.push(recordMaterial(material, owner))
                // Textures hang off the material, not the geometry — record them
                // from here so the texture registry reflects real references.
                for (const { texture } of materialTextures(material)) {
                    recordTexture(texture, owner)
                }
            }

            let record = geometries.get(geometry.uuid)
            if (!record) {
                record = {
                    uuid: geometry.uuid,
                    name: geometry.name || '',
                    type: geometry.type,
                    vertexCount,
                    indexCount,
                    triangleCount,
                    bytes: geometryBytes(geometry),
                    references: 0,
                    owners: [],
                }
                geometries.set(geometry.uuid, record)
            }
            record.references++
            if (record.owners.length < MAX_OWNERS) {
                record.owners.push(owner)
            }

            // three draws one call per geometry *group* when the mesh carries a
            // material array, not one per material — a two-material mesh with no
            // groups still draws once. Material count alone over-counts.
            const groupCount = geometry.groups?.length ?? 0
            const drawCalls = Array.isArray(node.material) && groupCount > 0 ? groupCount : 1

            drawables.push({
                object,
                uuid: object.uuid,
                name: owner,
                type: object.type,
                geometryUuid: geometry.uuid,
                instances,
                drawCalls,
                materials: materialRecords,
                vertexCount: vertexCount * instances,
                triangleCount: triangleCount * instances,
            })
        }

        for (const child of object.children) {
            visit(child)
        }
    }

    visit(root)

    return { objects, drawables, geometries, materials, textures }
}
