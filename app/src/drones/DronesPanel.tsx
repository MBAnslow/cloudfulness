import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useSimStore, type DroneNote } from "../state";
import { getDroneEngine } from "../audio/DroneEngine";
import { AudioSoloButton } from "../components/AudioSoloButton";
import {
  confirmDestructiveClear,
  destructiveButtonStyle,
} from "../components/confirmDestructiveClear";
import { SynthSection } from "./SynthSection";
import { PostFxSection } from "./PostFxSection";
import { NoteEffectsPanel } from "./NoteEffectsPanel";
import { ActivePeriodBand, PeriodTransportButtons } from "../components/PeriodOverlay";
import { CycleField } from "../components/CycleField";

const HOURS = 24;

// Pitch range: MIDI 24 (C1) to MIDI 84 (C6) inclusive.
const MIDI_LOW = 24;
const MIDI_HIGH = 84;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set(["C#", "D#", "F#", "G#", "A#"]);

const ROW_HEIGHT = 14;
const GUTTER_WIDTH = 56;
const RESIZE_EDGE_PX = 6;
const DEFAULT_NOTE_LENGTH_H = 1;
const MIN_NOTE_LENGTH_H = 0.1;

function midiToName(m: number): string {
  const n = NAMES[((m % 12) + 12) % 12];
  const octave = Math.floor(m / 12) - 1;
  return `${n}${octave}`;
}

function isBlackMidi(m: number): boolean {
  return BLACK.has(NAMES[((m % 12) + 12) % 12]);
}

function fmtTime(hour: number): string {
  const h = ((hour % HOURS) + HOURS) % HOURS;
  const H = Math.floor(h);
  const M = Math.floor((h - H) * 60);
  return `${H.toString().padStart(2, "0")}:${M.toString().padStart(2, "0")}`;
}

