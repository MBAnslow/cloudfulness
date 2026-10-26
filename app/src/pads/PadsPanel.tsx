import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  PAD_KEYFRAME_PARAMS,
  useSimStore,
  type PadKeyframeParam,
  type PadNote,
  type PadParams,
} from "../state";
import { PadSynthPanel } from "./PadSynthPanel";
import { PadKeyframeEditor } from "./PadKeyframeEditor";
import { ActivePeriodBand, PeriodTransportButtons } from "../components/PeriodOverlay";
import { CycleField } from "../components/CycleField";
import { AudioSoloButton } from "../components/AudioSoloButton";
import {
  samplePadAutomation,
  sortedPadKeyframes,
} from "../audio/padAutomation";
import {
  confirmDestructiveClear,
  destructiveButtonStyle,
} from "../components/confirmDestructiveClear";

const HOURS = 24;

// Same pitch range as DronesPanel: MIDI 24 (C1) through 84 (C6).
const MIDI_LOW = 24;
const MIDI_HIGH = 84;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const BLACK = new Set(["C#", "D#", "F#", "G#", "A#"]);

const ROW_HEIGHT = 14;
const GUTTER_WIDTH = 56;
const RESIZE_EDGE_PX = 6;
const DEFAULT_NOTE_LENGTH_H = 2;
const MIN_NOTE_LENGTH_H = 0.1;
const PAD_KEYFRAME_PARAM_SET = new Set<string>(PAD_KEYFRAME_PARAMS);

function isPadKeyframeParam(key: string): key is PadKeyframeParam {
  return PAD_KEYFRAME_PARAM_SET.has(key);
}

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
  return `pad-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}
function newKeyframeId(): string {
  return `pad-kf-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}
function rowToMidi(row: number): number {
  return MIDI_HIGH - row;
}
function midiToRow(m: number): number {
  return MIDI_HIGH - m;
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
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable
  );
}

const PITCH_COUNT = MIDI_HIGH - MIDI_LOW + 1;
const ROLL_HEIGHT = PITCH_COUNT * ROW_HEIGHT;

interface DragState {
  kind: "move" | "resize-right";
  noteId: string;
  originHour: number;
  originStart: number;
  originEnd: number;
  originMidi: number;
  originRow: number;
}

/**
 * Warm-pad editor: 24h piano roll of `PadNote`s + selected-note editor
 * (gain, detune) + global synth panel. Sibling of `DronesPanel`. Shares
 * the same 24h day cycle via `sky.timeHours`.
 */
