import { useEffect } from "react";
import { useSimStore } from "../state";
import { getPadEngine } from "./PadEngine";
import { getBellowsPadEngine } from "./BellowsPadEngine";
import { modulatedEngineParams } from "./breathModulation";

/**
 * Headless component that drives the warm-pad engine every animation
 * frame. Mount once at the app root, alongside `DroneRuntime`. Reads
 * `sky.timeHours` + `pad` from the store on each tick without
 * subscribing (avoids re-renders). The sky clock itself is advanced by
 * `DroneRuntime` — this runtime only feeds its engine.
 *
 * AudioContext unlock is idempotent: the same pointer/key gestures
 * that start the drone engine also start the pad engine.
 */
export function PadRuntime(): null {
  useEffect(() => {
    const engine = getPadEngine();
    const bellowsEngine = getBellowsPadEngine();
    let raf = 0;
    let unlocking = false;

    const unlock = () => {
      if (unlocking) return;
      unlocking = true;
      Promise.all([engine.start(), bellowsEngine.start()])
        .then(() => {
          window.removeEventListener("pointerdown", unlock);
          window.removeEventListener("keydown", unlock);
        })
        .catch((err) => console.warn("[pad] start failed", err))
        .finally(() => {
          unlocking = false;
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") unlock();
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
    document.addEventListener("visibilitychange", onVisibility);

    const tick = () => {
      raf = requestAnimationFrame(tick);
      const state = useSimStore.getState();
      const { pad } = modulatedEngineParams(state, performance.now());
      const audiblePad =
        state.audioMuted.pad || (state.audioSolo && state.audioSolo !== "pad")
          ? { ...pad, master: 0 }
          : pad;
      engine.update(state.sky.timeHours, {
        ...audiblePad,
        enabled: audiblePad.enabled && audiblePad.engine === "tone",
      });
      bellowsEngine.update(state.sky.timeHours, audiblePad);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  return null;
}
