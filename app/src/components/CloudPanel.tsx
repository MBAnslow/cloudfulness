import { useRef, useState } from "react";
import {
  useSimStore,
  type CloudTopParams,
  type CloudParams,
  type StrandParams,
} from "../state";
import {
  deleteMeshBlob,
  invalidateMeshGeometry,
  loadCoverGeometry,
  putMeshBlob,
} from "../mapping/meshAsset";
import { useDraggable } from "./useDraggable";

/**
 * Hideable cloud body + strand controls (opacity, transform, LED size).
 * Formerly the Leva "Cloud" and "Strand" folders.
 */
export function CloudPanel({ visible = true }: { visible?: boolean }) {
  const cloud = useSimStore((s) => s.cloud);
  const setCloud = useSimStore((s) => s.setCloud);
  const mapping = useSimStore((s) => s.mapping);
  const setMapping = useSimStore((s) => s.setMapping);
  const cloudTop = useSimStore((s) => s.cloudTop);
  const setCloudTop = useSimStore((s) => s.setCloudTop);
  const strand = useSimStore((s) => s.strand);
  const setStrand = useSimStore((s) => s.setStrand);
  const [cloudTopError, setCloudTopError] = useState("");
  const panelRef = useRef<HTMLDivElement | null>(null);
  const { pos, handleProps } = useDraggable(panelRef);
  const dynStyle: React.CSSProperties = pos
    ? { top: pos.top, left: pos.left, bottom: "auto", right: "auto" }
    : {};
  if (!visible) return null;
  const upd = (patch: Partial<CloudParams>) => setCloud(patch);
  const updCloudTop = (patch: Partial<CloudTopParams>) => setCloudTop(patch);
  const updStrand = (patch: Partial<StrandParams>) => setStrand(patch);
  const updColorProfile = (
    patch: Partial<StrandParams["colorProfile"]>,
  ) =>
    updStrand({
      colorProfile: { ...strand.colorProfile, ...patch },
    });
  return (
    <div ref={panelRef} style={{ ...panelStyle, ...dynStyle }}>
      <div
        onPointerDown={handleProps.onPointerDown}
        style={{ display: "flex", alignItems: "center", gap: 10, cursor: "move" }}
      >
        <div style={titleStyle}>Cloud</div>
        <label style={inlineLabel}>
          <input
            type="checkbox"
            checked={cloud.showOpacity}
            onChange={(e) => upd({ showOpacity: e.target.checked })}
          />
          show pyramid shell
        </label>
        <label style={inlineLabel}>
          <input
            type="checkbox"
            checked={mapping.showBakedSurface}
            onChange={(e) =>
              setMapping({ showBakedSurface: e.target.checked })
            }
          />
          show baked dome
        </label>
        <label style={inlineLabel}>
          <input
            type="checkbox"
            checked={cloud.applyLedOffset ?? true}
            onChange={(e) => upd({ applyLedOffset: e.target.checked })}
          />
          LED bumps
        </label>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        <SliderRow
          label="Dome block"
          value={mapping.bumpLightOpacity}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setMapping({ bumpLightOpacity: v })}
          formatValue={(v) => `${Math.round(v * 100)}%`}
        />
        <SliderRow
          label="Pyr block"
          value={mapping.pyramidLightOpacity}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setMapping({ pyramidLightOpacity: v })}
          formatValue={(v) => `${Math.round(v * 100)}%`}
        />
        <SliderRow
          label="Yaw"
          value={cloud.rotationYDeg ?? 0}
          min={-180}
          max={180}
          step={1}
          onChange={(v) => upd({ rotationYDeg: v })}
          formatValue={(v) => `${v.toFixed(0)}°`}
        />
        <SliderRow
          label="Tilt"
          value={cloud.rotationXDeg ?? 0}
          min={-90}
          max={90}
          step={1}
          onChange={(v) => upd({ rotationXDeg: v })}
          formatValue={(v) => `${v.toFixed(0)}°`}
        />
        <SliderRow
          label="Offset X"
          value={cloud.offsetX ?? 0}
          min={-5}
          max={5}
          step={0.01}
          onChange={(v) => upd({ offsetX: v })}
          formatValue={(v) => `${v.toFixed(2)} m`}
        />
        <SliderRow
          label="Offset Y"
          value={cloud.offsetY ?? 0}
          min={-5}
          max={5}
          step={0.01}
          onChange={(v) => upd({ offsetY: v })}
          formatValue={(v) => `${v.toFixed(2)} m`}
        />
        <SliderRow
          label="Offset Z"
          value={cloud.offsetZ ?? 0}
          min={-5}
          max={5}
          step={0.01}
          onChange={(v) => upd({ offsetZ: v })}
          formatValue={(v) => `${v.toFixed(2)} m`}
        />
        <div style={sectionLabel}>Cloud top</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <label style={inlineLabel}>
            <input
              type="checkbox"
              checked={cloudTop.visible}
              onChange={(e) => updCloudTop({ visible: e.target.checked })}
            />
            show cloud top
          </label>
          <span
            title={cloudTop.name}
            style={{
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: 0.75,
            }}
          >
            {cloudTop.id ? cloudTop.name : "No model loaded"}
          </span>
          {cloudTop.id && (
            <button
              type="button"
              style={smallButtonStyle}
              onClick={() => {
                const id = cloudTop.id;
                if (id) {
                  invalidateMeshGeometry(id);
                  void deleteMeshBlob(id);
                }
                updCloudTop({ id: null, name: "" });
                setCloudTopError("");
              }}
            >
              Remove
            </button>
          )}
        </div>
        <label style={{ ...smallButtonStyle, display: "inline-block", cursor: "pointer" }}>
          {cloudTop.id ? "Replace GLB" : "Upload GLB"}
          <input
            type="file"
            accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const id = `cloud-top-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
              try {
                await putMeshBlob(id, file);
                const geometry = await loadCoverGeometry(id);
                if (!geometry) throw new Error("The file contains no mesh geometry.");
                const previousId = cloudTop.id;
                updCloudTop({ id, name: file.name, visible: true });
                if (previousId) {
                  invalidateMeshGeometry(previousId);
                  void deleteMeshBlob(previousId);
                }
                setCloudTopError("");
              } catch (err) {
                invalidateMeshGeometry(id);
                void deleteMeshBlob(id);
                setCloudTopError(
                  err instanceof Error ? err.message : "Could not load this model.",
                );
              }
            }}
          />
        </label>
        {cloudTopError && (
          <div style={{ color: "#ff9f9f", fontSize: 10 }}>{cloudTopError}</div>
        )}
        <SliderRow
          label="Top scale"
          value={cloudTop.scale}
          min={0.05}
          max={10}
          step={0.05}
          onChange={(v) => updCloudTop({ scale: v })}
          formatValue={(v) => `${v.toFixed(2)}×`}
        />
        <SliderRow
          label="Top yaw"
          value={cloudTop.yawDeg}
          min={-180}
          max={180}
          step={1}
          onChange={(v) => updCloudTop({ yawDeg: v })}
          formatValue={(v) => `${v.toFixed(0)}°`}
        />
        <SliderRow
          label="Top tilt"
          value={cloudTop.tiltDeg}
          min={-180}
          max={180}
          step={1}
          onChange={(v) => updCloudTop({ tiltDeg: v })}
          formatValue={(v) => `${v.toFixed(0)}°`}
        />
        <SliderRow
          label="Top X"
          value={cloudTop.offsetX}
          min={-5}
          max={5}
          step={0.01}
          onChange={(v) => updCloudTop({ offsetX: v })}
          formatValue={(v) => `${v.toFixed(2)} m`}
        />
        <SliderRow
          label="Top Y"
          value={cloudTop.offsetY}
          min={-5}
          max={5}
          step={0.01}
          onChange={(v) => updCloudTop({ offsetY: v })}
          formatValue={(v) => `${v.toFixed(2)} m`}
        />
        <SliderRow
          label="Top Z"
          value={cloudTop.offsetZ}
          min={-5}
          max={5}
          step={0.01}
          onChange={(v) => updCloudTop({ offsetZ: v })}
          formatValue={(v) => `${v.toFixed(2)} m`}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
          <span style={{ width: 80, opacity: 0.85 }}>Top tint</span>
          <input
            type="color"
            value={cloudTop.tint}
            onChange={(e) => updCloudTop({ tint: e.target.value })}
            style={{ width: 42, height: 22, padding: 0, border: 0 }}
          />
          <span style={{ opacity: 0.7 }}>{cloudTop.tint}</span>
        </div>
        <SliderRow
          label="LED glow"
          value={cloudTop.glowStrength}
          min={0}
          max={5}
          step={0.05}
          onChange={(v) => updCloudTop({ glowStrength: v })}
          formatValue={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Glow spread"
          value={cloudTop.glowRadius}
          min={0.02}
          max={1.5}
          step={0.01}
          onChange={(v) => updCloudTop({ glowRadius: v })}
          formatValue={(v) => `${v.toFixed(2)} m`}
        />
        <SliderRow
          label="Glow focus"
          value={cloudTop.glowFocus}
          min={1}
          max={16}
          step={0.25}
          onChange={(v) => updCloudTop({ glowFocus: v })}
          formatValue={(v) => v.toFixed(1)}
        />
        <div style={sectionLabel}>Strand</div>
        <SliderRow
          label="LED size"
          value={strand.ledSize}
          min={0.005}
          max={0.2}
          step={0.005}
          onChange={(v) => updStrand({ ledSize: v })}
          formatValue={(v) => `${(v * 1000).toFixed(0)} mm`}
        />
        <SliderRow
          label="Sensor focus"
          value={strand.sensorHemisphereFocus ?? 0}
          min={0}
          max={12}
          step={0.1}
          onChange={(v) => updStrand({ sensorHemisphereFocus: v })}
          formatValue={(v) => v.toFixed(1)}
        />
        <SliderRow
          label="Output gamma"
          value={strand.colorProfile.brightnessGamma}
          min={0.25}
          max={3}
          step={0.05}
          onChange={(value) => updColorProfile({ brightnessGamma: value })}
          formatValue={(value) => value.toFixed(2)}
        />
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
      <span style={{ width: 80, opacity: 0.85 }}>{label}</span>
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
          width: 52,
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
  left: 12,
  zIndex: 15,
  width: 300,
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

const smallButtonStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 5,
  color: "inherit",
  padding: "3px 7px",
  fontSize: 10,
};
