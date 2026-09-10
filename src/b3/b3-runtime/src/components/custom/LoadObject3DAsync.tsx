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

            <group position={[0, -50, 0]}>
                <SceneWaterObject size={1000}></SceneWaterObject>
            </group>

            <ambientLight intensity={1}></ambientLight>

            <directionalLight intensity={1} position={[5, 5, 5]}></directionalLight>
            <directionalLight intensity={1} position={[-5, 5, -5]}></directionalLight>
        </>
    )
}

//
