import { LoadCollider } from "./LoadCollider";

export function LoadObject3DAsync ({ texData = new Map(), objects = [] }) {
    return <>
        <LoadCollider texData={texData} objects={objects}></LoadCollider>
    </>;
}
