"use client";

import { useEffect, useRef } from "react";
import { create } from "nipplejs";
import { useNavRigStore } from "../b3/b3-runtime/src/components/stores/navRigStore";

/**
 * Bottom-centre on-screen joystick that steers the navmesh walker.
 *
 * Writes its normalized deflection (−1..1; y > 0 = up = forward) into the nav
 * rig store, which NavMeshRig's movement loop reads every frame — exactly like
 * holding WASD, but camera-relative and pointer-driven. Rendered as a fixed
 * overlay so it floats above the 3D canvas on whichever page mounts it.
 *
 * nipplejs v1.0.4 re-emits joystick events to a collection (manager) only under
 * namespaced keys (`move <uid>:move`), and its handlers receive ONE `evt`
 * object (`evt.data` is the payload) — not the legacy `(evt, data)` pair. So we
 * grab the single static joystick straight off the manager (`getJoystickByUid`)
 * and bind plain `move`/`end` on the instance, reading `evt.data.vector`.
 */
export function VirtualJoystick() {
  const zoneRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone) return;
    const setStick = useNavRigStore.getState().setStick;

    // Static mode: `mode: "static"` materialises one joystick synchronously
    // during create() (Collection.init → createJoystick). `position` is where
    // its centre lands, given as CSS offsets inside the 168px zone.
    const manager = create({
      zone,
      mode: "static",
      size: 120,
      threshold: 0.1,
      position: { left: "84px", top: "84px" },
      color: {
        front: "rgba(129,216,208,0.9)",
        back: "rgba(129,216,208,0.14)",
      },
      restJoystick: true,
      fadeTime: 120,
      dynamicPage: false,
    });

    const stick = manager.getJoystickByUid();
    if (stick) {
      stick.on("move", (evt) => {
        setStick({ x: evt.data.vector.x, y: evt.data.vector.y });
      });
      stick.on("end", () => {
        setStick({ x: 0, y: 0 });
      });
    }

    return () => {
      manager.destroy();
      // Make sure a lingering deflection never keeps the character walking.
      setStick({ x: 0, y: 0 });
    };
  }, []);

  return (
    <div
      className="pointer-events-none fixed bottom-5 left-1/2 z-40 -translate-x-1/2 select-none"
      style={{ width: 168, height: 168 }}
    >
      {/* Decorative socket; nipple draws its own translucent disc + knob on top */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[150px] w-[150px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-tiffany-400/25 bg-studio-900/40 shadow-[0_8px_30px_rgba(0,0,0,0.35)] backdrop-blur-sm" />

      {/* Actual touch zone — fills the overlay, nipple appends its UI here */}
      <div
        ref={zoneRef}
        className="pointer-events-auto absolute inset-0 h-full w-full touch-none"
      />
    </div>
  );
}
