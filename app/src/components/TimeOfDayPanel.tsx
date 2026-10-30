import { useRef } from "react";
import {
  useSimStore,
  type AmbientLightParams,
  type SkyParams,
} from "../state";
import { CycleField } from "./CycleField";
import { skyBodyDirections } from "../lighting/skyCycle";
import { useDraggable } from "./useDraggable";
import { ColorInput } from "./ColorInput";

/**
 * Hideable time-of-day visualization + ambient light controls.
 * Color stops stay on the SkyTimeline.
 */
export function TimeOfDayPanel({ visible = true }: { visible?: boolean }) {
  const sky = useSimStore((s) => s.sky);
  const setSky = useSimStore((s) => s.setSky);
  const ambient = useSimStore((s) => s.ambient);
  const setAmbient = useSimStore((s) => s.setAmbient);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { pos, handleProps } = useDraggable(panelRef);
  const dynStyle: React.CSSProperties = pos
    ? { top: pos.top, left: pos.left, bottom: "auto", right: "auto" }
    : {};
  if (!visible) return null;
  const upd = (patch: Partial<SkyParams>) => setSky(patch);
  const updAmbient = (patch: Partial<AmbientLightParams>) => setAmbient(patch);
  const sunAltitudeDeg = skyBodyDirections(sky.timeHours).sunAltitudeDeg;
  const moonAltitudeDeg = -sunAltitudeDeg;
  return (
    <div ref={panelRef} style={{ ...panelStyle, ...dynStyle }}>
      <div
        onPointerDown={handleProps.onPointerDown}
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "move" }}
      >
        <div style={titleStyle}>Time of day</div>
        <label style={inlineLabel}>
          <input
            type="checkbox"
            checked={sky.enabled}
            onChange={(e) => upd({ enabled: e.target.checked })}
          />
          enabled
        </label>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        <SliderRow
          label="Amount"
          value={sky.visualizationAmount ?? 1}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => upd({ visualizationAmount: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <CycleField
          label="24h cycle"
          labelStyle={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 11,
          }}
          inputStyle={{
            width: 64,
            background: "rgba(0,0,0,0.35)",
            color: "inherit",
            border: "1px solid rgba(255,255,255,0.16)",
            borderRadius: 4,
            padding: "2px 6px",
          }}
        />
        <SliderRow
          label="Ambient scale"
          value={sky.ambientScale}
          min={0}
          max={3}
          step={0.01}
          onChange={(v) => upd({ ambientScale: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Sun scale"
          value={sky.sunScale}
          min={0}
          max={3}
          step={0.01}
          onChange={(v) => upd({ sunScale: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Sun spread"
          value={sky.sunSpread ?? 0.9}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => upd({ sunSpread: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Sun beam focus"
          value={sky.sunBeamFocus ?? 0.65}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => upd({ sunBeamFocus: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Low-sun crown boost"
          value={sky.sunTopHighlightBoost ?? 0}
          min={0}
          max={8}
          step={0.05}
          onChange={(v) => upd({ sunTopHighlightBoost: v })}
          formatValue={(v) => `${v.toFixed(2)}×`}
        />
        <SliderRow
          label="Moon scale"
          value={sky.moonScale}
          min={0}
          max={3}
          step={0.01}
          onChange={(v) => upd({ moonScale: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Moon spread"
          value={sky.moonSpread ?? 0.9}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => upd({ moonSpread: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Moon beam focus"
          value={sky.moonBeamFocus ?? 0.65}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => upd({ moonBeamFocus: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Distance falloff"
          value={sky.lightDecay ?? 1}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => upd({ lightDecay: v })}
          formatValue={(v) => (v === 0 ? "off" : `d^-${v.toFixed(2)}`)}
        />
        <SliderRow
          label="Orbit X"
          value={sky.orbitRadiusX ?? sky.orbitRadius ?? 12}
          min={0}
          max={12}
          step={0.25}
          onChange={(v) => upd({ orbitRadiusX: v })}
          formatValue={(v) => `${v.toFixed(2)}m`}
        />
        <SliderRow
          label="Orbit Y"
          value={sky.orbitRadiusY ?? sky.orbitRadius ?? 12}
          min={0}
          max={12}
          step={0.25}
          onChange={(v) => upd({ orbitRadiusY: v })}
          formatValue={(v) => `${v.toFixed(2)}m`}
        />
        <SliderRow
          label="Orbit Z"
          value={sky.orbitRadiusZ ?? sky.orbitRadius ?? 12}
          min={0}
          max={12}
          step={0.25}
          onChange={(v) => upd({ orbitRadiusZ: v })}
          formatValue={(v) => `${v.toFixed(2)}m`}
        />
        <label style={inlineLabel}>
          <input
            type="checkbox"
            checked={!!sky.showSpreadCones}
            onChange={(e) => upd({ showSpreadCones: e.target.checked })}
          />
          show spread cones
        </label>
        <div style={sectionLabel}>Altitude response</div>
        <div
          style={{ fontSize: 10, opacity: 0.72, marginBottom: 3 }}
          title="Current orbital altitude used by the response controls"
        >
          Current: sun {sunAltitudeDeg.toFixed(1)}° · moon{" "}
          {moonAltitudeDeg.toFixed(1)}°
        </div>
        <SliderRow
          label="Sun starts"
          value={sky.sunHorizonStartDeg}
          min={-90}
          max={90}
          step={0.5}
          onChange={(v) =>
            upd({
              sunHorizonStartDeg: v,
              sunHorizonFullDeg: Math.max(v, sky.sunHorizonFullDeg),
            })
          }
          formatValue={(v) => `${v.toFixed(1)}°`}
        />
        <SliderRow
          label="Sun full"
          value={sky.sunHorizonFullDeg}
          min={-90}
          max={90}
          step={0.5}
          onChange={(v) =>
            upd({
              sunHorizonStartDeg: Math.min(v, sky.sunHorizonStartDeg),
              sunHorizonFullDeg: v,
            })
          }
          formatValue={(v) => `${v.toFixed(1)}°`}
        />
        <SliderRow
          label="Moon starts"
          value={sky.moonHorizonStartDeg}
          min={-90}
          max={90}
          step={0.5}
          onChange={(v) =>
            upd({
              moonHorizonStartDeg: v,
              moonHorizonFullDeg: Math.max(v, sky.moonHorizonFullDeg),
            })
          }
          formatValue={(v) => `${v.toFixed(1)}°`}
        />
        <SliderRow
          label="Moon full"
          value={sky.moonHorizonFullDeg}
          min={-90}
          max={90}
          step={0.5}
          onChange={(v) =>
            upd({
              moonHorizonStartDeg: Math.min(v, sky.moonHorizonStartDeg),
              moonHorizonFullDeg: v,
            })
          }
          formatValue={(v) => `${v.toFixed(1)}°`}
        />
        <div style={sectionLabel}>Atmosphere</div>
        <label style={inlineLabel}>
          <input
            type="checkbox"
            checked={!!sky.rimEnabled}
            onChange={(e) => upd({ rimEnabled: e.target.checked })}
          />
          rim light
        </label>
        <SliderRow
          label="Rim scale"
          value={sky.rimScale ?? 1}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => upd({ rimScale: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Rim width"
          value={sky.rimWidth ?? 0.4}
          min={0.02}
          max={1}
          step={0.01}
          onChange={(v) => upd({ rimWidth: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Ambient occlusion"
          value={sky.ambientOcclusion ?? 0}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => upd({ ambientOcclusion: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Shadow floor"
          value={sky.ambientShadowFloor ?? 0}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => upd({ ambientShadowFloor: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <div style={sectionLabel}>Lights</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
          <span style={{ width: 88, opacity: 0.85 }}>Ambient</span>
          <ColorInput
            color={ambient.color}
            onChange={(color) => updAmbient({ color })}
            compact
          />
          <span style={{ flex: 1 }} />
        </div>
        <SliderRow
          label="Amb. intensity"
          value={ambient.intensity}
          min={0}
          max={2}
          step={0.01}
          onChange={(v) => updAmbient({ intensity: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Ambient ducking"
          value={ambient.ducking ?? 0.75}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => updAmbient({ ducking: v })}
          formatValue={(v) => v.toFixed(2)}
        />
      </div>
      <div style={{ marginTop: 6, fontSize: 10, opacity: 0.65, lineHeight: 1.35 }}>
        Color stops for sun, moon, ambient, and rim live on the sky timeline.
        Direct light keeps the cloud shading. Ambient fills the shade and
        ducks back where the sun or moon is strong. Rim sits on the lit edges.
      </div>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
  formatValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  formatValue?: (v: number) => string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
      <span style={{ width: 88, opacity: 0.85 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1 }}
      />
      <span
        style={{
          width: 46,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatValue ? formatValue(value) : value.toFixed(2)}
      </span>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: "fixed",
  bottom: 60,
  left: 340,
  zIndex: 15,
  width: 320,
  background: "rgba(10, 12, 20, 0.82)",
  backdropFilter: "blur(8px)",
  color: "rgba(207,214,230,0.95)",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid rgba(255,255,255,0.12)",
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  maxHeight: "calc(100vh - 80px)",
  overflowY: "auto",
};

const titleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.3,
  marginRight: "auto",
};

const sectionLabel: React.CSSProperties = {
  fontSize: 10,
  opacity: 0.7,
  marginTop: 6,
  paddingTop: 4,
  borderTop: "1px solid rgba(255,255,255,0.1)",
};

const inlineLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  fontSize: 11,
};
