import { useEffect, useMemo, useState } from "react";
import { useSimStore, type PadEq } from "../state";
import { getPadEngine } from "../audio/PadEngine";
import { getBellowsPadEngine } from "../audio/BellowsPadEngine";

const W = 300;
const H = 110;
const PAD_X = 26;
const PAD_Y = 10;
const FMIN = 20;
const FMAX = 20000;
/** EQ curve scale. */
const DB_MIN = -18;
const DB_MAX = 18;
/** Spectrum scale (FFT dBFS). */
const SPEC_MIN = -110;
const SPEC_MAX = -10;
const SAMPLES = 160;

const xForF = (f: number) =>
  PAD_X +
  ((Math.log(f) - Math.log(FMIN)) / (Math.log(FMAX) - Math.log(FMIN))) *
    (W - PAD_X * 2);
const yForDb = (db: number) =>
  H - PAD_Y - ((db - DB_MIN) / (DB_MAX - DB_MIN)) * (H - PAD_Y * 2);
const yForSpec = (db: number) =>
  H -
  PAD_Y -
  clamp(0, 1, (db - SPEC_MIN) / (SPEC_MAX - SPEC_MIN)) * (H - PAD_Y * 2);

/**
 * Live pad output spectrum (post EQ and master filters) with the master
 * EQ's combined magnitude curve drawn on top, so EQ moves can be read
 * against what the pad is actually producing.
 */
export function PadEqDisplay({ eq }: { eq: PadEq }) {
  const engineType = useSimStore((state) => state.pad.engine);
  const freqs = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const u = i / SAMPLES;
      out.push(Math.exp(Math.log(FMIN) + u * (Math.log(FMAX) - Math.log(FMIN))));
    }
    return out;
  }, []);

  const [spectrumPath, setSpectrumPath] = useState<string | null>(null);
  useEffect(() => {
    let raf = 0;
    let last = 0;
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 33) return;
      last = t;
      const engine =
        engineType === "tone" ? getPadEngine() : getBellowsPadEngine();
      const spec = engine.isStarted() ? engine.getSpectrum() : null;
      if (!spec) {
        setSpectrumPath(null);
        return;
      }
      const binHz = engine.getSampleRate() / (spec.length * 2);
      const pts: string[] = [`${xForF(FMIN).toFixed(1)},${H - PAD_Y}`];
      for (const f of freqs) {
        const bin = Math.min(spec.length - 1, Math.max(1, Math.round(f / binHz)));
        const db = Number.isFinite(spec[bin]) ? spec[bin] : SPEC_MIN;
        pts.push(`${xForF(f).toFixed(1)},${yForSpec(db).toFixed(1)}`);
      }
      pts.push(`${xForF(FMAX).toFixed(1)},${H - PAD_Y}`);
      setSpectrumPath(`M ${pts.join(" L ")} Z`);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [engineType, freqs]);

  const curve = useMemo(() => {
    const pts = freqs.map((f) => {
      const db = eq.enabled
        ? lowShelfDb(f, eq.lowHz, eq.lowDb) +
          peakingDb(f, eq.midHz, eq.midQ, eq.midDb) +
          highShelfDb(f, eq.highHz, eq.highDb)
        : 0;
      return `${xForF(f).toFixed(1)},${yForDb(clamp(DB_MIN, DB_MAX, db)).toFixed(1)}`;
    });
    return `M ${pts.join(" L ")}`;
  }, [freqs, eq]);

  const bands: Array<{ f: number; db: number }> = [
    { f: eq.lowHz, db: eq.lowDb },
    { f: eq.midHz, db: eq.midDb },
    { f: eq.highHz, db: eq.highDb },
  ];

  return (
    <div
      style={{
        background: "rgba(0,0,0,0.4)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 4,
        marginTop: 4,
      }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        width="100%"
        height={H}
        style={{ display: "block" }}
      >
        {spectrumPath && (
          <path d={spectrumPath} fill="rgba(125,211,252,0.18)" stroke="rgba(125,211,252,0.45)" strokeWidth={0.75} />
        )}
        {[-12, -6, 6, 12].map((db) => (
          <line
            key={db}
            x1={PAD_X}
            x2={W - PAD_X}
            y1={yForDb(db)}
            y2={yForDb(db)}
            stroke="rgba(255,255,255,0.06)"
          />
        ))}
        <line
          x1={PAD_X}
          x2={W - PAD_X}
          y1={yForDb(0)}
          y2={yForDb(0)}
          stroke="rgba(255,255,255,0.18)"
          strokeDasharray="2 3"
        />
        {[100, 1000, 10000].map((f) => (
          <line
            key={f}
            x1={xForF(f)}
            x2={xForF(f)}
            y1={PAD_Y}
            y2={H - PAD_Y}
            stroke="rgba(255,255,255,0.08)"
          />
        ))}
        <path
          d={curve}
          fill="none"
          stroke={eq.enabled ? "#c084fc" : "rgba(192,132,252,0.35)"}
          strokeWidth={2}
        />
        {eq.enabled &&
          bands.map((b, i) => (
            <circle
              key={i}
              cx={xForF(clamp(FMIN, FMAX, b.f))}
              cy={yForDb(clamp(DB_MIN, DB_MAX, b.db))}
              r={3}
              fill="#c084fc"
              stroke="rgba(255,255,255,0.8)"
              strokeWidth={0.75}
            />
          ))}
        {[100, 1000, 10000].map((f) => (
          <text
            key={f}
            x={xForF(f)}
            y={H - 1}
            fontSize={8}
            textAnchor="middle"
            fill="rgba(255,255,255,0.5)"
          >
            {f >= 1000 ? `${f / 1000}k` : f}
          </text>
        ))}
        {[-12, 0, 12].map((db) => (
          <text
            key={db}
            x={2}
            y={yForDb(db) + 3}
            fontSize={8}
            fill="rgba(255,255,255,0.45)"
          >
            {db > 0 ? `+${db}` : db}
          </text>
        ))}
      </svg>
    </div>
  );
}

