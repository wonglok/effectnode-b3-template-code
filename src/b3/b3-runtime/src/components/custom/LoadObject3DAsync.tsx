import { LoadCollider } from "./LoadCollider";
import { LoadCurve } from "./LoadCurve";
import { LoadEdge } from "./LoadEdge";
import { LoadGuide } from "./LoadGuide";
import { LoadGuide2 } from "./LoadGuide2";

export function LoadObject3DAsync ({ texData = new Map(), objects = [] }) {
    return <>
        <LoadCollider texData={texData} objects={objects}></LoadCollider>
        <LoadCurve objects={objects}></LoadCurve>
        <LoadEdge texData={texData} objects={objects}></LoadEdge>
        <LoadGuide texData={texData} objects={objects}></LoadGuide>
        <LoadGuide2 texData={texData} objects={objects}></LoadGuide2>
    </>;
}