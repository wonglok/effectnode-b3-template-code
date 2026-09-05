"use client";
//
// Copyright © 2026 Wong Lok. MIT Lincesed
// Praise Jesus
//

import { useState } from "react";
import * as THREE from "three/webgpu";
import { Canvas, extend, type ThreeToJSXElements } from "@react-three/fiber";
import { HDRLoader } from "three/examples/jsm/Addons.js";
import { useRef } from "react";

declare module "@react-three/fiber" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface ThreeElements extends ThreeToJSXElements<typeof THREE> {}
}

extend(THREE as any);

export const rgbeLoader = new HDRLoader();

//

export const CanvasGPU: any = ({
  children,
  ...props
}: {
  children?: any;
  props: any;
}) => {
  const ref = useRef<HTMLDivElement>(null);

  // let dpr = typeof window !== "undefined" ? window?.devicePixelRatio || 1 : 1;

  // if (dpr >= 2) {
  //   dpr = dpr / 2;
  // } else if (dpr > 1) {
  //   dpr = 1;
  // }

  // if (webgl) {
  //   dpr = typeof window !== "undefined" ? window?.devicePixelRatio || 1 : 1;
  // }

  let [ok, setOK] = useState(false);
  return (
    <>
      <div className="w-full h-full relative" ref={ref}>
        <Canvas
          shadows
          //
          // dpr={[1, dpr]}
          // shadows="soft"
          gl={async (glprops: any): Promise<any> => {
            const renderer = new THREE.WebGPURenderer({
              ...(glprops as any),
              ...props,

              // alpha: false,
              // antialias: false,
              // depth: false,
              // stencil: false,
              // multiview: true,

              // requiredLimits: {
              //   maxColorAttachments: 8,
              // },
            });

            await renderer.init();

            renderer.toneMapping = THREE.AgXToneMapping;
            renderer.toneMappingExposure = 1;

            if (ref.current) {
              const rect = ref.current.getBoundingClientRect();
              renderer.setSize(rect.width, rect.height, true);
            }

            renderer.setPixelRatio(window.devicePixelRatio);

            renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            renderer.shadowMap.enabled = true;

            await renderer.compileAsync(
              new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)),
              new THREE.PerspectiveCamera(1, 1, 0.1, 1000),
            );

            renderer.render(
              new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)),
              new THREE.PerspectiveCamera(1, 1, 0.1, 1000),
            );

            setOK(true);

            return renderer;
          }}
        >
          {ok && children}
        </Canvas>
      </div>
    </>
  );
};
