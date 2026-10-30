import type { CSSProperties } from "react";
import { useSimStore } from "../state";

/**
 * Shared "Cycle  [ 464 ] s / 24h  [lock]" control for the arrangement
 * pages. Locked cycles are also enforced in `setSky`, so this is only
 * the visible half of the lock.
 */
export function CycleField({
  labelStyle,
  inputStyle,
  label = "Cycle",
}: {
  labelStyle: CSSProperties;
  inputStyle: CSSProperties;
  label?: string;
}) {
  const cycleSeconds = useSimStore((s) => s.sky.cycleSeconds);
  const locked = useSimStore((s) => s.sky.cycleLocked);
  const setSky = useSimStore((s) => s.setSky);
  const setCycleLocked = useSimStore((s) => s.setCycleLocked);
  return (
    <label style={{ ...labelStyle, fontSize: 11 }}>
      {label}
      <input
        type="number"
        min={5}
        max={3600}
        step={5}
        value={Math.round(cycleSeconds)}
        disabled={locked}
        title={locked ? "Cycle is locked. Unlock to edit." : undefined}
        onChange={(e) =>
          setSky({
            cycleSeconds: Math.max(5, parseFloat(e.target.value) || 60),
          })
        }
        style={{ ...inputStyle, width: 60, opacity: locked ? 0.6 : 1 }}
      />
      <span style={{ opacity: 0.6 }}>s / 24h</span>
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          if (locked) {
            const ok = window.confirm(
              "Unlock the 24h cycle length? Pads, drones, and samples are synced to it.",
            );
            if (!ok) return;
          }
          setCycleLocked(!locked);
        }}
        title={
          locked
            ? "Unlock the 24h cycle length"
            : "Lock the 24h cycle length so it can't be changed by accident"
        }
        style={{
          fontSize: 11,
          padding: "2px 7px",
          borderRadius: 4,
          cursor: "pointer",
          color: "inherit",
          background: locked ? "rgba(250,204,21,0.18)" : "rgba(255,255,255,0.06)",
          border: `1px solid ${locked ? "rgba(250,204,21,0.6)" : "rgba(255,255,255,0.2)"}`,
        }}
      >
        {locked ? "Locked" : "Lock"}
      </button>
    </label>
  );
}
