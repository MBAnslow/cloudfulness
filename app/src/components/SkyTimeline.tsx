import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useSimStore,
  type SkyChannel,
  type SkyChannelStop,
  type SkyParams,
} from "../state";
import {
  CUSTOM_SWATCH_ID,
  SKY_SWATCHES,
  getSwatch,
  type SkySwatch,
} from "../lighting/swatches";
import { interpolateChannel, skyBodyDirections } from "../lighting/skyCycle";
import { ColorInput } from "./ColorInput";

const HOURS = 24;
const TRACK_HEIGHT = 26;
const TRACK_GAP = 4;
const PIN_SIZE = 20;
const ARC_HEIGHT = 60;
const ARC_ICON = 16;
const ARC_ZENITH_PAD = ARC_ICON / 2 + 2;

function fmtTime(hour: number): string {
  const h = ((hour % HOURS) + HOURS) % HOURS;
  const H = Math.floor(h);
  const M = Math.floor((h - H) * 60);
  return `${H.toString().padStart(2, "0")}:${M.toString().padStart(2, "0")}`;
}

function wrap24(h: number): number {
  const x = h % HOURS;
  return x < 0 ? x + HOURS : x;
}

function makeStopId(channel: SkyChannel): string {
  return `${channel}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function sunAltitude(hour: number): number {
  return Math.sin((skyBodyDirections(hour).sunAltitudeDeg * Math.PI) / 180);
}
function altitudeY(alt: number): number {
  return ARC_HEIGHT - Math.max(0, alt) * (ARC_HEIGHT - ARC_ZENITH_PAD);
}

/** Which channel's color from a swatch should apply to a given track. */
function swatchColorFor(channel: SkyChannel, swatch: SkySwatch): string {
  if (channel === "sun" || channel === "rim") return swatch.sunColor;
  if (channel === "moon") return swatch.moonColor;
  return swatch.ambientColor;
}

/** Field name in `SkyParams` for a channel's stop list. */
function channelKey(channel: SkyChannel): keyof SkyParams {
  if (channel === "sun") return "sunStops";
  if (channel === "moon") return "moonStops";
  if (channel === "rim") return "rimStops";
  return "ambientStops";
}

const CHANNELS: SkyChannel[] = ["sun", "moon", "ambient", "rim"];

function ColorDot({ color, size = 10 }: { color: string; size?: number }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: size,
        background: color,
        border: "1px solid rgba(255,255,255,0.35)",
        flexShrink: 0,
      }}
    />
  );
}

interface Selection {
  channel: SkyChannel;
  id: string;
}

export function SkyTimeline() {
  const sky = useSimStore((s) => s.sky);
  const setSky = useSimStore((s) => s.setSky);

  const [selected, setSelected] = useState<Selection | null>(null);

  // Auto-play tick lives in <DroneRuntime /> (mounted at app root) so
  // the Play button works on every route, not just the sim view.

  // Selected stop no longer exists after edit/delete? Clear the selection.
  useEffect(() => {
    if (!selected) return;
    const list = (sky[channelKey(selected.channel)] as SkyChannelStop[] | undefined) ?? [];
    if (!list.some((s) => s.id === selected.id)) setSelected(null);
  }, [sky.sunStops, sky.moonStops, sky.ambientStops, sky.rimStops, selected]);

  const setChannelStops = useCallback(
    (channel: SkyChannel, updater: (stops: SkyChannelStop[]) => SkyChannelStop[]) => {
      const key = channelKey(channel);
      const list = (useSimStore.getState().sky[key] as SkyChannelStop[] | undefined) ?? [];
      setSky({ [key]: updater(list) } as Partial<SkyParams>);
    },
    [setSky],
  );

  const updateStop = useCallback(
    (channel: SkyChannel, id: string, patch: Partial<SkyChannelStop>) => {
      setChannelStops(channel, (stops) =>
        stops.map((s) => (s.id === id ? { ...s, ...patch } : s)),
      );
    },
    [setChannelStops],
  );

  const deleteStop = useCallback(
    (channel: SkyChannel, id: string) => {
      setChannelStops(channel, (stops) => stops.filter((s) => s.id !== id));
      setSelected((cur) =>
        cur && cur.channel === channel && cur.id === id ? null : cur,
      );
    },
    [setChannelStops],
  );

  const addStop = useCallback(
    (channel: SkyChannel, hour: number, swatchId = "roseDawn") => {
      const swatch = getSwatch(swatchId);
      const newStop: SkyChannelStop = {
        id: makeStopId(channel),
        timeHours: wrap24(hour),
        swatchId,
        color: swatchColorFor(channel, swatch),
      };
      setChannelStops(channel, (stops) => [...stops, newStop]);
      setSelected({ channel, id: newStop.id });
    },
    [setChannelStops],
  );

  const applySwatch = useCallback(
    (channel: SkyChannel, id: string, swatchId: string) => {
      if (swatchId === CUSTOM_SWATCH_ID) {
        updateStop(channel, id, { swatchId });
        return;
      }
      const swatch = getSwatch(swatchId);
      updateStop(channel, id, {
        swatchId,
        color: swatchColorFor(channel, swatch),
      });
    },
    [updateStop],
  );

  const togglePlay = useCallback(() => {
    setSky({ autoPlay: !sky.autoPlay });
  }, [sky.autoPlay, setSky]);

  const setNow = useCallback(
    (hour: number) => {
      setSky({ timeHours: wrap24(hour) });
    },
    [setSky],
  );

  const nowHour = wrap24(sky.timeHours);
  const nowSun = useMemo(
    () => interpolateChannel(sky.sunStops, nowHour, "#05070d"),
    [sky.sunStops, nowHour],
  );
  const nowMoon = useMemo(
    () => interpolateChannel(sky.moonStops, nowHour, "#b7c8ff"),
    [sky.moonStops, nowHour],
  );
  const nowAmbient = useMemo(
    () => interpolateChannel(sky.ambientStops, nowHour, "#0c1734"),
    [sky.ambientStops, nowHour],
  );
  const nowRim = useMemo(
    () => interpolateChannel(sky.rimStops ?? [], nowHour, "#ffffff"),
    [sky.rimStops, nowHour],
  );

  const selectedStop: SkyChannelStop | null = selected
    ? ((sky[channelKey(selected.channel)] as SkyChannelStop[] | undefined) ?? []).find(
        (s) => s.id === selected.id,
      ) ?? null
    : null;

  return (
    <div
      style={{
        position: "fixed",
        top: 56,
        left: 12,
        right: 12,
        zIndex: 10,
        pointerEvents: "auto",
        background: "rgba(10, 12, 20, 0.72)",
        backdropFilter: "blur(8px)",
        borderRadius: 12,
        boxShadow: "0 1px 0 rgba(255,255,255,0.05) inset",
        color: "rgba(207,214,230,0.95)",
        fontFamily:
          "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        padding: "8px 12px 10px",
      }}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          fontSize: 11,
          marginBottom: 4,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span
            style={{
              textTransform: "uppercase",
              letterSpacing: 0.6,
              opacity: 0.7,
            }}
          >
            Time of Day Visualization
          </span>
          <button
            onClick={togglePlay}
            style={{
              background: sky.autoPlay
                ? "rgba(70,225,110,0.18)"
                : "rgba(255,255,255,0.06)",
              color: "inherit",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 11,
            }}
            title={sky.autoPlay ? "Pause auto-play" : "Resume auto-play"}
          >
            {sky.autoPlay ? "❚❚ playing" : "▶ paused"}
          </button>
          <span style={{ fontVariantNumeric: "tabular-nums", opacity: 0.85 }}>
            {fmtTime(nowHour)}
          </span>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "1px 6px 1px 3px",
              background: "rgba(255,255,255,0.05)",
              borderRadius: 6,
              fontSize: 11,
            }}
            title="Colors interpolated at the current time for each channel"
          >
            <ColorDot color={nowSun} size={9} />
            sun
            <ColorDot color={nowMoon} size={9} />
            moon
            <ColorDot color={nowAmbient} size={9} />
            ambient
            <ColorDot color={nowRim} size={9} />
            rim
          </span>
        </div>
        <div style={{ opacity: 0.55, fontSize: 10 }}>
          drag altitude arc → scrub time · click empty track → add · drag pin →
          move · click pin → edit
        </div>
      </div>

      <SkyArc nowHour={nowHour} onScrub={setNow} />

      <LightningWindowStrip />
      <BreathWindowStrip />

      {/* Three independent channel tracks */}
      <div style={{ marginTop: 2 }}>
        {CHANNELS.map((channel) => (
          <ChannelTrack
            key={channel}
            channel={channel}
            stops={(sky[channelKey(channel)] as SkyChannelStop[] | undefined) ?? []}
            nowHour={nowHour}
            selectedId={
              selected && selected.channel === channel ? selected.id : null
            }
            onSelect={(id) =>
              setSelected((cur) =>
                cur && cur.channel === channel && cur.id === id
                  ? null
                  : { channel, id },
              )
            }
            onMove={(id, hour) => updateStop(channel, id, { timeHours: hour })}
            onAdd={(hour) => addStop(channel, hour)}
            onScrub={setNow}
          />
        ))}
      </div>

      {selected && selectedStop && (
        <StopEditor
          channel={selected.channel}
          stop={selectedStop}
          onChange={(patch) => updateStop(selected.channel, selected.id, patch)}
          onApplySwatch={(swatchId) =>
            applySwatch(selected.channel, selected.id, swatchId)
          }
          onDelete={() => deleteStop(selected.channel, selected.id)}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

function ChannelTrack({
  channel,
  stops,
  nowHour,
  selectedId,
  onSelect,
  onMove,
  onAdd,
  onScrub,
}: {
  channel: SkyChannel;
  stops: SkyChannelStop[];
  nowHour: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onMove: (id: string, hour: number) => void;
  onAdd: (hour: number) => void;
  onScrub: (hour: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<{ id: string; wasDrag: boolean } | null>(null);

  const hourFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
    return (x / Math.max(1, rect.width)) * HOURS;
  }, []);

  const gradient = useMemo(() => {
    const SAMPLES = 96;
    const parts: string[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const hour = (i / SAMPLES) * HOURS;
      const c = interpolateChannel(stops, hour, "#101828");
      const pct = ((i / SAMPLES) * 100).toFixed(2);
      parts.push(`${c} ${pct}%`);
    }
    return `linear-gradient(to right, ${parts.join(", ")})`;
  }, [stops]);

  const onPinPointerDown = useCallback(
    (e: React.PointerEvent, stop: SkyChannelStop) => {
      e.stopPropagation();
      draggingRef.current = { id: stop.id, wasDrag: false };
      try {
        (e.target as Element).setPointerCapture?.(e.pointerId);
      } catch {
        // Some pointer sources (e.g. synthetic test events) can't be
        // captured; we don't rely on capture, only on the ref set above.
      }
    },
    [],
  );

  const onPinPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag) return;
      const nextHour = wrap24(hourFromClientX(e.clientX));
      drag.wasDrag = true;
      onMove(drag.id, nextHour);
    },
    [hourFromClientX, onMove],
  );

  const onPinPointerUp = useCallback(
    (e: React.PointerEvent, stop: SkyChannelStop) => {
      const drag = draggingRef.current;
      draggingRef.current = null;
      try {
        (e.target as Element).releasePointerCapture?.(e.pointerId);
      } catch {
        // ignore — see onPinPointerDown comment
      }
      if (!drag?.wasDrag) onSelect(stop.id);
    },
    [onSelect],
  );

  const onTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (draggingRef.current) return;
      if (e.target !== e.currentTarget) return;
      onAdd(hourFromClientX(e.clientX));
    },
    [hourFromClientX, onAdd],
  );

  const onScrubPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!(e.button === 1 || e.shiftKey)) return;
      onScrub(wrap24(hourFromClientX(e.clientX)));
      e.preventDefault();
    },
    [hourFromClientX, onScrub],
  );

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: TRACK_GAP,
      }}
    >
      <span
        style={{
          width: 46,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          opacity: 0.7,
          textAlign: "right",
        }}
      >
        {channel}
      </span>
      <div
        ref={trackRef}
        onClick={onTrackClick}
        onPointerDown={onScrubPointerDown}
        onPointerMove={onPinPointerMove}
        style={{
          position: "relative",
          flex: 1,
          height: TRACK_HEIGHT,
          background: gradient,
          borderRadius: 6,
          boxShadow: "0 0 0 1px rgba(255,255,255,0.06) inset",
          cursor: "copy",
        }}
      >
        {/* Hour tick lines */}
        {[0, 3, 6, 9, 12, 15, 18, 21, 24].map((h) => (
          <div
            key={h}
            style={{
              position: "absolute",
              left: `${(h / HOURS) * 100}%`,
              top: 0,
              bottom: 0,
              width: 1,
              background: "rgba(0,0,0,0.18)",
              pointerEvents: "none",
            }}
          />
        ))}

        {/* Playhead */}
        <div
          style={{
            position: "absolute",
            left: `${(nowHour / HOURS) * 100}%`,
            top: -2,
            bottom: -2,
            width: 2,
            background: "rgba(70,225,110,0.9)",
            boxShadow: "0 0 5px rgba(70,225,110,0.55)",
            pointerEvents: "none",
          }}
        />

        {/* Pins */}
        {stops.map((stop) => {
          const leftPct = (wrap24(stop.timeHours) / HOURS) * 100;
          const swatch = SKY_SWATCHES.find((s) => s.id === stop.swatchId);
          const isSelected = selectedId === stop.id;
          return (
            <div
              key={stop.id}
              onPointerDown={(e) => onPinPointerDown(e, stop)}
              onPointerUp={(e) => onPinPointerUp(e, stop)}
              style={{
                position: "absolute",
                left: `calc(${leftPct}% - ${PIN_SIZE / 2}px)`,
                top: (TRACK_HEIGHT - PIN_SIZE) / 2,
                width: PIN_SIZE,
                height: PIN_SIZE,
                borderRadius: PIN_SIZE,
                background: stop.color,
                border: `2px solid ${isSelected ? "#ffffff" : "rgba(255,255,255,0.55)"}`,
                boxShadow: `0 0 0 ${isSelected ? 3 : 1}px ${isSelected ? "rgba(70,225,110,0.6)" : "rgba(0,0,0,0.5)"}`,
                boxSizing: "border-box",
                cursor: "grab",
                touchAction: "none",
                zIndex: isSelected ? 2 : 1,
              }}
              title={`${channel} · ${fmtTime(stop.timeHours)} · ${swatch?.label ?? "custom"}`}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Sun + moon altitude arcs across the 24-hour day, with icons that
 * slide along the arcs at the current time.
 */
function SkyArc({
  nowHour,
  onScrub,
}: {
  nowHour: number;
  onScrub: (hour: number) => void;
}) {
  const SAMPLES = 240;
  const arcRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const hourFromClientX = useCallback((clientX: number) => {
    const el = arcRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
    return wrap24((x / Math.max(1, rect.width)) * HOURS);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      onScrub(hourFromClientX(e.clientX));
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      e.preventDefault();
    },
    [hourFromClientX, onScrub],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      onScrub(hourFromClientX(e.clientX));
      e.preventDefault();
    },
    [hourFromClientX, onScrub],
  );

  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  }, []);

  const { sunPath, moonPath } = useMemo(() => {
    const sunPts: Array<[number, number]> = [];
    const moonPts: Array<[number, number]> = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const hour = (i / SAMPLES) * HOURS;
      const x = (i / SAMPLES) * SAMPLES;
      const s = sunAltitude(hour);
      sunPts.push([x, altitudeY(s)]);
      moonPts.push([x, altitudeY(-s)]);
    }
    const toArea = (pts: Array<[number, number]>) => {
      const H = ARC_HEIGHT;
      const inner = pts
        .map((p) => `L${p[0].toFixed(2)},${p[1].toFixed(2)}`)
        .join(" ");
      return `M0,${H} ${inner} L${SAMPLES},${H} Z`;
    };
    return { sunPath: toArea(sunPts), moonPath: toArea(moonPts) };
  }, []);

  const nowSunAlt = sunAltitude(nowHour);
  const nowMoonAlt = -nowSunAlt;
  const nowSunY = altitudeY(nowSunAlt);
  const nowMoonY = altitudeY(nowMoonAlt);
  const nowPct = (nowHour / HOURS) * 100;

  const hourTicks = [0, 3, 6, 9, 12, 15, 18, 21, 24];

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 4,
      }}
      title="Sun and moon altitude across the day"
    >
      <span
        style={{
          width: 46,
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: 0.6,
          opacity: 0.5,
          textAlign: "right",
          alignSelf: "flex-end",
          paddingBottom: 2,
        }}
      >
        altitude
      </span>
      <div
        ref={arcRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        style={{ position: "relative", flex: 1, height: ARC_HEIGHT, cursor: "ew-resize" }}
        title="Drag anywhere here to scrub time of day"
      >
        <svg
          viewBox={`0 0 ${SAMPLES} ${ARC_HEIGHT}`}
          preserveAspectRatio="none"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            display: "block",
          }}
        >
          <defs>
            <linearGradient id="sunArcG" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="rgba(255,206,110,0.55)" />
              <stop offset="1" stopColor="rgba(255,206,110,0)" />
            </linearGradient>
            <linearGradient id="moonArcG" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="rgba(180,200,255,0.42)" />
              <stop offset="1" stopColor="rgba(180,200,255,0)" />
            </linearGradient>
          </defs>
          <path d={moonPath} fill="url(#moonArcG)" />
          <path d={sunPath} fill="url(#sunArcG)" />
          {hourTicks.map((h) => (
            <line
              key={h}
              x1={(h / HOURS) * SAMPLES}
              x2={(h / HOURS) * SAMPLES}
              y1={0}
              y2={ARC_HEIGHT}
              stroke="rgba(255,255,255,0.06)"
              strokeWidth={0.5}
              vectorEffect="non-scaling-stroke"
            />
          ))}
          <line
            x1={0}
            x2={SAMPLES}
            y1={ARC_HEIGHT - 0.5}
            y2={ARC_HEIGHT - 0.5}
            stroke="rgba(255,255,255,0.2)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1={(nowHour / HOURS) * SAMPLES}
            x2={(nowHour / HOURS) * SAMPLES}
            y1={0}
            y2={ARC_HEIGHT}
            stroke="rgba(70,225,110,0.45)"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {nowSunAlt > 0 && (
          <div
            style={{
              position: "absolute",
              left: `calc(${nowPct}% - ${ARC_ICON / 2}px)`,
              top: nowSunY - ARC_ICON / 2,
              width: ARC_ICON,
              height: ARC_ICON,
              borderRadius: ARC_ICON,
              background:
                "radial-gradient(circle at 35% 35%, #fff2b0 0%, #ffcf5c 55%, #ff9a3c 100%)",
              boxShadow: "0 0 10px rgba(255,200,90,0.75)",
              border: "1px solid rgba(255,255,255,0.65)",
              boxSizing: "border-box",
              pointerEvents: "none",
            }}
            title={`Sun · alt ${(nowSunAlt * 90).toFixed(0)}°`}
          />
        )}
        {nowMoonAlt > 0 && (
          <div
            style={{
              position: "absolute",
              left: `calc(${nowPct}% - ${ARC_ICON / 2}px)`,
              top: nowMoonY - ARC_ICON / 2,
              width: ARC_ICON,
              height: ARC_ICON,
              borderRadius: ARC_ICON,
              background:
                "radial-gradient(circle at 35% 35%, #f2f5ff 0%, #cfd7ff 55%, #8ea1ef 100%)",
              boxShadow: "0 0 10px rgba(180,200,255,0.6)",
              border: "1px solid rgba(255,255,255,0.65)",
              boxSizing: "border-box",
              pointerEvents: "none",
            }}
            title={`Moon · alt ${(nowMoonAlt * 90).toFixed(0)}°`}
          />
        )}

        {/* Hour tick labels (once, across the top of the arc) */}
        {hourTicks.map((h) => (
          <span
            key={h}
            style={{
              position: "absolute",
              left: `calc(${(h / HOURS) * 100}% - 12px)`,
              top: -2,
              width: 24,
              textAlign: "center",
              fontSize: 9,
              opacity: 0.5,
              fontVariantNumeric: "tabular-nums",
              pointerEvents: "none",
            }}
          >
            {h.toString().padStart(2, "0")}h
          </span>
        ))}
      </div>
    </div>
  );
}

function StopEditor({
  channel,
  stop,
  onChange,
  onApplySwatch,
  onDelete,
  onClose,
}: {
  channel: SkyChannel;
  stop: SkyChannelStop;
  onChange: (patch: Partial<SkyChannelStop>) => void;
  onApplySwatch: (swatchId: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        marginTop: 10,
        padding: 10,
        borderRadius: 8,
        background: "rgba(255,255,255,0.05)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          fontSize: 11,
          marginBottom: 8,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <ColorDot color={stop.color} />
          <strong>
            {channel} stop at {fmtTime(stop.timeHours)}
          </strong>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={onDelete}
            style={{
              background: "rgba(255,90,90,0.14)",
              color: "inherit",
              border: "1px solid rgba(255,90,90,0.35)",
              borderRadius: 6,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            Delete
          </button>
          <button
            onClick={onClose}
            style={{
              background: "rgba(255,255,255,0.06)",
              color: "inherit",
              border: "1px solid rgba(255,255,255,0.15)",
              borderRadius: 6,
              padding: "2px 8px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            Close
          </button>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "auto 1fr auto 1fr",
          columnGap: 12,
          rowGap: 8,
          alignItems: "center",
          fontSize: 11,
        }}
      >
        <label style={{ opacity: 0.75 }}>time</label>
        <input
          type="range"
          min={0}
          max={HOURS}
          step={0.01}
          value={stop.timeHours}
          onChange={(e) =>
            onChange({ timeHours: wrap24(parseFloat(e.target.value)) })
          }
          style={{ width: "100%" }}
        />
        <label style={{ opacity: 0.75 }}>color</label>
        <ColorInput
          color={stop.color}
          onChange={(c) => onChange({ color: c, swatchId: CUSTOM_SWATCH_ID })}
        />

        <label style={{ opacity: 0.75 }}>intensity</label>
        <input
          type="range"
          min={0}
          max={2}
          step={0.01}
          value={stop.intensity ?? 1}
          onChange={(e) => onChange({ intensity: parseFloat(e.target.value) })}
          style={{ width: "100%" }}
        />

        <label style={{ opacity: 0.75 }}>swatch</label>
        <SwatchPicker
          channel={channel}
          value={stop.swatchId}
          onChange={(id) => onApplySwatch(id)}
        />
        <div />
        <div />
      </div>
    </div>
  );
}

function SwatchPicker({
  channel,
  value,
  onChange,
}: {
  channel: SkyChannel;
  value: string;
  onChange: (id: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: "rgba(0,0,0,0.35)",
          color: "inherit",
          border: "1px solid rgba(255,255,255,0.15)",
          borderRadius: 6,
          padding: "2px 6px",
          fontSize: 11,
        }}
      >
        <option value={CUSTOM_SWATCH_ID}>custom</option>
        {SKY_SWATCHES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {SKY_SWATCHES.map((s) => (
          <button
            key={s.id}
            onClick={() => onChange(s.id)}
            title={`${s.label} — applies ${channel} color`}
            style={{
              width: 20,
              height: 16,
              borderRadius: 3,
              background: swatchColorFor(channel, s),
              border: `1px solid ${s.id === value ? "#ffffff" : "rgba(255,255,255,0.15)"}`,
              cursor: "pointer",
              padding: 0,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Thin 24h strip showing the active lightning window. A filled yellow
 * bolt marks the start; a hollow (white-outline) bolt marks the end.
 * The connecting bar highlights the "on" arc, wrapping past midnight
 * when end < start.
 */
function LightningWindowStrip() {
  const lightning = useSimStore((s) => s.lightning);
  const setLightning = useSimStore((s) => s.setLightning);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<"start" | "end" | null>(null);
  const start = wrap24(lightning.activeStartHour);
  const end = wrap24(lightning.activeEndHour);

  const clientToHour = (clientX: number): number => {
    const el = stripRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
    return (x / Math.max(1, rect.width)) * HOURS;
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const h = wrap24(clientToHour(e.clientX));
      if (dragRef.current === "start") setLightning({ activeStartHour: h });
      else setLightning({ activeEndHour: h });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setLightning]);

  const startPct = (start / HOURS) * 100;
  const endPct = (end / HOURS) * 100;
  const wraps = end < start;
  return (
    <div style={{ marginTop: 6, marginBottom: 2 }}>
      <div
        ref={stripRef}
        style={{
          position: "relative",
          height: 20,
          background: "rgba(0,0,0,0.30)",
          borderRadius: 4,
          border: "1px solid rgba(255,255,255,0.08)",
        }}
        title="Lightning active window (drag the bolts to reshape)"
      >
        {/* Active window band(s). */}
        {!wraps ? (
          <div style={activeBandStyle(startPct, endPct - startPct)} />
        ) : (
          <>
            <div style={activeBandStyle(startPct, 100 - startPct)} />
            <div style={activeBandStyle(0, endPct)} />
          </>
        )}
        {/* Start bolt (filled yellow). */}
        <BoltMarker
          leftPct={startPct}
          filled
          onPointerDown={(e) => {
            dragRef.current = "start";
            e.preventDefault();
          }}
          title={`Lightning on @ ${fmtTime(start)}`}
        />
        {/* End bolt (white outline). */}
        <BoltMarker
          leftPct={endPct}
          filled={false}
          onPointerDown={(e) => {
            dragRef.current = "end";
            e.preventDefault();
          }}
          title={`Lightning off @ ${fmtTime(end)}`}
        />
      </div>
    </div>
  );
}

function activeBandStyle(leftPct: number, widthPct: number): React.CSSProperties {
  return {
    position: "absolute",
    left: `${leftPct}%`,
    width: `${widthPct}%`,
    top: 0,
    bottom: 0,
    background: "rgba(250,204,21,0.14)",
    borderTop: "1px dashed rgba(250,204,21,0.35)",
    borderBottom: "1px dashed rgba(250,204,21,0.35)",
    pointerEvents: "none",
  };
}

/**
 * Thin 24h strip for the breath active window (cyan). Drag the markers
 * to reshape. End = 24 means through end of day (full-day with start = 0).
 */
function BreathWindowStrip() {
  const breath = useSimStore((s) => s.breath);
  const setBreath = useSimStore((s) => s.setBreath);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<"start" | "end" | null>(null);
  const start = Math.max(0, Math.min(24, breath.activeStartHour));
  const end = Math.max(0, Math.min(24, breath.activeEndHour));

  const clientToHour = (clientX: number): number => {
    const el = stripRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const x = Math.min(Math.max(0, clientX - rect.left), rect.width);
    return (x / Math.max(1, rect.width)) * HOURS;
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragRef.current) return;
      const h = Math.max(0, Math.min(24, clientToHour(e.clientX)));
      if (dragRef.current === "start") setBreath({ activeStartHour: h });
      else setBreath({ activeEndHour: h });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [setBreath]);

  const startPct = (start / HOURS) * 100;
  const endPct = (end / HOURS) * 100;
  const wraps = end < start;
  return (
    <div style={{ marginTop: 4, marginBottom: 2 }}>
      <div
        ref={stripRef}
        style={{
          position: "relative",
          height: 18,
          background: "rgba(0,0,0,0.30)",
          borderRadius: 4,
          border: "1px solid rgba(255,255,255,0.08)",
        }}
        title="Breath active window (drag markers to reshape)"
      >
        {!wraps ? (
          <div style={breathBandStyle(startPct, endPct - startPct)} />
        ) : (
          <>
            <div style={breathBandStyle(startPct, 100 - startPct)} />
            <div style={breathBandStyle(0, endPct)} />
          </>
        )}
        <BreathMarker
          leftPct={startPct}
          filled
          onPointerDown={(e) => {
            dragRef.current = "start";
            e.preventDefault();
          }}
          title={`Breath on @ ${fmtTime(start)}`}
        />
        <BreathMarker
          leftPct={endPct}
          filled={false}
          onPointerDown={(e) => {
            dragRef.current = "end";
            e.preventDefault();
          }}
          title={`Breath off @ ${end >= 24 ? "24:00" : fmtTime(end)}`}
        />
      </div>
    </div>
  );
}

function breathBandStyle(leftPct: number, widthPct: number): React.CSSProperties {
  return {
    position: "absolute",
    left: `${leftPct}%`,
    width: `${widthPct}%`,
    top: 0,
    bottom: 0,
    background: "rgba(119,213,255,0.16)",
    borderTop: "1px dashed rgba(119,213,255,0.4)",
    borderBottom: "1px dashed rgba(119,213,255,0.4)",
    pointerEvents: "none",
  };
}

function BreathMarker({
  leftPct,
  filled,
  onPointerDown,
  title,
}: {
  leftPct: number;
  filled: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  title: string;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      title={title}
      style={{
        position: "absolute",
        left: `calc(${leftPct}% - 7px)`,
        top: 2,
        width: 14,
        height: 14,
        cursor: "ew-resize",
        touchAction: "none",
        zIndex: 2,
        borderRadius: 14,
        background: filled ? "rgba(119,213,255,0.95)" : "transparent",
        border: filled
          ? "1.5px solid rgba(20,60,90,0.85)"
          : "1.5px solid rgba(119,213,255,0.95)",
        boxSizing: "border-box",
      }}
    />
  );
}

function BoltMarker({
  leftPct,
  filled,
  onPointerDown,
  title,
}: {
  leftPct: number;
  filled: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  title: string;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      title={title}
      style={{
        position: "absolute",
        left: `calc(${leftPct}% - 8px)`,
        top: 1,
        width: 16,
        height: 18,
        cursor: "ew-resize",
        touchAction: "none",
        zIndex: 2,
      }}
    >
      <svg width={16} height={18} viewBox="0 0 16 18" style={{ display: "block" }}>
        <path
          d="M9 1 L3 10 L7 10 L6 17 L13 7 L9 7 Z"
          fill={filled ? "#facc15" : "none"}
          stroke={filled ? "#78350f" : "#ffffff"}
          strokeWidth={filled ? 0.8 : 1.2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
