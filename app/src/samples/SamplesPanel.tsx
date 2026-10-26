import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import {
  useSimStore,
  type DroneLfoShape,
  type Sample,
  type SampleAutoParam,
  type SampleClip,
  DEFAULT_SAMPLE_TRACK,
  samplePlayDurationSec,
  sampleTrimRange,
} from "../state";
import { LFO_SHAPES, LfoScope } from "../drones/SynthSection";
import { putSampleBlob, deleteSampleBlob } from "./sampleStorage";
import { invalidateSamplePeaks } from "./samplePeaks";
import { SampleWaveform } from "./SampleWaveform";
import { getSampleEngine } from "../audio/SampleEngine";
import { SampleClipEditor } from "./SampleClipEditor";
import { SampleAutomationStrip } from "./SampleAutomationStrip";
import { ActivePeriodBand, PeriodTransportButtons } from "../components/PeriodOverlay";
import { CycleField } from "../components/CycleField";
import { AudioSoloButton } from "../components/AudioSoloButton";
import {
  confirmDestructiveClear,
  destructiveButtonStyle,
} from "../components/confirmDestructiveClear";

const HOURS = 24;
/** Clip waveform / placement area within each track row. */
const CLIP_LANE_HEIGHT = 56;
/** Param tabs + automation curve strip under each clip lane. */
const AUTO_STRIP_HEIGHT = 64;
/** Full row = clip lane + automation. */
const ROW_HEIGHT = CLIP_LANE_HEIGHT + AUTO_STRIP_HEIGHT;
const LIBRARY_WIDTH = 220;
/** Floor so very short clips stay clickable on the lane. */
const CLIP_MIN_WIDTH_PX = 8;
const ZOOM_MIN = 1;
const ZOOM_MAX = 24;

/** Simulated hours covered while the sample plays at the current
 *  day-cycle speed: playSec × (24 / cycleSeconds). */
function clipWidthHours(
  durationSec: number,
  playbackRate: number,
  cycleSeconds: number,
): number {
  const playSec = durationSec / Math.max(1e-6, playbackRate);
  return playSec * (HOURS / Math.max(1, cycleSeconds));
}

function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function fmtTime(hour: number): string {
  const h = ((hour % HOURS) + HOURS) % HOURS;
  const H = Math.floor(h);
  const M = Math.floor((h - H) * 60);
  return `${H.toString().padStart(2, "0")}:${M.toString().padStart(2, "0")}`;
}

