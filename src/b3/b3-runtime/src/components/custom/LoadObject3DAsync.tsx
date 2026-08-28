import { LoadReflection } from "./LoadReflection";

export function LoadObject3DAsync ({ texData = new Map(), objects = [] }) {
    return <>
        <LoadReflection texData={texData} objects={objects}></LoadReflection>
    </>;
}
