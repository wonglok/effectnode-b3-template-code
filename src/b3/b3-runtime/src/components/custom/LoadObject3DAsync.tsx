import { ClothComponent } from './ClothComponent'
import { GrassComponent } from './GrassComponent'
import { LoadCollider } from './LoadCollider'
import { LoadCurve } from './LoadCurve'
import { LoadEdge } from './LoadEdge'
import { SceneWaterObject } from './SceneWaterObject'

export function LoadObject3DAsync({ texData = new Map(), objects = [] }) {
    return (
        <>
            <LoadCollider texData={texData} objects={objects}></LoadCollider>
            <LoadCurve objects={objects}></LoadCurve>
            <LoadEdge texData={texData} objects={objects}></LoadEdge>

            {/* Instanced grass field (TSL port of three's grass-shader example).
                Blades are placed by sampling the 'collider' mesh's surface and
                aligned to its normals. `objects` is passed only so a re-synced
                collider (Blender bumps its version) re-samples the field. */}
            <GrassComponent objects={objects} />

            {/* GPU verlet cloth, drawn with the TSL transmission material
                (`shader/TransmissionTSLMaterial.ts`). It steps in its own
                `useFrame` and hangs beside the player's start. Its vertex
                shader reads a storage buffer, so `CanvasGPU` has to ask for
                `maxStorageBuffersInVertexStage` — see the note there. */}
            <ClothComponent />

            <group position={[0, 0.0, 0]}>
                <SceneWaterObject name={'water'} objects={objects}></SceneWaterObject>
            </group>

            <group position={[0, 0.0, 0]}>
                <SceneWaterObject name={'water2'} objects={objects}></SceneWaterObject>
            </group>

            {/*

            <ambientLight intensity={1}></ambientLight>
            <directionalLight intensity={1} position={[5, 5, 5]}></directionalLight>
            <directionalLight intensity={1} position={[-5, 5, -5]}></directionalLight> 

            */}
        </>
    )
}