export function PadsPanel() {
  const pad = useSimStore((s) => s.pad);
  const setPad = useSimStore((s) => s.setPad);
  const addPadNote = useSimStore((s) => s.addPadNote);
  const updatePadNote = useSimStore((s) => s.updatePadNote);
  const removePadNote = useSimStore((s) => s.removePadNote);
  const clearPadNotes = useSimStore((s) => s.clearPadNotes);
  const timeHours = useSimStore((s) => s.sky.timeHours);
  const sky = useSimStore((s) => s.sky);
  const setSky = useSimStore((s) => s.setSky);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedKeyframeId, setSelectedKeyframeId] = useState<string | null>(
    null,
  );
  const [followPlayhead, setFollowPlayhead] = useState(
    () => pad.keyframes.length > 0,
  );
  const [selectedPadParam, setSelectedPadParam] =
    useState<PadKeyframeParam>("filterHz");
  const [rollWidth, setRollWidth] = useState(900);
  const [horizontalZoom, setHorizontalZoom] = useState(1);
  const [snapHours, setSnapHours] = useState(0);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
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
  useEffect(() => {
    const element = rollRef.current;
    if (element && Math.abs(element.scrollLeft - timelineScrollLeft) > 1) {
      element.scrollLeft = timelineScrollLeft;
    }
  }, [timelineScrollLeft, horizontalZoom, rollWidth]);
  useEffect(() => {
    if (pad.keyframes.length === 0 && followPlayhead) {
      setFollowPlayhead(false);
    }
  }, [followPlayhead, pad.keyframes.length]);
  const pxPerHour = rollWidth / HOURS;
  const snapHour = useCallback(
    (hour: number) =>
      snapHours > 0 ? Math.round(hour / snapHours) * snapHours : hour,
    [snapHours],
  );

  const clientToHourRow = useCallback((clientX: number, clientY: number) => {
    const grid = rollRef.current?.querySelector<HTMLDivElement>("[data-grid]");
    if (!grid) return { hour: 0, row: 0 };
    const rect = grid.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height - 1, clientY - rect.top));
    return {
      hour: (x / rect.width) * HOURS,
      row: Math.floor(y / ROW_HEIGHT),
    };
  }, []);

  const beginDrag = (
    e: React.PointerEvent,
    kind: DragState["kind"],
    noteId: string,
  ) => {
    const n = pad.notes.find((x) => x.id === noteId);
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
        const rowClamped = Math.max(0, Math.min(PITCH_COUNT - 1, row));
        const midi = rowToMidi(rowClamped);
        updatePadNote(drag.noteId, {
          startHour: start,
          endHour: start + dur,
          note: midiToName(midi),
        });
      } else if (drag.kind === "resize-right") {
        const end = Math.max(
          drag.originStart + MIN_NOTE_LENGTH_H,
          Math.min(HOURS, snapHour(drag.originEnd + dHour)),
        );
        updatePadNote(drag.noteId, { endHour: end });
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
  }, [clientToHourRow, updatePadNote, setSky, snapHour]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.key === "Delete" || e.key === "Backspace") &&
        selectedId &&
        !isTypingTarget(e.target)
      ) {
        removePadNote(selectedId);
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, removePadNote]);

  const onGridPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).dataset.noteId) return;
    const { hour, row } = clientToHourRow(e.clientX, e.clientY);
    const midi = rowToMidi(row);
    const start = Math.max(
      0,
      Math.min(HOURS - MIN_NOTE_LENGTH_H, snapHour(hour)),
    );
    const end = Math.min(HOURS, start + DEFAULT_NOTE_LENGTH_H);
    const id = newNoteId();
    const note: PadNote = {
      id,
      note: midiToName(midi),
      startHour: start,
      endHour: end,
      gain: 1,
    };
    addPadNote(note);
    setSelectedId(id);
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

  const selectedNote = useMemo(
    () => pad.notes.find((n) => n.id === selectedId) ?? null,
    [pad.notes, selectedId],
  );
  const selectedKeyframe =
    pad.keyframes.find((frame) => frame.id === selectedKeyframeId) ?? null;
  const displayedPad: PadParams = useMemo(
    () => {
      if (selectedKeyframe) {
        return {
          ...samplePadAutomation(pad, selectedKeyframe.hour),
          [selectedKeyframe.param]: selectedKeyframe.value,
        };
      }
      return followPlayhead
        ? samplePadAutomation(pad, timeHours)
        : pad;
    },
    [followPlayhead, pad, selectedKeyframe, timeHours],
  );

  const patchPadControls = (patch: Partial<PadParams>) => {
    const globalPatch: Partial<PadParams> = {};
    const currentPad = useSimStore.getState().pad;
    let keyframes = currentPad.keyframes;
    let selectedPointId: string | null = null;
    const editHour = selectedKeyframe
      ? selectedKeyframe.hour
      : followPlayhead
        ? ((snapHour(timeHours) % HOURS) + HOURS) % HOURS
        : null;

    for (const [rawKey, rawValue] of Object.entries(patch)) {
      if (
        editHour !== null &&
        isPadKeyframeParam(rawKey) &&
        typeof rawValue === "number"
      ) {
        const param = rawKey;
        const preferred =
          selectedKeyframe?.param === param
            ? keyframes.find(
                (frame) => frame.id === selectedKeyframe.id,
              )
            : undefined;
        const existing =
          preferred ??
          keyframes.find(
            (frame) =>
              frame.param === param &&
              Math.abs(frame.hour - editHour) < 1e-6,
          );
        const id = existing?.id ?? newKeyframeId();
        keyframes = existing
          ? keyframes.map((frame) =>
              frame.id === id ? { ...frame, value: rawValue } : frame,
            )
          : [
              ...keyframes,
              { id, hour: editHour, param, value: rawValue },
            ];
        selectedPointId = id;
        setSelectedPadParam(param);
      } else {
        (globalPatch as Record<string, unknown>)[rawKey] = rawValue;
      }
    }

    if (selectedPointId) {
      globalPatch.keyframes = sortedPadKeyframes(keyframes);
      setSelectedKeyframeId(selectedPointId);
      setFollowPlayhead(false);
    }
    if (Object.keys(globalPatch).length > 0) setPad(globalPatch);
  };

  return (
    <div style={panelStyle}>
      <header style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Link to="/" style={linkStyle}>
          ← simulator
        </Link>
        <Link to="/drones" style={linkStyle}>
          Drones
        </Link>
        <Link to="/samples" style={linkStyle}>
          Samples
        </Link>
        <span style={{ marginLeft: 8, fontSize: 16, fontWeight: 600 }}>
          Warm Pad
        </span>
        <AudioSoloButton instrument="pad" accent="#c084fc" />
        <button
          onClick={() => setSky({ autoPlay: !sky.autoPlay })}
          style={{
            ...buttonStyle,
            background: sky.autoPlay
              ? "rgba(255,225,77,0.25)"
              : "rgba(192,132,252,0.2)",
            borderColor: sky.autoPlay
              ? "rgba(255,225,77,0.6)"
              : "rgba(192,132,252,0.5)",
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
        <div
          style={{
            marginLeft: "auto",
            fontSize: 12,
            opacity: 0.85,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {fmtTime(timeHours)}
        </div>
      </header>

      <div style={bodyScrollStyle}>
        <section style={rollSectionStyle}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              marginBottom: 6,
            }}
          >
            <strong style={{ fontSize: 12 }}>Piano roll</strong>
            <span style={{ fontSize: 11, opacity: 0.6 }}>
              click grid to add · drag body to move · drag right edge to
              resize · Del to remove · drag ruler to scrub
            </span>
            <button
              style={{
                ...buttonStyle,
                ...destructiveButtonStyle,
                marginLeft: "auto",
              }}
              onClick={() => {
                if (
                  confirmDestructiveClear(`all ${pad.notes.length} pad notes`)
                ) {
                  clearPadNotes();
                  setSelectedId(null);
                }
              }}
            >
              Clear all
            </button>
          </div>
          <div
            ref={rollRef}
            onScroll={(event) =>
              setTimelineScrollLeft(event.currentTarget.scrollLeft)
            }
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
            >
              {Array.from({ length: PITCH_COUNT }, (_, row) => {
                const midi = rowToMidi(row);
                const name = midiToName(midi);
                const black = isBlackMidi(midi);
                const isC = NAMES[((midi % 12) + 12) % 12] === "C";
                return (
                  <div
                    key={row}
                    style={{
                      height: ROW_HEIGHT,
                      fontSize: 9,
                      color: black
                        ? "rgba(220,230,255,0.6)"
                        : "rgba(255,255,255,0.9)",
                      background: black ? "rgba(0,0,0,0.5)" : "transparent",
                      borderTop: isC
                        ? "1px solid rgba(255,255,255,0.2)"
                        : "1px solid rgba(255,255,255,0.03)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "flex-end",
                      paddingRight: 4,
                      userSelect: "none",
                    }}
                  >
                    {isC ? name : ""}
                  </div>
                );
              })}
            </div>
            <div
              style={{
                flex: "0 0 auto",
                width: Math.max(400, rollWidth * horizontalZoom),
                position: "relative",
              }}
            >
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
                {pad.notes.map((n) => {
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
                        beginDrag(
                          e,
                          nearRight ? "resize-right" : "move",
                          n.id,
                        );
                      }}
                      style={{
                        position: "absolute",
                        top: row * ROW_HEIGHT + 1,
                        left: `${left}%`,
                        width: `${width}%`,
                        height: ROW_HEIGHT - 2,
                        // Purple palette to distinguish from drone blue.
                        background: isSel
                          ? "linear-gradient(180deg,#c084fc,#a855f7)"
                          : "linear-gradient(180deg,#c084fcaa,#a855f7aa)",
                        border: `1px solid ${isSel ? "#fff" : "#6b21a8"}`,
                        borderRadius: 3,
                        cursor: "grab",
                        boxSizing: "border-box",
                        display: "flex",
                        alignItems: "center",
                        paddingLeft: 4,
                        fontSize: 9,
                        color: "#1a0a20",
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

        {selectedNote && (
          <SelectedPadNoteEditor
            note={selectedNote}
            onChange={(patch) => updatePadNote(selectedNote.id, patch)}
            onDelete={() => {
              removePadNote(selectedNote.id);
              setSelectedId(null);
            }}
          />
        )}

        <PadKeyframeEditor
          pad={pad}
          playheadHour={timeHours}
          selectedId={selectedKeyframeId}
          selectedParam={selectedPadParam}
          followPlayhead={followPlayhead}
          timelineWidth={Math.max(400, rollWidth * horizontalZoom)}
          scrollLeft={timelineScrollLeft}
          snapHours={snapHours}
          onSelectedIdChange={(id) => {
            setSelectedKeyframeId(id);
            if (id) setFollowPlayhead(false);
          }}
          onSelectedParamChange={setSelectedPadParam}
          onFollowPlayheadChange={setFollowPlayhead}
          onKeyframesChange={(keyframes) => setPad({ keyframes })}
          onScrollLeftChange={setTimelineScrollLeft}
        />

        <PadSynthPanel
          pad={displayedPad}
          onChange={patchPadControls}
          onParamSelect={setSelectedPadParam}
        />
      </div>

      <span style={{ display: "none" }}>{pxPerHour}</span>
    </div>
  );
}

function SelectedPadNoteEditor({
  note,
  onChange,
  onDelete,
}: {
  note: PadNote;
  onChange: (patch: Partial<PadNote>) => void;
  onDelete: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 8,
        padding: 8,
        borderRadius: 6,
        background: "rgba(192,132,252,0.08)",
        border: "1px solid rgba(192,132,252,0.3)",
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
      <label>
        Gain
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={note.gain ?? 1}
          onChange={(e) => onChange({ gain: parseFloat(e.target.value) })}
          style={{ verticalAlign: "middle", marginLeft: 4, width: 100 }}
        />
        <span style={{ marginLeft: 4, opacity: 0.7 }}>
          {(note.gain ?? 1).toFixed(2)}
        </span>
      </label>
      <label>
        Detune
        <input
          type="number"
          min={-1200}
          max={1200}
          step={1}
          value={Math.round(note.detuneCents ?? 0)}
          onChange={(e) =>
            onChange({
              detuneCents: Math.max(
                -1200,
                Math.min(1200, parseFloat(e.target.value) || 0),
              ),
            })
          }
          style={{ ...numInput, width: 70 }}
        />
        <span style={{ opacity: 0.6 }}>c</span>
      </label>
      <label>
        Trigger
        <select
          value={note.triggerProbability ?? 1}
          onChange={(e) =>
            onChange({ triggerProbability: parseFloat(e.target.value) })
          }
          style={{ ...numInput, marginLeft: 4, width: 64 }}
          title="Odds this note fires each time the playhead enters its window"
        >
          <option value={1}>1</option>
          <option value={0.5}>1/2</option>
          <option value={0.25}>1/4</option>
          <option value={0.125}>1/8</option>
        </select>
      </label>
      <span style={{ opacity: 0.7 }}>
        {fmtTime(note.startHour)} – {fmtTime(note.endHour)} ·{" "}
        {(note.endHour - note.startHour).toFixed(2)}h
      </span>
      <button style={{ ...buttonStyle, marginLeft: "auto" }} onClick={onDelete}>
        Delete
      </button>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  position: "fixed",
  inset: 12,
  zIndex: 10,
  background: "rgba(10, 8, 20, 0.9)",
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
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
};
const buttonStyle: React.CSSProperties = {
  background: "rgba(192,132,252,0.2)",
  color: "rgba(207,214,230,0.95)",
  border: "1px solid rgba(192,132,252,0.5)",
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