function clampZoom(z: number): number {
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

/** Hour tick step for ruler/grid labels at the current zoom. */
function hourLabelStep(zoom: number): number {
  if (zoom >= 12) return 0.5;
  if (zoom >= 6) return 1;
  if (zoom >= 3) return 2;
  return 3;
}

function hourTicks(step: number): number[] {
  const out: number[] = [];
  const n = Math.round(HOURS / step);
  for (let i = 0; i < n; i++) out.push(Number((i * step).toFixed(4)));
  return out;
}

/**
 * Decode an uploaded file to measure duration. Uses the same
 * AudioContext Tone.js will play through, so channel/sample-rate
 * mismatches are handled once here.
 */
async function decodeDuration(arrayBuffer: ArrayBuffer): Promise<number> {
  const AC = (window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext) as typeof AudioContext;
  const ctx = new AC();
  try {
    const buf = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return buf.duration;
  } finally {
    if (ctx.state !== "closed") ctx.close().catch(() => undefined);
  }
}

interface DragState {
  kind: "move" | "library";
  // For move: the clip id being modified.
  clipId?: string;
  // For library drops: the sample being dropped.
  librarySampleId?: string;
  originHour: number;
  originStart: number;
  originLane: number;
}

/**
 * Samples arrangement editor. Layout:
 *
 *   [ header ]
 *   [ library sidebar | timeline (one lane per sample) ]
 *   [ clip editor (when selected) ]
 */
export function SamplesPanel() {
  const samples = useSimStore((s) => s.samples);
  const setSamples = useSimStore((s) => s.setSamples);
  const addSample = useSimStore((s) => s.addSample);
  const removeSample = useSimStore((s) => s.removeSample);
  const updateSample = useSimStore((s) => s.updateSample);
  const addSampleClip = useSimStore((s) => s.addSampleClip);
  const updateSampleClip = useSimStore((s) => s.updateSampleClip);
  const removeSampleClip = useSimStore((s) => s.removeSampleClip);
  const clearSampleClips = useSimStore((s) => s.clearSampleClips);
  const timeHours = useSimStore((s) => s.sky.timeHours);
  const sky = useSimStore((s) => s.sky);
  const setSky = useSimStore((s) => s.setSky);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const rollRef = useRef<HTMLDivElement | null>(null);
  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const zoomAnchorRef = useRef<{ hour: number; viewX: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbingRef = useRef(false);
  const [dragSampleId, setDragSampleId] = useState<string | null>(null);
  /** Active automation param per library track id. */
  const [autoParamBySample, setAutoParamBySample] = useState<
    Record<string, SampleAutoParam>
  >({});

  const laneIndexBySampleId = useMemo(() => {
    const m = new Map<string, number>();
    samples.library.forEach((s, i) => m.set(s.id, i));
    return m;
  }, [samples.library]);
  const sampleById = useMemo(() => {
    const m = new Map<string, Sample>();
    for (const s of samples.library) m.set(s.id, s);
    return m;
  }, [samples.library]);

  const laneCount = Math.max(1, samples.library.length);
  const rollHeight = laneCount * ROW_HEIGHT;
  const labelStep = hourLabelStep(zoom);
  const rulerHours = useMemo(() => hourTicks(labelStep), [labelStep]);

  const clientToHourLane = useCallback((clientX: number, clientY: number) => {
    const grid = rollRef.current?.querySelector<HTMLDivElement>("[data-grid]");
    if (!grid) return { hour: 0, lane: 0 };
    const rect = grid.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height - 1, clientY - rect.top));
    return {
      hour: (x / rect.width) * HOURS,
      lane: Math.floor(y / ROW_HEIGHT),
    };
  }, []);

  /** Change zoom, optionally keeping the hour under `clientX` fixed in view. */
  const applyZoom = useCallback(
    (next: number | ((prev: number) => number), clientX?: number) => {
      const prev = zoomRef.current;
      const clamped = clampZoom(
        typeof next === "function" ? next(prev) : next,
      );
      if (clamped === prev) return;

      const scrollEl = timelineScrollRef.current;
      const content = scrollEl?.firstElementChild as HTMLElement | null;
      const contentWidth = content?.offsetWidth ?? scrollEl?.clientWidth ?? 0;
      if (scrollEl && contentWidth > 0) {
        const viewX =
          clientX != null
            ? clientX - scrollEl.getBoundingClientRect().left
            : scrollEl.clientWidth / 2;
        const hour =
          ((scrollEl.scrollLeft + viewX) / contentWidth) * HOURS;
        zoomAnchorRef.current = { hour, viewX };
      }

      zoomRef.current = clamped;
      setZoom(clamped);
    },
    [],
  );

  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;
    const scrollEl = timelineScrollRef.current;
    const content = scrollEl?.firstElementChild as HTMLElement | null;
    if (!scrollEl || !content) return;
    const contentWidth = content.offsetWidth;
    scrollEl.scrollLeft =
      (anchor.hour / HOURS) * contentWidth - anchor.viewX;
  }, [zoom]);

  // Ctrl/Cmd + wheel zooms the arrangement toward the cursor.
  useEffect(() => {
    const el = timelineScrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
      applyZoom((z) => z * factor, e.clientX);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [applyZoom]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      setUploading(true);
      try {
        for (const file of Array.from(files)) {
          const buffer = await file.arrayBuffer();
          let durationSec = 0;
          try {
            durationSec = await decodeDuration(buffer);
          } catch (err) {
            console.warn("[samples] decode failed", file.name, err);
            continue;
          }
          const id = newId("sample");
          const blob = new Blob([buffer], { type: file.type || "audio/wav" });
          await putSampleBlob(id, blob);
          const meta: Sample = {
            id,
            name: file.name.replace(/\.[^.]+$/, ""),
            durationSec,
            ...DEFAULT_SAMPLE_TRACK,
            trimEndSec: durationSec,
          };
          addSample(meta);
          // Preload into the engine so first placement plays instantly.
          getSampleEngine()
            .ensureSampleLoaded(meta)
            .catch(() => undefined);
        }
      } finally {
        setUploading(false);
      }
    },
    [addSample],
  );

  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    void handleFiles(e.target.files);
    e.target.value = "";
  };

  const deleteSample = useCallback(
    async (id: string) => {
      if (!confirm("Delete this sample and all its clips?")) return;
      removeSample(id);
      invalidateSamplePeaks(id);
      await deleteSampleBlob(id).catch(() => undefined);
    },
    [removeSample],
  );

  const beginClipDrag = (e: React.PointerEvent, clipId: string) => {
    const clip = samples.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const { hour } = clientToHourLane(e.clientX, e.clientY);
    dragRef.current = {
      kind: "move",
      clipId,
      originHour: hour,
      originStart: clip.startHour,
      originLane: laneIndexBySampleId.get(clip.sampleId) ?? 0,
    };
    setSelectedId(clipId);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.stopPropagation();
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (scrubbingRef.current) {
        const { hour } = clientToHourLane(e.clientX, e.clientY);
        setSky({ timeHours: Math.max(0, Math.min(24, hour)) });
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const { hour } = clientToHourLane(e.clientX, e.clientY);
      const dHour = hour - drag.originHour;
      if (drag.kind === "move" && drag.clipId) {
        const start = Math.max(0, Math.min(HOURS, drag.originStart + dHour));
        updateSampleClip(drag.clipId, { startHour: start });
      }
    };
    const onUp = () => {
      dragRef.current = null;
      scrubbingRef.current = false;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [clientToHourLane, samples.clips, setSky, updateSampleClip]);

  // Delete key removes selected clip.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedId &&
        !isTypingTarget(e.target)
      ) {
        removeSampleClip(selectedId);
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, removeSampleClip]);

  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).dataset.clipId) return;
    // Empty click: deselect (and, if a library-drag was in flight, drop it).
    setSelectedId(null);
  };

  // Drop from the library sidebar onto a lane.
  const onLaneDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragSampleId) return;
    e.preventDefault();
  };
  const onLaneDrop = (e: React.DragEvent<HTMLDivElement>) => {
    if (!dragSampleId) return;
    e.preventDefault();
    const { hour } = clientToHourLane(e.clientX, e.clientY);
    const sample = sampleById.get(dragSampleId);
    if (!sample) return;
    const clip: SampleClip = {
      id: newId("clip"),
      sampleId: dragSampleId,
      startHour: Math.max(0, Math.min(HOURS - 0.05, hour)),
    };
    addSampleClip(clip);
    setSelectedId(clip.id);
    setDragSampleId(null);
  };

  const selectedClip = useMemo(
    () => samples.clips.find((c) => c.id === selectedId) ?? null,
    [samples.clips, selectedId],
  );

  return (
    <div style={panelStyle}>
      <header style={headerStyle}>
        <Link to="/" style={linkStyle}>
          ← simulator
        </Link>
        <Link to="/drones" style={linkStyle}>
          Drones
        </Link>
        <Link to="/pads" style={linkStyle}>
          Pads
        </Link>
        <span style={{ marginLeft: 8, fontSize: 16, fontWeight: 600 }}>
          Samples
        </span>
        <AudioSoloButton instrument="samples" accent="#fb923c" />
        <button
          onClick={() => setSky({ autoPlay: !sky.autoPlay })}
          style={{
            ...btn,
            background: sky.autoPlay
              ? "rgba(255,225,77,0.25)"
              : "rgba(251,146,60,0.2)",
            borderColor: sky.autoPlay
              ? "rgba(255,225,77,0.6)"
              : "rgba(251,146,60,0.5)",
            minWidth: 78,
          }}
        >
          {sky.autoPlay ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button
          onClick={() => setSky({ timeHours: 0 })}
          style={btn}
          title="Rewind to 00:00"
        >
          ⏮ 00:00
        </button>
        <PeriodTransportButtons />
        <CycleField labelStyle={row} inputStyle={numInput} />
        <label style={row}>
          <input
            type="checkbox"
            checked={samples.enabled}
            onChange={(e) => setSamples({ enabled: e.target.checked })}
          />
          <span>Enable</span>
        </label>
        <label style={{ ...row, minWidth: 180 }}>
          <span style={{ fontSize: 11, width: 40 }}>Master</span>
          <input
            type="range"
            min={0}
            max={3}
            step={0.01}
            value={samples.master}
            onChange={(e) => setSamples({ master: parseFloat(e.target.value) })}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: 10, width: 32, textAlign: "right", opacity: 0.8 }}>
            {samples.master.toFixed(2)}
          </span>
        </label>
        <button
          onClick={() => fileInputRef.current?.click()}
          style={{ ...btn, marginLeft: 4 }}
          disabled={uploading}
        >
          {uploading ? "Uploading…" : "+ Upload"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*"
          multiple
          onChange={onPickFiles}
          style={{ display: "none" }}
        />
        <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
          {fmtTime(timeHours)}
        </div>
      </header>

      <div style={bodyScrollStyle}>
        <section
          style={{
            padding: "6px 10px",
            borderBottom: "1px solid rgba(255,255,255,0.06)",
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <strong style={{ fontSize: 12 }}>Master</strong>
          <MasterFxSlider
            label="Ptc LFO Hz"
            min={0}
            max={2}
            step={0.01}
            value={samples.pitchLfoRateHz}
            onChange={(v) => setSamples({ pitchLfoRateHz: v })}
            fmt={(v) => `${v.toFixed(2)}`}
          />
          <MasterFxSlider
            label="Ptc LFO ¢"
            min={0}
            max={50}
            step={1}
            value={samples.pitchLfoDepthCents}
            onChange={(v) => setSamples({ pitchLfoDepthCents: Math.round(v) })}
            fmt={(v) => `±${v.toFixed(0)}`}
          />
          <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11 }}>
            <span style={{ opacity: 0.8 }}>Shape</span>
            <select
              value={samples.pitchLfoShape}
              onChange={(e) =>
                setSamples({ pitchLfoShape: e.target.value as DroneLfoShape })
              }
              style={{ fontSize: 11 }}
            >
              {LFO_SHAPES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <div style={{ minWidth: 200, maxWidth: 280 }}>
            <LfoScope
              rateHz={samples.pitchLfoRateHz}
              depth={Math.min(1, samples.pitchLfoDepthCents / 50)}
              shape={samples.pitchLfoShape}
              colorStroke="rgba(255,225,77,0.9)"
              colorFill="rgba(255,225,77,0.12)"
              label={`${samples.pitchLfoRateHz.toFixed(2)} Hz · ±${samples.pitchLfoDepthCents}¢`}
            />
          </div>
          <MasterFxSlider
            label="Reverb"
            min={0}
            max={1}
            step={0.01}
            value={samples.reverbMix}
            onChange={(v) => setSamples({ reverbMix: v })}
            fmt={(v) => v.toFixed(2)}
          />
          <MasterFxSlider
            label="Rvb size"
            min={0}
            max={0.99}
            step={0.01}
            value={samples.reverbDecay}
            onChange={(v) => setSamples({ reverbDecay: v })}
            fmt={(v) => v.toFixed(2)}
          />
          <MasterFxSlider
            label="Delay"
            min={0}
            max={1}
            step={0.01}
            value={samples.delayMix}
            onChange={(v) => setSamples({ delayMix: v })}
            fmt={(v) => v.toFixed(2)}
          />
          <MasterFxSlider
            label="Dly time"
            min={0}
            max={2}
            step={0.01}
            value={samples.delayTimeSec}
            onChange={(v) => setSamples({ delayTimeSec: v })}
            fmt={(v) => `${v.toFixed(2)}s`}
          />
          <MasterFxSlider
            label="Dly fbk"
            min={0}
            max={0.9}
            step={0.01}
            value={samples.delayFeedback}
            onChange={(v) => setSamples({ delayFeedback: v })}
            fmt={(v) => v.toFixed(2)}
          />
        </section>
        <section style={rollSectionStyle}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 12 }}>Arrangement</strong>
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              drag a sample from the library onto a lane · drag block to move
              · Del to remove · drag ruler to scrub · ⌘/Ctrl+wheel to zoom ·
              click automation strip for Vol/Pan/Filter/Rev/Delay curves ·
              audio follows the playhead through each clip
            </span>
            <label
              style={{
                ...row,
                marginLeft: "auto",
                fontSize: 11,
                gap: 6,
              }}
              title="Zoom the time axis (also ⌘/Ctrl + scroll)"
            >
              Zoom
              <button
                type="button"
                style={{ ...btn, padding: "1px 7px" }}
                onClick={() => applyZoom(zoom / 1.25)}
                disabled={zoom <= ZOOM_MIN}
              >
                −
              </button>
              <input
                type="range"
                min={ZOOM_MIN}
                max={ZOOM_MAX}
                step={0.1}
                value={zoom}
                onChange={(e) => applyZoom(parseFloat(e.target.value))}
                style={{ width: 100 }}
              />
              <button
                type="button"
                style={{ ...btn, padding: "1px 7px" }}
                onClick={() => applyZoom(zoom * 1.25)}
                disabled={zoom >= ZOOM_MAX}
              >
                +
              </button>
              <span
                style={{
                  width: 36,
                  textAlign: "right",
                  fontVariantNumeric: "tabular-nums",
                  opacity: 0.85,
                }}
              >
                {zoom < 10 ? zoom.toFixed(1) : zoom.toFixed(0)}×
              </span>
              <button
                type="button"
                style={btn}
                onClick={() => {
                  zoomAnchorRef.current = null;
                  zoomRef.current = 1;
                  setZoom(1);
                  const el = timelineScrollRef.current;
                  if (el) el.scrollLeft = 0;
                }}
                disabled={zoom === 1}
              >
                Fit
              </button>
            </label>
            <button
              style={{ ...btn, ...destructiveButtonStyle }}
              onClick={() => {
                if (
                  confirmDestructiveClear(
                    `all ${samples.clips.length} sample clips`,
                  )
                ) {
                  clearSampleClips();
                  setSelectedId(null);
                }
              }}
            >
              Clear clips
            </button>
          </div>

          <div ref={rollRef} style={arrangementWrap}>
            {/* Library sidebar */}
            <div style={librarySideStyle}>
              <div style={sideTitle}>Library</div>
              {samples.library.length === 0 && (
                <div style={emptyHint}>
                  Upload audio files to start arranging.
                </div>
              )}
              {samples.library.map((s) => (
                <div
                  key={s.id}
                  draggable
                  onDragStart={(e) => {
                    setDragSampleId(s.id);
                    e.dataTransfer.effectAllowed = "copy";
                    e.dataTransfer.setData("text/plain", s.id);
                  }}
                  onDragEnd={() => setDragSampleId(null)}
                  style={{
                    height: ROW_HEIGHT,
                    display: "flex",
                    alignItems: "stretch",
                    gap: 6,
                    padding: "4px 6px",
                    borderTop: "1px solid rgba(255,255,255,0.06)",
                    cursor: "grab",
                    background:
                      dragSampleId === s.id
                        ? "rgba(251,146,60,0.18)"
                        : "transparent",
                    boxSizing: "border-box",
                  }}
                  title={`Drag onto a lane · ${samplePlayDurationSec(s).toFixed(2)}s play / ${s.durationSec.toFixed(2)}s file`}
                >
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: "flex",
                      flexDirection: "column",
                      gap: 2,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        flexShrink: 0,
                      }}
                    >
                      {s.name}
                      <span style={{ fontSize: 9, opacity: 0.6, fontWeight: 400, marginLeft: 6 }}>
                        {samplePlayDurationSec(s).toFixed(2)}s
                      </span>
                    </div>
                    <div
                      style={{
                        flex: 1,
                        minHeight: 0,
                        position: "relative",
                        borderRadius: 3,
                        background: "rgba(0,0,0,0.35)",
                        overflow: "hidden",
                      }}
                    >
                      <SampleWaveform
                        sampleId={s.id}
                        color="rgba(251,146,60,0.85)"
                        trimStartFrac={
                          s.durationSec > 0
                            ? sampleTrimRange(s).start / s.durationSec
                            : 0
                        }
                        trimEndFrac={
                          s.durationSec > 0
                            ? sampleTrimRange(s).end / s.durationSec
                            : 1
                        }
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void getSampleEngine()
                        .previewSample(s)
                        .catch((err) =>
                          console.warn("[samples] preview failed", err),
                        );
                    }}
                    style={{
                      ...btn,
                      padding: "1px 5px",
                      fontSize: 10,
                      alignSelf: "center",
                    }}
                    title="Preview this track (ignores arrangement)"
                  >
                    ▶
                  </button>
                  <button
                    onClick={() => void deleteSample(s.id)}
                    style={{
                      ...btn,
                      padding: "1px 5px",
                      fontSize: 10,
                      alignSelf: "center",
                    }}
                    title="Delete sample"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>

            {/* Timeline — horizontal scroll when zoomed */}
            <div style={timelinePaneStyle}>
              <div ref={timelineScrollRef} style={timelineScrollStyle}>
                <div
                  style={{
                    width: `${zoom * 100}%`,
                    minWidth: "100%",
                    position: "relative",
                  }}
                >
                  {/* Scrubber ruler */}
                  <div
                    onPointerDown={(e) => {
                      scrubbingRef.current = true;
                      const { hour } = clientToHourLane(e.clientX, e.clientY);
                      setSky({ timeHours: Math.max(0, Math.min(24, hour)) });
                      (e.currentTarget as Element).setPointerCapture?.(
                        e.pointerId,
                      );
                      e.preventDefault();
                    }}
                    style={rulerStyle}
                    title="Drag to scrub"
                  >
                    <ActivePeriodBand opacity={0.3} />
                    {rulerHours.map((h) => (
                      <span
                        key={h}
                        style={{
                          position: "absolute",
                          left: `${(h / HOURS) * 100}%`,
                          top: 3,
                          fontSize: 9,
                          opacity: 0.7,
                          paddingLeft: 3,
                          pointerEvents: "none",
                        }}
                      >
                        {labelStep < 1
                          ? fmtTime(h)
                          : `${Math.floor(h).toString().padStart(2, "0")}h`}
                      </span>
                    ))}
                    <div style={playheadTop(timeHours)} />
                    <div style={playheadKnob(timeHours)} />
                  </div>

                  <div
                    data-grid
                    onPointerDown={onGridPointerDown}
                    onDragOver={onLaneDragOver}
                    onDrop={onLaneDrop}
                    style={{
                      position: "relative",
                      width: "100%",
                      height: rollHeight,
                      cursor: dragSampleId ? "copy" : "default",
                    }}
                  >
                    {/* Lane rows: clip band + automation strip */}
                    {samples.library.map((s, lane) => (
                      <div
                        key={s.id}
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          top: lane * ROW_HEIGHT,
                          height: ROW_HEIGHT,
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          background:
                            lane % 2 === 0
                              ? "rgba(255,255,255,0.015)"
                              : "rgba(255,255,255,0.035)",
                          pointerEvents: "none",
                        }}
                      >
                        <div
                          style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: CLIP_LANE_HEIGHT,
                            height: 1,
                            background: "rgba(255,255,255,0.06)",
                          }}
                        />
                      </div>
                    ))}
                    {samples.library.length === 0 && (
                      <div
                        style={{
                          position: "absolute",
                          left: 0,
                          right: 0,
                          top: 0,
                          height: ROW_HEIGHT,
                          borderTop: "1px solid rgba(255,255,255,0.08)",
                          background: "rgba(255,255,255,0.015)",
                          pointerEvents: "none",
                        }}
                      />
                    )}
                    {/* Hour gridlines — denser when zoomed */}
                    {Array.from(
                      {
                        length:
                          Math.round(HOURS / Math.min(labelStep, 1)) + 1,
                      },
                      (_, i) => {
                        const step = Math.min(labelStep, 1);
                        const h = i * step;
                        if (h > HOURS + 1e-9) return null;
                        const major = Math.abs(h % 6) < 1e-9;
                        const mid = Math.abs(h % 3) < 1e-9;
                        return (
                          <div
                            key={h}
                            style={{
                              position: "absolute",
                              top: 0,
                              bottom: 0,
                              left: `${(h / HOURS) * 100}%`,
                              width: 1,
                              background: major
                                ? "rgba(255,255,255,0.25)"
                                : mid
                                  ? "rgba(255,255,255,0.12)"
                                  : "rgba(255,255,255,0.05)",
                              pointerEvents: "none",
                            }}
                          />
                        );
                      },
                    )}
                    {/* Playhead */}
                    <div
                      style={{
                        position: "absolute",
                        top: 0,
                        bottom: 0,
                        left: `${(timeHours / HOURS) * 100}%`,
                        width: 2,
                        background: "#ffe14d",
                        pointerEvents: "none",
                      }}
                    />
                    {/* Clip spans — width = sky-hours the audio covers.
                        Left edge is `startHour`; playhead inside the
                        span seeks into the buffer. */}
                    {samples.clips.map((c) => {
                      const sample = sampleById.get(c.sampleId);
                      if (!sample) return null;
                      const lane = laneIndexBySampleId.get(c.sampleId);
                      if (lane === undefined) return null;
                      const leftPct = (c.startHour / HOURS) * 100;
                      const playDur = samplePlayDurationSec(sample);
                      const widthHours = clipWidthHours(
                        playDur,
                        sample.playbackRate,
                        sky.cycleSeconds,
                      );
                      const widthPct = (widthHours / HOURS) * 100;
                      const playSec =
                        playDur / Math.max(1e-6, sample.playbackRate);
                      const skyMinutes = widthHours * 60;
                      const isSel = c.id === selectedId;
                      return (
                        <div
                          key={c.id}
                          data-clip-id={c.id}
                          onPointerDown={(e) => beginClipDrag(e, c.id)}
                          style={{
                            position: "absolute",
                            top: lane * ROW_HEIGHT + 3,
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            minWidth: CLIP_MIN_WIDTH_PX,
                            height: CLIP_LANE_HEIGHT - 6,
                            background: isSel
                              ? "linear-gradient(180deg,#fb923c,#ea580c)"
                              : "linear-gradient(180deg,#c2410caa,#9a3412aa)",
                            border: `1px solid ${isSel ? "#fff" : "#7c2d12"}`,
                            borderLeft: `3px solid ${
                              isSel ? "#fff" : "#fdba74"
                            }`,
                            borderRadius: 4,
                            cursor: "grab",
                            boxSizing: "border-box",
                            overflow: "hidden",
                          }}
                          title={`${sample.name}  @ ${fmtTime(c.startHour)}  · ${playSec.toFixed(1)}s audio ≈ ${skyMinutes.toFixed(1)} sky-min  · rate ${sample.playbackRate.toFixed(2)}× gain ${sample.gain.toFixed(2)}`}
                        >
                          <SampleWaveform
                            sampleId={sample.id}
                            color={
                              isSel
                                ? "rgba(255,255,255,0.75)"
                                : "rgba(255,237,213,0.7)"
                            }
                            trimStartFrac={
                              sample.durationSec > 0
                                ? sampleTrimRange(sample).start /
                                  sample.durationSec
                                : 0
                            }
                            trimEndFrac={
                              sample.durationSec > 0
                                ? sampleTrimRange(sample).end /
                                  sample.durationSec
                                : 1
                            }
                            trimMode="crop"
                          />
                          <div
                            style={{
                              position: "absolute",
                              left: 4,
                              top: 3,
                              right: 4,
                              fontSize: 10,
                              color: "#1a0a05",
                              fontWeight: 700,
                              textShadow: "0 0 4px rgba(255,255,255,0.55)",
                              overflow: "hidden",
                              whiteSpace: "nowrap",
                              textOverflow: "ellipsis",
                              pointerEvents: "none",
                            }}
                          >
                            {sample.name}
                          </div>
                        </div>
                      );
                    })}
                    {/* Per-track automation strips under each clip lane */}
                    {samples.library.map((s, lane) => {
                      const param = autoParamBySample[s.id] ?? "gain";
                      return (
                        <div
                          key={`auto-${s.id}`}
                          style={{
                            position: "absolute",
                            left: 0,
                            right: 0,
                            top: lane * ROW_HEIGHT + CLIP_LANE_HEIGHT,
                            height: AUTO_STRIP_HEIGHT,
                            pointerEvents: "auto",
                            zIndex: 3,
                          }}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <SampleAutomationStrip
                            sample={s}
                            param={param}
                            onParamChange={(p) =>
                              setAutoParamBySample((prev) => ({
                                ...prev,
                                [s.id]: p,
                              }))
                            }
                            onChangeTrack={(patch) => updateSample(s.id, patch)}
                            playheadHour={timeHours}
                            height={AUTO_STRIP_HEIGHT}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div style={bottomLabelsStyle}>
                    {[...rulerHours, HOURS].map((h) => (
                      <span
                        key={h}
                        style={{
                          position: "absolute",
                          left: `${(h / HOURS) * 100}%`,
                          transform: h === HOURS ? "translateX(-100%)" : undefined,
                          paddingLeft: h === HOURS ? 0 : 2,
                          paddingRight: h === HOURS ? 2 : 0,
                        }}
                      >
                        {labelStep < 1
                          ? fmtTime(h)
                          : `${Math.floor(h).toString().padStart(2, "0")}h`}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {selectedClip && (
          <SampleClipEditor
            clip={selectedClip}
            sample={sampleById.get(selectedClip.sampleId)}
            onChangeTrack={(patch) =>
              updateSample(selectedClip.sampleId, patch)
            }
            onChangeClip={(patch) => updateSampleClip(selectedClip.id, patch)}
            onDelete={() => {
              removeSampleClip(selectedClip.id);
              setSelectedId(null);
            }}
          />
        )}
      </div>
    </div>
  );
}

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

const panelStyle: React.CSSProperties = {
  position: "fixed",
  inset: 12,
  zIndex: 10,
  background: "rgba(15, 8, 6, 0.9)",
  backdropFilter: "blur(8px)",
  color: "rgba(207,214,230,0.95)",
  padding: 14,
  borderRadius: 10,
  border: "1px solid rgba(255,255,255,0.12)",
  fontFamily:
    "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  minHeight: 0,
  overflow: "hidden",
};
const headerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};
const bodyScrollStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingRight: 4,
};
const rollSectionStyle: React.CSSProperties = {
  padding: "8px 0",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  flex: "1 0 300px",
  minHeight: 300,
};
const arrangementWrap: React.CSSProperties = {
  display: "flex",
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  background: "rgba(255,255,255,0.02)",
};
const timelinePaneStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};
const timelineScrollStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
};
const librarySideStyle: React.CSSProperties = {
  width: LIBRARY_WIDTH,
  flexShrink: 0,
  background: "rgba(0,0,0,0.35)",
  borderRight: "1px solid rgba(255,255,255,0.15)",
  display: "flex",
  flexDirection: "column",
};
const sideTitle: React.CSSProperties = {
  padding: "4px 8px",
  fontSize: 10,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  opacity: 0.7,
  fontWeight: 600,
  background: "rgba(0,0,0,0.6)",
  borderBottom: "1px solid rgba(255,255,255,0.12)",
  height: 22,
  display: "flex",
  alignItems: "center",
};
const emptyHint: React.CSSProperties = {
  padding: 10,
  fontSize: 10,
  opacity: 0.6,
  lineHeight: 1.4,
};
const rulerStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  zIndex: 3,
  height: 22,
  background: "rgba(0,0,0,0.7)",
  borderBottom: "1px solid rgba(255,255,255,0.25)",
  cursor: "ew-resize",
  userSelect: "none",
};
const bottomLabelsStyle: React.CSSProperties = {
  position: "relative",
  height: 16,
  fontSize: 9,
  opacity: 0.6,
  background: "rgba(0,0,0,0.5)",
  pointerEvents: "none",
};
const linkStyle: React.CSSProperties = {
  color: "rgba(207,214,230,0.95)",
  textDecoration: "none",
  fontSize: 12,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.15)",
  borderRadius: 6,
  padding: "3px 8px",
};
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
};
const btn: React.CSSProperties = {
  background: "rgba(251,146,60,0.2)",
  color: "rgba(207,214,230,0.95)",
  border: "1px solid rgba(251,146,60,0.5)",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
};
const numInput: React.CSSProperties = {
  width: 60,
  marginLeft: 4,
  background: "rgba(255,255,255,0.06)",
  color: "inherit",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 3,
  padding: "2px 4px",
  fontSize: 11,
};

function playheadTop(hour: number): React.CSSProperties {
  return {
    position: "absolute",
    left: `${(hour / HOURS) * 100}%`,
    top: 0,
    bottom: 0,
    width: 2,
    background: "#ffe14d",
    pointerEvents: "none",
  };
}
function MasterFxSlider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  fmt,
}: {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  fmt: (v: number) => string;
}) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        fontSize: 11,
      }}
    >
      <span style={{ width: 56, opacity: 0.8 }}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: 100 }}
      />
      <span
        style={{
          width: 44,
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          opacity: 0.85,
        }}
      >
        {fmt(value)}
      </span>
    </label>
  );
}

function playheadKnob(hour: number): React.CSSProperties {
  return {
    position: "absolute",
    left: `calc(${(hour / HOURS) * 100}% - 6px)`,
    top: 0,
    width: 12,
    height: 12,
    borderRadius: 6,
    background: "#ffe14d",
    border: "1px solid #7a6100",
    pointerEvents: "none",
  };
}