function newNoteId(): string {
  return `drone-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

/** Row index (top-down) → midi number (highest pitch on top). */
function rowToMidi(row: number): number {
  return MIDI_HIGH - row;
}
function midiToRow(m: number): number {
  return MIDI_HIGH - m;
}

const PITCH_COUNT = MIDI_HIGH - MIDI_LOW + 1;
const ROLL_HEIGHT = PITCH_COUNT * ROW_HEIGHT;

interface DragState {
  kind: "move" | "resize-right" | "new";
  noteId: string;
  originHour: number;
  originStart: number;
  originEnd: number;
  originMidi: number;
  originRow: number;
}

export function DronesPanel() {
  const drone = useSimStore((s) => s.drone);
  const setDrone = useSimStore((s) => s.setDrone);
  const addDroneNote = useSimStore((s) => s.addDroneNote);
  const updateDroneNote = useSimStore((s) => s.updateDroneNote);
  const removeDroneNote = useSimStore((s) => s.removeDroneNote);
  const clearDroneNotes = useSimStore((s) => s.clearDroneNotes);
  const timeHours = useSimStore((s) => s.sky.timeHours);
  const sky = useSimStore((s) => s.sky);
  const setSky = useSimStore((s) => s.setSky);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rollWidth, setRollWidth] = useState(900);
  const [horizontalZoom, setHorizontalZoom] = useState(1);
  const [snapHours, setSnapHours] = useState(0.25);
  const rollRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const scrubbingRef = useRef(false);

  useEffect(() => {
    const el = rollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setRollWidth(el.clientWidth - GUTTER_WIDTH);
    });
    ro.observe(el);
    setRollWidth(el.clientWidth - GUTTER_WIDTH);
    return () => ro.disconnect();
  }, []);

  const pxPerHour = rollWidth / HOURS;
  const snapHour = useCallback(
    (hour: number) =>
      snapHours > 0 ? Math.round(hour / snapHours) * snapHours : hour,
    [snapHours],
  );

  const noteByMidi = useMemo(() => {
    const m = new Map<number, DroneNote[]>();
    for (const n of drone.notes) {
      // Parse note back to midi via a lookup — cheap enough at this scale.
      const midi = parseNoteToMidi(n.note);
      if (midi === null) continue;
      const list = m.get(midi) ?? [];
      list.push(n);
      m.set(midi, list);
    }
    return m;
  }, [drone.notes]);

  const clientToHourRow = useCallback(
    (clientX: number, clientY: number) => {
      const grid = rollRef.current?.querySelector<HTMLDivElement>("[data-grid]");
      if (!grid) return { hour: 0, row: 0 };
      const rect = grid.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
      const y = Math.max(0, Math.min(rect.height - 1, clientY - rect.top));
      return {
        hour: (x / rect.width) * HOURS,
        row: Math.floor(y / ROW_HEIGHT),
      };
    },
    [],
  );

  const beginDrag = (
    e: React.PointerEvent,
    kind: DragState["kind"],
    noteId: string,
  ) => {
    const n = drone.notes.find((x) => x.id === noteId);
    if (!n) return;
    const midi = parseNoteToMidi(n.note) ?? MIDI_LOW;
    const { hour } = clientToHourRow(e.clientX, e.clientY);
    dragRef.current = {
      kind,
      noteId,
      originHour: hour,
      originStart: n.startHour,
      originEnd: n.endHour,
      originMidi: midi,
      originRow: midiToRow(midi),
    };
    setSelectedId(noteId);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (scrubbingRef.current) {
        const { hour } = clientToHourRow(e.clientX, e.clientY);
        setSky({ timeHours: Math.max(0, Math.min(24, hour)) });
        return;
      }
      const drag = dragRef.current;
      if (!drag) return;
      const { hour, row } = clientToHourRow(e.clientX, e.clientY);
      const dHour = hour - drag.originHour;
      if (drag.kind === "move") {
        const dur = drag.originEnd - drag.originStart;
        let start = snapHour(drag.originStart + dHour);
        start = Math.max(0, Math.min(HOURS - dur, start));
        const rowClamped = Math.max(
          0,
          Math.min(PITCH_COUNT - 1, drag.originRow + (row - drag.originRow)),
        );
        const midi = rowToMidi(rowClamped);
        updateDroneNote(drag.noteId, {
          startHour: start,
          endHour: start + dur,
          note: midiToName(midi),
        });
      } else if (drag.kind === "resize-right" || drag.kind === "new") {
        const end = Math.max(
          drag.originStart + MIN_NOTE_LENGTH_H,
          Math.min(HOURS, snapHour(drag.originEnd + dHour)),
        );
        updateDroneNote(drag.noteId, { endHour: end });
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
  }, [clientToHourRow, updateDroneNote, setSky, snapHour]);

  // Delete key removes selected note.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedId &&
        !isTypingTarget(e.target)
      ) {
        removeDroneNote(selectedId);
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, removeDroneNote]);

  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Ignore clicks that hit a note (handled by its own handler).
    if ((e.target as HTMLElement).dataset.noteId) return;
    const { hour, row } = clientToHourRow(e.clientX, e.clientY);
    const midi = rowToMidi(row);
    const start = Math.max(
      0,
      Math.min(HOURS - MIN_NOTE_LENGTH_H, snapHour(hour)),
    );
    const end = Math.min(HOURS, start + DEFAULT_NOTE_LENGTH_H);
    const id = newNoteId();
    const note: DroneNote = {
      id,
      note: midiToName(midi),
      startHour: start,
      endHour: end,
    };
    addDroneNote(note);
    setSelectedId(id);
    // Start a resize-right drag so the user can immediately drag out length.
    dragRef.current = {
      kind: "resize-right",
      noteId: id,
      originHour: hour,
      originStart: start,
      originEnd: end,
      originMidi: midi,
      originRow: row,
    };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  // Preview a pitch when hovering the gutter key labels.
  const previewNote = (note: string | null) => {
    getDroneEngine().setPreview(note);
  };

  return (
    <div style={panelStyle}>
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Link to="/" style={linkStyle}>
          ← simulator
        </Link>
        <Link to="/pads" style={linkStyle}>
          Pads
        </Link>
        <Link to="/samples" style={linkStyle}>
          Samples
        </Link>
        <span style={{ marginLeft: 8, fontSize: 16, fontWeight: 600 }}>
          Drones
        </span>
        <AudioSoloButton instrument="drone" accent="#38bdf8" />
        <button
          onClick={() => setSky({ autoPlay: !sky.autoPlay })}
          style={{
            ...buttonStyle,
            background: sky.autoPlay
              ? "rgba(255,225,77,0.25)"
              : "rgba(56,189,248,0.2)",
            borderColor: sky.autoPlay
              ? "rgba(255,225,77,0.6)"
              : "rgba(56,189,248,0.5)",
            minWidth: 78,
          }}
          title={sky.autoPlay ? "Pause" : "Play"}
        >
          {sky.autoPlay ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button
          onClick={() => setSky({ timeHours: 0 })}
          style={buttonStyle}
          title="Rewind to 00:00"
        >
          ⏮ 00:00
        </button>
        <PeriodTransportButtons />
        <CycleField labelStyle={rowStyle} inputStyle={numInput} />
        <label style={{ ...rowStyle, fontSize: 11 }} title="Horizontal piano-roll zoom">
          Zoom
          <select
            value={horizontalZoom}
            onChange={(e) => setHorizontalZoom(Number(e.target.value))}
            style={numInput}
          >
            {[1, 2, 4, 6, 8].map((z) => (
              <option key={z} value={z}>
                {z}×
              </option>
            ))}
          </select>
        </label>
        <label style={{ ...rowStyle, fontSize: 11 }} title="Snap note timing to a fixed grid">
          Snap
          <select
            value={snapHours}
            onChange={(e) => setSnapHours(Number(e.target.value))}
            style={{ ...numInput, width: 72 }}
          >
            <option value={0}>Off</option>
            <option value={1 / 12}>5 min</option>
            <option value={1 / 6}>10 min</option>
            <option value={0.25}>15 min</option>
            <option value={0.5}>30 min</option>
            <option value={1}>1 hour</option>
          </select>
        </label>
        <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
          {fmtTime(timeHours)}
        </div>
      </header>

      {/*
        Body scrolls as one column. The piano roll sits at the top so
        it's always in view on smaller screens; per-note editors and
        the master synth/FX sections scroll into view below.
      */}
      <div style={bodyScrollStyle}>
      <section style={rollSectionStyle}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <strong style={{ fontSize: 12 }}>Piano roll</strong>
          <span style={{ fontSize: 11, opacity: 0.6 }}>
            click grid to add · drag body to move · drag right edge to resize · Del to remove · drag ruler to scrub
          </span>
          <button
            style={{
              ...buttonStyle,
              ...destructiveButtonStyle,
              marginLeft: "auto",
            }}
            onClick={() => {
              if (
                confirmDestructiveClear(
                  `all ${drone.notes.length} drone notes`,
                )
              ) {
                clearDroneNotes();
                setSelectedId(null);
              }
            }}
          >
            Clear all
          </button>
        </div>
        <div
          ref={rollRef}
          style={{
            display: "flex",
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            border: "1px solid rgba(255,255,255,0.15)",
            borderRadius: 6,
            background: "rgba(255,255,255,0.02)",
          }}
        >
          {/* Left gutter: piano key labels */}
          <div
            style={{
              width: GUTTER_WIDTH,
              flexShrink: 0,
              position: "sticky",
              left: 0,
              zIndex: 5,
              background: "rgba(0,0,0,0.35)",
              borderRight: "1px solid rgba(255,255,255,0.15)",
            }}
            onPointerLeave={() => previewNote(null)}
          >
            {Array.from({ length: PITCH_COUNT }, (_, row) => {
              const midi = rowToMidi(row);
              const name = midiToName(midi);
              const black = isBlackMidi(midi);
              const isC = NAMES[((midi % 12) + 12) % 12] === "C";
              return (
                <div
                  key={row}
                  onPointerDown={() => previewNote(name)}
                  onPointerUp={() => previewNote(null)}
                  onPointerLeave={() => previewNote(null)}
                  style={{
                    height: ROW_HEIGHT,
                    fontSize: 9,
                    color: black ? "rgba(220,230,255,0.6)" : "rgba(255,255,255,0.9)",
                    background: black ? "rgba(0,0,0,0.5)" : "transparent",
                    borderTop: isC
                      ? "1px solid rgba(255,255,255,0.2)"
                      : "1px solid rgba(255,255,255,0.03)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    paddingRight: 4,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                >
                  {isC ? name : ""}
                </div>
              );
            })}
          </div>
          {/* Grid + notes */}
          <div
            style={{
              flex: "0 0 auto",
              width: Math.max(400, rollWidth * horizontalZoom),
              position: "relative",
            }}
          >
            {/* Scrubber ruler — drag to move playhead. */}
            <div
              onPointerDown={(e) => {
                scrubbingRef.current = true;
                const { hour } = clientToHourRow(e.clientX, e.clientY);
                setSky({ timeHours: Math.max(0, Math.min(24, hour)) });
                (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                e.preventDefault();
              }}
              style={{
                position: "sticky",
                top: 0,
                zIndex: 3,
                height: 22,
                background: "rgba(0,0,0,0.7)",
                borderBottom: "1px solid rgba(255,255,255,0.25)",
                cursor: "ew-resize",
                userSelect: "none",
              }}
              title="Drag to scrub"
            >
              <ActivePeriodBand opacity={0.3} />
              {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
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
                  {h.toString().padStart(2, "0")}h
                </span>
              ))}
              <div
                style={{
                  position: "absolute",
                  left: `${(timeHours / HOURS) * 100}%`,
                  top: 0,
                  bottom: 0,
                  width: 2,
                  background: "#ffe14d",
                  pointerEvents: "none",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: `calc(${(timeHours / HOURS) * 100}% - 6px)`,
                  top: 0,
                  width: 12,
                  height: 12,
                  borderRadius: 6,
                  background: "#ffe14d",
                  border: "1px solid #7a6100",
                  pointerEvents: "none",
                }}
              />
            </div>
            <div
              data-grid
              onPointerDown={onGridPointerDown}
              style={{
                position: "relative",
                width: "100%",
                height: ROLL_HEIGHT,
                cursor: "crosshair",
              }}
            >
              {/* Row shading */}
              {Array.from({ length: PITCH_COUNT }, (_, row) => {
                const midi = rowToMidi(row);
                const black = isBlackMidi(midi);
                const isC = NAMES[((midi % 12) + 12) % 12] === "C";
                return (
                  <div
                    key={row}
                    style={{
                      position: "absolute",
                      left: 0,
                      right: 0,
                      top: row * ROW_HEIGHT,
                      height: ROW_HEIGHT,
                      background: black
                        ? "rgba(0,0,0,0.25)"
                        : "rgba(255,255,255,0.015)",
                      borderTop: isC
                        ? "1px solid rgba(255,255,255,0.15)"
                        : "1px solid rgba(255,255,255,0.03)",
                      pointerEvents: "none",
                    }}
                  />
                );
              })}
              {snapHours > 0 &&
                snapHours < 1 &&
                Array.from(
                  { length: Math.floor(HOURS / snapHours) + 1 },
                  (_, i) => i * snapHours,
                ).map((h) => (
                  <div
                    key={`snap-${h}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: `${(h / HOURS) * 100}%`,
                      width: 1,
                      background: "rgba(255,255,255,0.045)",
                      pointerEvents: "none",
                    }}
                  />
                ))}
              {/* Hour gridlines */}
              {Array.from({ length: HOURS + 1 }, (_, h) => (
                <div
                  key={h}
                  style={{
                    position: "absolute",
                    top: 0,
                    bottom: 0,
                    left: `${(h / HOURS) * 100}%`,
                    width: 1,
                    background:
                      h % 6 === 0
                        ? "rgba(255,255,255,0.25)"
                        : h % 3 === 0
                          ? "rgba(255,255,255,0.12)"
                          : "rgba(255,255,255,0.05)",
                    pointerEvents: "none",
                  }}
                />
              ))}
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
              {/* Notes */}
              {drone.notes.map((n) => {
                const midi = parseNoteToMidi(n.note);
                if (midi === null) return null;
                const row = midiToRow(midi);
                if (row < 0 || row >= PITCH_COUNT) return null;
                const left = (n.startHour / HOURS) * 100;
                const width = ((n.endHour - n.startHour) / HOURS) * 100;
                const isSel = n.id === selectedId;
                return (
                  <div
                    key={n.id}
                    data-note-id={n.id}
                    onPointerDown={(e) => {
                      const rect = (
                        e.currentTarget as HTMLDivElement
                      ).getBoundingClientRect();
                      const nearRight =
                        e.clientX > rect.right - RESIZE_EDGE_PX;
                      beginDrag(e, nearRight ? "resize-right" : "move", n.id);
                    }}
                    style={{
                      position: "absolute",
                      top: row * ROW_HEIGHT + 1,
                      left: `${left}%`,
                      width: `${width}%`,
                      height: ROW_HEIGHT - 2,
                      background: isSel
                        ? "linear-gradient(180deg,#38bdf8,#0ea5e9)"
                        : "linear-gradient(180deg,#38bdf8aa,#0ea5e9aa)",
                      border: `1px solid ${isSel ? "#fff" : "#0369a1"}`,
                      borderRadius: 3,
                      cursor: "grab",
                      boxSizing: "border-box",
                      display: "flex",
                      alignItems: "center",
                      paddingLeft: 4,
                      fontSize: 9,
                      color: "#0a1520",
                      fontWeight: 600,
                      overflow: "hidden",
                      whiteSpace: "nowrap",
                    }}
                    title={`${n.note}  ${fmtTime(n.startHour)}–${fmtTime(n.endHour)}`}
                  >
                    {n.note}
                  </div>
                );
              })}
            </div>
            {/* Hour labels along bottom */}
            <div
              style={{
                position: "sticky",
                bottom: 0,
                display: "flex",
                justifyContent: "space-between",
                fontSize: 9,
                opacity: 0.6,
                padding: "2px 2px",
                background: "rgba(0,0,0,0.5)",
                pointerEvents: "none",
              }}
            >
              {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
                <span key={h}>{h.toString().padStart(2, "0")}h</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {selectedId &&
        (() => {
          const selectedNote =
            drone.notes.find((n) => n.id === selectedId) ?? null;
          if (!selectedNote) return null;
          return (
            <>
              <SelectedNoteEditor
                note={selectedNote}
                onChange={(patch) => updateDroneNote(selectedId, patch)}
                onDelete={() => {
                  removeDroneNote(selectedId);
                  setSelectedId(null);
                }}
              />
              <NoteEffectsPanel
                note={selectedNote}
                onChange={(patch) => updateDroneNote(selectedId, patch)}
              />
            </>
          );
        })()}

      <section style={sectionStyle}>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={rowStyle}>
            <input
              type="checkbox"
              checked={drone.enabled}
              onChange={(e) => setDrone({ enabled: e.target.checked })}
            />
            <span>Enable audio</span>
          </label>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Slider
              label="Master"
              min={0}
              max={1}
              step={0.01}
              value={drone.masterGain}
              onChange={(v) => setDrone({ masterGain: v })}
            />
          </div>
          <div style={{ flex: 1, minWidth: 180 }}>
            <Slider
              label="Saturation"
              min={0}
              max={1}
              step={0.01}
              value={drone.saturation}
              onChange={(v) => setDrone({ saturation: v })}
            />
          </div>
        </div>
      </section>

      <SynthSection />
      <PostFxSection />
      </div>
      {/* Suppress unused variable warning: pxPerHour reserved for potential
          future snap-to-grid features. */}
      <span style={{ display: "none" }}>{pxPerHour}</span>
    </div>
  );
}

