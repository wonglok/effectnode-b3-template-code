import { ClothComponent } from './ClothComponent'
import { GrassComponent } from './GrassComponent'
import { LoadCollider } from './LoadCollider'
import { LoadCurve } from './LoadCurve'
import { LoadEdge } from './LoadEdge'
import { SceneWaterObject } from './SceneWaterObject'

export function LoadObject3DAsync({ texData = new Map(), objects = [] }) {
    return (
        <>
            {/* <directionalLight position={[1, 1, 1]} intensity={10}></directionalLight> */}
            <LoadCollider texData={texData} objects={objects}></LoadCollider>
            <LoadCurve objects={objects}></LoadCurve>
            <LoadEdge texData={texData} objects={objects}></LoadEdge>

            {/* Instanced grass field (TSL port of three's grass-shader example).
                Blades are placed by sampling the 'collider' mesh's surface and
                aligned to its normals. `objects` is passed only so a re-synced
                collider (Blender bumps its version) re-samples the field.

                `instances` is set here rather than left at the component's
                150,000 default: a blade is 8 triangles and nothing culls
                individual ones, so the default draws ~1.2 M triangles every
                frame — about a third of everything the /production frame
                draws, measured. 50,000 holds the field's read at ~0.4 M. If
                the field now looks thin, the answer is not to raise this back
                but to wire `grassCuller`, which is written to keep density
                near the player and cut the count behind them. */}
            {/* <GrassComponent objects={objects} instances={50000} /> */}

            {/* The player's cape: a GPU verlet cloth drawn with the TSL
                transmission material (`shader/TransmissionTSLMaterial.ts`),
                pinned across the avatar's back at shoulder height. It steps in its own
                `useFrame`, and mounts nothing until the avatar exists to hang
                it from. Its vertex shader reads a storage buffer, so
                `CanvasGPU` has to ask for `maxStorageBuffersInVertexStage` —
                see the note there. */}
            <ClothComponent segmentsX={256} segmentsY={96} />

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
