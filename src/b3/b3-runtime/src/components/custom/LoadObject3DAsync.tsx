import { LoadCollider } from "./LoadCollider";
import { LoadCurve } from "./LoadCurve";
import { LoadEdge } from "./LoadEdge";
import { LoadWalker } from "./LoadWalker";

export function LoadObject3DAsync ({ texData = new Map(), objects = [] }) {
    return <>
        <LoadCollider texData={texData} objects={objects}></LoadCollider>
        <LoadCurve objects={objects}></LoadCurve>
        <LoadEdge texData={texData} objects={objects}></LoadEdge>
        <LoadWalker texData={texData} objects={objects}></LoadWalker>
    </>;
}