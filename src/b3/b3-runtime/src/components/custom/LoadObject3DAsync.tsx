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
                Flatten and hide its ground to lay it over terrain the scene
                already provides: terrainAmplitude={0} showGround={false}. */}
            <GrassComponent />

            <group position={[0, 0.0, 0]}>
                <SceneWaterObject name={'water'} objects={objects}></SceneWaterObject>
            </group>

            <group position={[0, 0.0, 0]}>
                <SceneWaterObject name={'water2'} objects={objects}></SceneWaterObject>
            </group>
            {/*  */}

            {/*  */}

            {/* 
            <ambientLight intensity={1}></ambientLight>
            <directionalLight intensity={1} position={[5, 5, 5]}></directionalLight>
            <directionalLight intensity={1} position={[-5, 5, -5]}></directionalLight> 
            */}
        </>
    )
}

//
