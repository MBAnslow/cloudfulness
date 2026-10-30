import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useSimStore, type Vec3 } from "../state";
import {
  boundFileName,
  loadFromFile,
  saveToFile,
  summariseMissing,
} from "../state/fileIO";
import { applyMappingOrientation, azElToDir, dirToAzEl } from "./geometry";
import { DOME_FOOTPRINT_SCALE } from "./gaussians";
import { clearBakedSurfaceGeometry } from "./bakedSurface";
import { mappingBakeSignature } from "./bakeSignature";
import { deleteMeshBlob, invalidateMeshGeometry, putMeshBlob } from "./meshAsset";
import { confirmDestructiveClear } from "../components/confirmDestructiveClear";
import { ColorInput } from "../components/ColorInput";

interface Props {
  selected: number | null;
  setSelected: (index: number | null) => void;
  selectedGaussianId: string | null;
  setSelectedGaussianId: (id: string | null) => void;
}

const NUDGE_DEG = 2;
const NUDGE_RAD = (NUDGE_DEG * Math.PI) / 180;

export function MappingPanel({
  selected,
  setSelected,
  selectedGaussianId,
  setSelectedGaussianId,
}: Props) {
  const mapping = useSimStore((s) => s.mapping);
  const setMapping = useSimStore((s) => s.setMapping);
  const wled = useSimStore((s) => s.wled);
  const setWled = useSimStore((s) => s.setWled);
  const strand = useSimStore((s) => s.strand);
  const setStrand = useSimStore((s) => s.setStrand);
  const mesh = useSimStore((s) => s.mesh);
  const setMesh = useSimStore((s) => s.setMesh);
  const updateMappedLed = useSimStore((s) => s.updateMappedLed);
  const removeLastMappedLed = useSimStore((s) => s.removeLastMappedLed);
  const clearMappedLeds = useSimStore((s) => s.clearMappedLeds);
  const updateMappingGaussian = useSimStore((s) => s.updateMappingGaussian);
  const removeMappingGaussian = useSimStore((s) => s.removeMappingGaussian);
  const clearMappingBumps = useSimStore((s) => s.clearMappingBumps);

  const count = mapping.leds.length;
  const lastIndex = count - 1;
  const reversed = mapping.reversed;
  const tool = mapping.tool;
  const gaussians = mapping.gaussians ?? [];
  const selectedGaussian =
    selectedGaussianId == null
      ? null
      : gaussians.find((g) => g.id === selectedGaussianId) ?? null;
  const bakeSignature = mappingBakeSignature(mapping);
  const bakeUpToDate =
    !!mapping.bakedSurfaceSignature &&
    mapping.bakedSurfaceSignature === bakeSignature;
  // Display number for a placement index, honoring the reverse toggle.
  const displayNumber = (i: number) => (reversed ? count - i : i + 1);
  // The physical threading end (where add/delete happen) shown as its number.
  const endNumber = reversed ? 1 : count;

  const nudge = (dAz: number, dEl: number) => {
    if (selected === null) return;
    const led = mapping.leds[selected];
    if (!led) return;
    const displayDir = applyMappingOrientation(
      led.dir,
      mapping.flipUpDown,
      mapping.flipLeftRight,
    );
    const { az, el } = dirToAzEl(displayDir);
    const nextEl = Math.max(
      -Math.PI / 2 + 1e-3,
      Math.min(Math.PI / 2 - 1e-3, el + dEl),
    );
    const nextDisplayDir: Vec3 = azElToDir(az + dAz, nextEl);
    updateMappedLed(selected, {
      dir: applyMappingOrientation(
        nextDisplayDir,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      ),
    });
  };

  const deleteLast = () => {
    if (count === 0) return;
    removeLastMappedLed();
    if (selected !== null && selected >= lastIndex) {
      setSelected(lastIndex - 1 >= 0 ? lastIndex - 1 : null);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 12,
        zIndex: 10,
        pointerEvents: "none",
      }}
    >
      <Panel side="left">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
          gap: 6,
          marginBottom: 10,
        }}
      >
        <span
          style={{
            textTransform: "uppercase",
            letterSpacing: 0.6,
            opacity: 0.75,
            fontSize: 11,
          }}
        >
          LED Mapping
        </span>
        <Link
          to="/drones"
          style={{
            color: "inherit",
            textDecoration: "none",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 6,
            padding: "2px 8px",
            fontSize: 11,
          }}
        >
          Drones →
        </Link>
        <Link
          to="/"
          style={{
            color: "inherit",
            textDecoration: "none",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 6,
            padding: "2px 8px",
            fontSize: 11,
          }}
        >
          ← simulator
        </Link>
      </div>

      <Section title="Surface & orientation">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 6,
            marginBottom: 6,
          }}
        >
          <div style={{ opacity: 0.85, overflow: "hidden", textOverflow: "ellipsis" }}>
            {mesh.id ? mesh.name || "(unnamed mesh)" : "No mesh loaded"}
          </div>
          {mesh.id && (
            <Button
              danger
              onClick={() => {
                if (mesh.id) {
                  invalidateMeshGeometry(mesh.id);
                  deleteMeshBlob(mesh.id).catch(() => {});
                }
                setMesh({ id: null, name: "" });
              }}
            >
              Remove
            </Button>
          )}
        </div>
        <label
          style={{
            display: "inline-block",
            background: "rgba(255,255,255,0.06)",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 6,
            padding: "4px 10px",
            cursor: "pointer",
            fontSize: 11,
            marginBottom: 8,
          }}
        >
          Upload .glb / .gltf
          <input
            type="file"
            accept=".glb,.gltf,model/gltf-binary,model/gltf+json"
            style={{ display: "none" }}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              const id = `mesh-${Date.now().toString(36)}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
              try {
                await putMeshBlob(id, file);
                setMesh({
                  id,
                  name: file.name,
                  scale: 1,
                  yawDeg: 0,
                  tiltDeg: 0,
                  offsetY: 0,
                });
              } catch (err) {
                console.warn("[mapping] mesh upload failed", err);
              }
            }}
          />
        </label>
        <div style={{ opacity: 0.6, marginBottom: 6, lineHeight: 1.4 }}>
          Export from Blender: File → Export → glTF 2.0 (.glb). Uploaded
          mesh becomes the surface LEDs snap to when Mesh mode is active.
        </div>
        <SliderRow
          label="scale"
          value={mesh.scale}
          min={0.05}
          max={10}
          step={0.05}
          onChange={(v) => setMesh({ scale: v })}
          format={formatScale}
        />
        <SliderRow
          label="yaw"
          value={mesh.yawDeg}
          min={-180}
          max={180}
          step={1}
          onChange={(v) => setMesh({ yawDeg: v })}
          format={formatDeg}
        />
        <SliderRow
          label="tilt"
          value={mesh.tiltDeg}
          min={-180}
          max={180}
          step={1}
          onChange={(v) => setMesh({ tiltDeg: v })}
          format={formatDeg}
        />
        <SliderRow
          label="y-off"
          value={mesh.offsetY}
          min={-3}
          max={3}
          step={0.01}
          onChange={(v) => setMesh({ offsetY: v })}
          format={formatMeters}
        />
        <SliderRow
          label="bead"
          value={mapping.ledSize}
          min={0.005}
          max={0.02}
          step={0.001}
          onChange={(v) => setMapping({ ledSize: v })}
          format={formatMillimeters}
        />
        <SliderRow
          label="max seg"
          value={mapping.maxSegmentLength}
          min={0.01}
          max={0.1}
          step={0.001}
          onChange={(v) => setMapping({ maxSegmentLength: v })}
          format={formatSmallDistance}
        />
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 4,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={mapping.flipUpDown}
            onChange={(e) => setMapping({ flipUpDown: e.target.checked })}
          />
          <span>Flip up/down</span>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 4,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={mapping.flipLeftRight}
            onChange={(e) => setMapping({ flipLeftRight: e.target.checked })}
          />
          <span>Flip left/right</span>
        </label>
      </Section>

      <Section title={`Place & shape — ${count} LED${count === 1 ? "" : "s"}`}>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={mapping.showOffsetsAndDomes !== false}
            onChange={(e) =>
              setMapping({
                showOffsetsAndDomes: e.target.checked,
                ...(e.target.checked ? {} : { tool: "place" }),
              })
            }
          />
          <span>Show offsets and domes</span>
        </label>
        <div
          style={{
            display: "flex",
            gap: 6,
            marginBottom: 8,
          }}
        >
          <ToolButton
            active={tool === "place"}
            onClick={() => setMapping({ tool: "place" })}
          >
            Place
          </ToolButton>
          {mapping.showOffsetsAndDomes !== false && (
            <>
              <ToolButton
                active={tool === "offset"}
                onClick={() => setMapping({ tool: "offset" })}
              >
                Offset
              </ToolButton>
              <ToolButton
                active={tool === "gaussian"}
                onClick={() => setMapping({ tool: "gaussian" })}
              >
                Dome
              </ToolButton>
            </>
          )}
        </div>
        <div style={{ opacity: 0.7, lineHeight: 1.4, marginBottom: 8 }}>
          {tool === "place" || mapping.showOffsetsAndDomes === false
            ? "Click the cloud surface to place the next LED. Drag a bead to slide it on the surface. You can only add or delete at the end of the string."
            : tool === "offset"
              ? "Drag a bead along its surface normal to offset it without changing the hand-placed position."
              : "Click the surface to place a smooth dome. Drag its marker to move the centre, then shape its peak and footprint below."}
        </div>
        {mapping.showOffsetsAndDomes !== false &&
          tool === "offset" &&
          selected !== null &&
          mapping.leds[selected] && (
          <div style={{ marginBottom: 8, opacity: 0.85 }}>
            LED #{displayNumber(selected)} offset:{" "}
            {((mapping.leds[selected].offset ?? 0) * 100).toFixed(1)} cm
          </div>
        )}
        {mapping.showOffsetsAndDomes !== false && tool === "gaussian" && (
          <>
            <div style={{ marginBottom: 6, opacity: 0.85 }}>
              {gaussians.length} dome{gaussians.length === 1 ? "" : "s"}
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 8,
              }}
              title="Show the compact 3D dome surface used to displace and orient LEDs"
            >
              <input
                type="checkbox"
                checked={mapping.showBumpSurfaces}
                onChange={(e) =>
                  setMapping({ showBumpSurfaces: e.target.checked })
                }
              />
              Show 3D dome shape
            </label>
            <SliderRow
              label="Dome block"
              value={mapping.bumpLightOpacity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setMapping({ bumpLightOpacity: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <SliderRow
              label="Pyr block"
              value={mapping.pyramidLightOpacity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setMapping({ pyramidLightOpacity: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <SliderRow
              label="Additive"
              value={mapping.bumpAdditivity}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setMapping({ bumpAdditivity: v })}
              format={(v) => `${Math.round(v * 100)}%`}
            />
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
              <Button
                onClick={() =>
                  setMapping({
                    bakeSurfaceRequestNonce: mapping.bakeSurfaceRequestNonce + 1,
                  })
                }
                disabled={gaussians.length === 0}
              >
                Bake surface
              </Button>
              <Button
                danger
                onClick={() => {
                  clearBakedSurfaceGeometry();
                  setMapping({
                    bakedSurfaceSignature: null,
                    showBakedSurface: false,
                    useBakedSurface: false,
                  });
                }}
                disabled={!mapping.bakedSurfaceSignature}
              >
                Clear bake
              </Button>
            </div>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 8,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={mapping.showBakedSurface}
                disabled={!mapping.bakedSurfaceSignature}
                onChange={(e) => setMapping({ showBakedSurface: e.target.checked })}
              />
              <span>Show baked surface</span>
            </label>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginTop: 4,
                cursor: "not-allowed",
                opacity: 0.7,
              }}
              title="Disabled: baked occlusion is slower than realtime domes."
            >
              <input
                type="checkbox"
                checked={false}
                disabled
                onChange={() => {}}
              />
              <span>Use baked surface for occlusion (disabled)</span>
            </label>
            <div style={{ marginTop: 5, opacity: 0.72, fontSize: 10 }}>
              Bake status:{" "}
              {mapping.bakedSurfaceSignature
                ? bakeUpToDate
                  ? "up to date"
                  : "stale (rebake recommended)"
                : "not baked"}
            </div>
          </>
        )}
        {mapping.showOffsetsAndDomes !== false &&
          tool === "gaussian" &&
          selectedGaussian && (
          <div
            style={{
              display: "grid",
              gap: 8,
              marginBottom: 10,
              padding: 8,
              background: "rgba(255,255,255,0.04)",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.1)",
            }}
          >
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ opacity: 0.75 }}>
                peak height {(selectedGaussian.amplitude * 100).toFixed(1)} cm
              </span>
              <input
                type="range"
                min={0}
                max={0.5}
                step={0.005}
                value={selectedGaussian.amplitude}
                onChange={(e) =>
                  updateMappingGaussian(selectedGaussian.id, {
                    amplitude: Number(e.target.value),
                  })
                }
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ opacity: 0.75 }}>
                horizontal radius{" "}
                {(selectedGaussian.width * DOME_FOOTPRINT_SCALE * 100).toFixed(1)} cm
              </span>
              <input
                type="range"
                min={0.01}
                max={1.25}
                step={0.005}
                value={selectedGaussian.width * DOME_FOOTPRINT_SCALE}
                onChange={(e) =>
                  updateMappingGaussian(selectedGaussian.id, {
                    width: Number(e.target.value) / DOME_FOOTPRINT_SCALE,
                  })
                }
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ opacity: 0.75 }}>
                vertical radius{" "}
                {(selectedGaussian.height * DOME_FOOTPRINT_SCALE * 100).toFixed(1)} cm
              </span>
              <input
                type="range"
                min={0.01}
                max={1.25}
                step={0.005}
                value={selectedGaussian.height * DOME_FOOTPRINT_SCALE}
                onChange={(e) =>
                  updateMappingGaussian(selectedGaussian.id, {
                    height: Number(e.target.value) / DOME_FOOTPRINT_SCALE,
                  })
                }
              />
            </label>
            <label style={{ display: "grid", gap: 4 }}>
              <span style={{ opacity: 0.75 }}>
                rotation {Math.round(selectedGaussian.rotationDeg ?? 0)}°
              </span>
              <input
                type="range"
                min={0}
                max={360}
                step={1}
                value={selectedGaussian.rotationDeg ?? 0}
                onChange={(e) =>
                  updateMappingGaussian(selectedGaussian.id, {
                    rotationDeg: Number(e.target.value),
                  })
                }
              />
            </label>
            <Button
              danger
              onClick={() => {
                removeMappingGaussian(selectedGaussian.id);
                setSelectedGaussianId(null);
              }}
            >
              Delete dome
            </Button>
          </div>
        )}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 8,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={reversed}
            onChange={(e) => setMapping({ reversed: e.target.checked })}
          />
          <span>Reverse direction (last placed = #1)</span>
        </label>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <Button onClick={deleteLast} disabled={count === 0} danger>
            Delete last (#{endNumber})
          </Button>
          <Button
            onClick={() => {
              if (
                confirmDestructiveClear(`all ${count} mapped LEDs`)
              ) {
                clearMappedLeds();
                setSelected(null);
              }
            }}
            disabled={count === 0}
            danger
          >
            Clear all
          </Button>
          <Button
            onClick={() => {
              if (
                confirmDestructiveClear(
                  `all ${gaussians.length} mapping domes and LED offsets`,
                )
              ) {
                clearMappingBumps();
                setSelectedGaussianId(null);
              }
            }}
            disabled={
              gaussians.length === 0 &&
              !mapping.leds.some((l) => (l.offset ?? 0) > 0)
            }
            danger
          >
            Clear domes
          </Button>
        </div>
      </Section>

      <Section title="Selected LED">
        {selected === null ? (
          <div style={{ opacity: 0.6 }}>Select an LED to nudge it.</div>
        ) : (
          <>
            <div style={{ marginBottom: 8, opacity: 0.85 }}>
              LED #{displayNumber(selected)}
              {selected === lastIndex ? " (end)" : ""}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, 1fr)",
                gap: 6,
              }}
            >
              <Button onClick={() => nudge(-NUDGE_RAD, 0)}>◀ around</Button>
              <Button onClick={() => nudge(NUDGE_RAD, 0)}>around ▶</Button>
              <Button onClick={() => nudge(0, NUDGE_RAD)}>▲ up</Button>
              <Button onClick={() => nudge(0, -NUDGE_RAD)}>▼ down</Button>
            </div>
          </>
        )}
      </Section>

      <Section title="Configuration" defaultOpen={false}>
        <ConfigButtons
          onLoaded={() => {
            setSelected(null);
            setSelectedGaussianId(null);
          }}
        />
      </Section>
      </Panel>

      <Panel side="right" title="Preview & output">
      <Section title="Mapping light">
        <label
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 7,
          }}
        >
          <span style={{ opacity: 0.75 }}>Colour</span>
          <ColorInput
            color={mapping.mappingLightColor}
            onChange={(color) => setMapping({ mappingLightColor: color })}
            compact
          />
        </label>
        <SliderRow
          label="Orbit"
          value={mapping.mappingLightAngleDeg}
          min={0}
          max={360}
          step={1}
          onChange={(v) => setMapping({ mappingLightAngleDeg: v })}
          format={(v) => `${Math.round(v)}°`}
        />
        <SliderRow
          label="Vertical"
          value={mapping.mappingLightElevationDeg}
          min={0}
          max={360}
          step={1}
          onChange={(v) => setMapping({ mappingLightElevationDeg: v })}
          format={(v) => `${Math.round(v)}°`}
        />
        <SliderRow
          label="Distance"
          value={mapping.mappingLightRadius}
          min={0.25}
          max={20}
          step={0.05}
          onChange={(v) => setMapping({ mappingLightRadius: v })}
          format={(v) => `${v.toFixed(2)}m`}
        />
        <SliderRow
          label="Intensity"
          value={mapping.mappingLightIntensity}
          min={0}
          max={5}
          step={0.05}
          onChange={(v) => setMapping({ mappingLightIntensity: v })}
          format={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Spread"
          value={mapping.mappingLightSpread}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setMapping({ mappingLightSpread: v })}
          format={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Beam focus"
          value={mapping.mappingLightFocus}
          min={0}
          max={1}
          step={0.01}
          onChange={(v) => setMapping({ mappingLightFocus: v })}
          format={(v) => v.toFixed(2)}
        />
        <SliderRow
          label="Distance falloff"
          value={mapping.mappingLightDecay}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => setMapping({ mappingLightDecay: v })}
          format={(v) => (v === 0 ? "off" : `d^-${v.toFixed(2)}`)}
        />
      </Section>

      <Section title="Sensor hemisphere">
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={mapping.showBallSensors}
            onChange={(e) =>
              setMapping({ showBallSensors: e.target.checked })
            }
          />
          <span>Show sensor hemispheres</span>
        </label>
        <SliderRow
          label="Size"
          value={strand.ledSize}
          min={0.005}
          max={0.2}
          step={0.005}
          onChange={(v) => setStrand({ ledSize: v })}
          format={(v) => `${(v * 100).toFixed(1)}cm`}
        />
        <SliderRow
          label="Focus"
          value={strand.sensorHemisphereFocus}
          min={0}
          max={12}
          step={0.1}
          onChange={(v) => setStrand({ sensorHemisphereFocus: v })}
          format={(v) => v.toFixed(1)}
        />
        <SliderRow
          label="Output gamma"
          value={strand.colorProfile.brightnessGamma}
          min={0.25}
          max={3}
          step={0.05}
          onChange={(value) =>
            setStrand({
              colorProfile: {
                ...strand.colorProfile,
                brightnessGamma: value,
              },
            })
          }
          format={(value) => value.toFixed(2)}
        />
        <div style={{ fontSize: 10, opacity: 0.62, lineHeight: 1.35 }}>
          Shared with the simulator. Size controls the physical area sampled;
          focus biases averaging toward the outward normal.
        </div>
      </Section>

      <Section title="WLED output">
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={wled.enabled}
            onChange={(e) => setWled({ enabled: e.target.checked })}
          />
          Stream mapping light to WLED
        </label>
        <label style={{ display: "grid", gap: 3, marginTop: 7 }}>
          <span style={{ opacity: 0.7 }}>Host</span>
          <input
            type="text"
            value={wled.host}
            onChange={(e) => setWled({ host: e.target.value })}
            style={{
              background: "rgba(255,255,255,0.06)",
              color: "inherit",
              border: "1px solid rgba(255,255,255,0.18)",
              borderRadius: 5,
              padding: "5px 7px",
            }}
          />
        </label>
        <SliderRow
          label="FPS"
          value={wled.fps}
          min={1}
          max={60}
          step={1}
          onChange={(v) => setWled({ fps: v })}
          format={(v) => `${Math.round(v)}`}
        />
      </Section>

      <Section title={`LED list — ${count}`} defaultOpen={false}>
        <div style={{ display: "grid", gap: 3 }}>
          {count === 0 && <div style={{ opacity: 0.6 }}>No LEDs placed yet.</div>}
          {mapping.leds.map((_, k) => {
            // Render in logical (numbered) order; map back to placement index.
            const i = reversed ? count - 1 - k : k;
            return (
              <button
                key={i}
                onClick={() => setSelected(i)}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  textAlign: "left",
                  background:
                    i === selected
                      ? "rgba(70,225,110,0.16)"
                      : "rgba(255,255,255,0.04)",
                  border: `1px solid ${
                    i === selected
                      ? "rgba(70,225,110,0.4)"
                      : "rgba(255,255,255,0.08)"
                  }`,
                  color: "inherit",
                  borderRadius: 6,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontSize: 11,
                }}
              >
                <span>LED #{k + 1}</span>
                {i === lastIndex && (
                  <span style={{ opacity: 0.7, color: "#7ef0a3" }}>end</span>
                )}
              </button>
            );
          })}
        </div>
      </Section>
      </Panel>
    </div>
  );
}

function Panel({
  side,
  title,
  children,
}: {
  side: "left" | "right";
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        [side]: 0,
        width: "min(300px, calc(50vw - 24px))",
        overflowY: "auto",
        pointerEvents: "auto",
        background: "rgba(10, 12, 20, 0.82)",
        backdropFilter: "blur(8px)",
        borderRadius: 12,
        boxShadow: "0 1px 0 rgba(255,255,255,0.05) inset",
        color: "rgba(207,214,230,0.95)",
        padding: "12px 12px 14px",
        boxSizing: "border-box",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        fontSize: 12,
      }}
    >
      {title && (
        <div
          style={{
            textTransform: "uppercase",
            letterSpacing: 0.6,
            opacity: 0.75,
            fontSize: 11,
            marginBottom: 10,
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div
      style={{
        marginBottom: 12,
        paddingBottom: 10,
        borderBottom: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          width: "100%",
          padding: 0,
          border: 0,
          background: "transparent",
          color: "inherit",
          cursor: "pointer",
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.45,
          opacity: 0.65,
          marginBottom: open ? 8 : 0,
          textAlign: "left",
        }}
      >
        <span>{title}</span>
        <span aria-hidden="true" style={{ fontSize: 11 }}>
          {open ? "−" : "+"}
        </span>
      </button>
      {open && children}
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
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns:
          "minmax(38px, 44px) minmax(40px, 1fr) minmax(44px, 60px)",
        alignItems: "center",
        gap: 8,
        marginBottom: 6,
      }}
    >
      <span style={{ opacity: 0.75 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%" }}
      />
      <span
        style={{
          textAlign: "right",
          opacity: 0.82,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {format ? format(value) : value.toFixed(2)}
      </span>
    </label>
  );
}

// All scene distances are in metres (three.js world units). These helpers
// pick a friendly unit per magnitude so the readout matches the physical
// scale you'd measure on the real cloud.
function formatMeters(v: number): string {
  return `${v.toFixed(2)} m`;
}

function formatMillimeters(v: number): string {
  return `${(v * 1000).toFixed(0)} mm`;
}

function formatSmallDistance(v: number): string {
  return v < 1 ? `${(v * 100).toFixed(1)} cm` : `${v.toFixed(2)} m`;
}

function formatDeg(v: number): string {
  return `${v.toFixed(0)}°`;
}

function formatScale(v: number): string {
  return `${v.toFixed(2)}×`;
}

function ConfigButtons({ onLoaded }: { onLoaded: () => void }) {
  const [file, setFile] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Show which file subsequent Saves will write to.
    boundFileName().then(setFile);
  }, []);
  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      console.warn("[config] file I/O failed", err);
      setStatus(`Error: ${(err as Error).message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <Button
          disabled={busy || !file}
          onClick={() =>
            wrap(async () => {
              await saveToFile();
              setFile(await boundFileName());
              setStatus(`Saved to ${await boundFileName()}`);
            })
          }
        >
          Save
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            wrap(async () => {
              await saveToFile({ forcePicker: true });
              setFile(await boundFileName());
              setStatus(`Saved to ${await boundFileName()}`);
            })
          }
        >
          Save as…
        </Button>
        <Button
          disabled={busy}
          onClick={() =>
            wrap(async () => {
              const res = await loadFromFile();
              if (!res) return;
              setFile(res.fileName);
              onLoaded();
              const missing = summariseMissing(res.missingAssets);
              setStatus(missing ?? `Loaded ${res.fileName}`);
            })
          }
        >
          Open…
        </Button>
      </div>
      <div style={{ fontSize: 10, opacity: 0.7, lineHeight: 1.4 }}>
        {file ? `Bound to ${file}` : "No file bound. Use ‘Save as…’ to create one."}
      </div>
      {status && (
        <div style={{ fontSize: 10, opacity: 0.85, lineHeight: 1.4 }}>{status}</div>
      )}
    </div>
  );
}

function Button({
  onClick,
  children,
  disabled,
  danger,
}: {
  onClick: () => void;
  children: React.ReactNode;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: danger
          ? "rgba(255,90,90,0.14)"
          : "rgba(255,255,255,0.06)",
        color: "inherit",
        border: `1px solid ${
          danger ? "rgba(255,90,90,0.35)" : "rgba(255,255,255,0.15)"
        }`,
        borderRadius: 6,
        padding: "4px 10px",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.45 : 1,
        fontSize: 11,
      }}
    >
      {children}
    </button>
  );
}

function ToolButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        background: active
          ? "rgba(111,168,255,0.22)"
          : "rgba(255,255,255,0.06)",
        color: "inherit",
        border: `1px solid ${
          active ? "rgba(111,168,255,0.55)" : "rgba(255,255,255,0.15)"
        }`,
        borderRadius: 6,
        padding: "5px 10px",
        cursor: "pointer",
        fontSize: 11,
        fontWeight: active ? 600 : 400,
      }}
    >
      {children}
    </button>
  );
}