function SelectedNoteEditor({
  note,
  onChange,
  onDelete,
}: {
  note: DroneNote | null;
  onChange: (patch: Partial<DroneNote>) => void;
  onDelete: () => void;
}) {
  if (!note) return null;
  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        borderRadius: 6,
        background: "rgba(56,189,248,0.08)",
        border: "1px solid rgba(56,189,248,0.3)",
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
        fontSize: 11,
      }}
    >
      <strong>{note.note}</strong>
      <label>
        Start
        <input
          type="number"
          min={0}
          max={24}
          step={0.05}
          value={+note.startHour.toFixed(2)}
          onChange={(e) => {
            const v = Math.max(0, Math.min(24, parseFloat(e.target.value) || 0));
            onChange({ startHour: Math.min(v, note.endHour - MIN_NOTE_LENGTH_H) });
          }}
          style={numInput}
        />
      </label>
      <label>
        End
        <input
          type="number"
          min={0}
          max={24}
          step={0.05}
          value={+note.endHour.toFixed(2)}
          onChange={(e) => {
            const v = Math.max(0, Math.min(24, parseFloat(e.target.value) || 0));
            onChange({ endHour: Math.max(v, note.startHour + MIN_NOTE_LENGTH_H) });
          }}
          style={numInput}
        />
      </label>
      <span style={{ opacity: 0.7 }}>
        {fmtTime(note.startHour)} – {fmtTime(note.endHour)} · {(note.endHour - note.startHour).toFixed(2)}h
      </span>
      <button style={{ ...buttonStyle, marginLeft: "auto" }} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

