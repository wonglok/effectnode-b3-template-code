import { LoadReflection } from "./LoadReflection";

export function LoadObject3DAsync ({  objects = [] }) {
    return <>
        <LoadReflection objects={objects}></LoadReflection>
    </>;
}
