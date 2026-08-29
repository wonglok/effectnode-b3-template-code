import { LoadCollider } from "./LoadCollider";
import { LoadEdge } from "./LoadEdge";

export function LoadObject3DAsync ({ texData = new Map(), objects = [] }) {
    return <>
        <LoadCollider texData={texData} objects={objects}></LoadCollider>
        <LoadEdge texData={texData} objects={objects}></LoadEdge>
    </>;
}