interface SliderProps {
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  logScale?: boolean;
}

function Slider({ label, min, max, step, value, onChange, logScale }: SliderProps) {
  const toSlider = (v: number) => (logScale ? Math.log(Math.max(1e-6, v)) : v);
  const fromSlider = (v: number) => (logScale ? Math.exp(v) : v);
  const sMin = toSlider(min);
  const sMax = toSlider(max);
  const sVal = toSlider(value);
  return (
    <label style={{ ...rowStyle, marginTop: 2 }}>
      <span style={{ fontSize: 11, width: 70 }}>{label}</span>
      <input
        type="range"
        min={sMin}
        max={sMax}
        step={logScale ? (sMax - sMin) / 500 : step}
        value={sVal}
        onChange={(e) => onChange(fromSlider(parseFloat(e.target.value)))}
        style={{ flex: 1 }}
      />
      <span style={{ fontSize: 10, width: 44, textAlign: "right", opacity: 0.8 }}>
        {value.toFixed(logScale ? 0 : step < 1 ? 2 : 1)}
      </span>
    </label>
  );
}

function parseNoteToMidi(note: string): number | null {
  const m = /^([A-G])(#|b)?(-?\d+)$/.exec(note);
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1]];
  if (base === undefined) return null;
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  const octave = parseInt(m[3], 10);
  return (octave + 1) * 12 + base + acc;
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
  background: "rgba(10, 12, 20, 0.9)",
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
  // Header pinned; #bodyScrollStyle handles internal scrolling.
  overflow: "hidden",
};

// Scrollable region below the header. The piano roll lives at the top
// so it's always visible on smaller viewports; per-note editors and
// the master synth/FX sections scroll into view underneath it.
const bodyScrollStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingRight: 4,
};

// Roll section: gets a guaranteed minimum height so it stays usable
// on small screens, but grows to fill spare space on tall ones.
const rollSectionStyle: React.CSSProperties = {
  padding: "8px 0",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  flex: "1 0 340px",
  minHeight: 340,
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

const sectionStyle: React.CSSProperties = {
  padding: "8px 0",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
};

const buttonStyle: React.CSSProperties = {
  background: "rgba(56,189,248,0.2)",
  color: "rgba(207,214,230,0.95)",
  border: "1px solid rgba(56,189,248,0.5)",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
};

const selectStyle: React.CSSProperties = {
  flex: 1,
  background: "rgba(255,255,255,0.06)",
  color: "rgba(207,214,230,0.95)",
  border: "1px solid rgba(255,255,255,0.2)",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 11,
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