function clamp(lo: number, hi: number, v: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const FS = 48000;

/** Magnitude in dB of a biquad with the given RBJ coefficients at `f`. */
function biquadDb(
  f: number,
  b0: number,
  b1: number,
  b2: number,
  a0: number,
  a1: number,
  a2: number,
): number {
  const w = (2 * Math.PI * f) / FS;
  const cw = Math.cos(w);
  const c2w = Math.cos(2 * w);
  const sw = Math.sin(w);
  const s2w = Math.sin(2 * w);
  const nr = b0 + b1 * cw + b2 * c2w;
  const ni = -(b1 * sw + b2 * s2w);
  const dr = a0 + a1 * cw + a2 * c2w;
  const di = -(a1 * sw + a2 * s2w);
  const num = Math.sqrt(nr * nr + ni * ni);
  const den = Math.sqrt(dr * dr + di * di);
  return 20 * Math.log10(Math.max(1e-9, num / Math.max(1e-9, den)));
}

// Web Audio shelves use slope S = 1, so alpha = sin(w0) / 2 * sqrt(2).
function lowShelfDb(f: number, f0: number, gainDb: number): number {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / FS;
  const cw = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
  const k = 2 * Math.sqrt(A) * alpha;
  return biquadDb(
    f,
    A * (A + 1 - (A - 1) * cw + k),
    2 * A * (A - 1 - (A + 1) * cw),
    A * (A + 1 - (A - 1) * cw - k),
    A + 1 + (A - 1) * cw + k,
    -2 * (A - 1 + (A + 1) * cw),
    A + 1 + (A - 1) * cw - k,
  );
}

function highShelfDb(f: number, f0: number, gainDb: number): number {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / FS;
  const cw = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
  const k = 2 * Math.sqrt(A) * alpha;
  return biquadDb(
    f,
    A * (A + 1 + (A - 1) * cw + k),
    -2 * A * (A - 1 + (A + 1) * cw),
    A * (A + 1 + (A - 1) * cw - k),
    A + 1 - (A - 1) * cw + k,
    2 * (A - 1 - (A + 1) * cw),
    A + 1 - (A - 1) * cw - k,
  );
}

function peakingDb(f: number, f0: number, Q: number, gainDb: number): number {
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * f0) / FS;
  const cw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.max(0.0001, Q));
  return biquadDb(
    f,
    1 + alpha * A,
    -2 * cw,
    1 - alpha * A,
    1 + alpha / A,
    -2 * cw,
    1 - alpha / A,
  );
}
