import {
  PAD_DELAY_SYNCS,
  type PadDelaySync,
  type PadEngineType,
  type PadEq,
  type PadKeyframeParam,
  type PadParams,
  type PadWaveform,
} from "../state";
import { PadEqDisplay } from "./PadEqDisplay";
import { PadFilterResponse } from "./PadFilterResponse";

const WAVEFORMS: PadWaveform[] = ["sine", "sawtooth", "square", "triangle"];

const OSC2_INTERVALS: Array<{ semis: number; label: string }> = [
  { semis: -24, label: "-2 oct" },
  { semis: -12, label: "-1 oct" },
  { semis: -5, label: "-4th" },
  { semis: 0, label: "unison" },
  { semis: 3, label: "+min 3rd" },
  { semis: 4, label: "+maj 3rd" },
  { semis: 5, label: "+4th" },
  { semis: 7, label: "+5th" },
  { semis: 12, label: "+1 oct" },
  { semis: 19, label: "+oct+5th" },
  { semis: 24, label: "+2 oct" },
];

/**
 * Warm-pad synth controls: voicing, envelope, filter, chorus, master.
 * Intentionally simpler than the drone synth panel — the pad
 * uses one global patch and no per-note effects.
 */
export function PadSynthPanel({
  pad,
  onChange,
  onParamSelect,
}: {
  pad: PadParams;
  onChange: (patch: Partial<PadParams>) => void;
  onParamSelect: (param: PadKeyframeParam) => void;
}) {
  const setAutomated = (param: PadKeyframeParam, value: number) => {
    onParamSelect(param);
    onChange({ [param]: value } as Partial<PadParams>);
  };
  const setEq = (patch: Partial<PadEq>) =>
    onChange({ eq: { ...pad.eq, ...patch } });
  const isTone = pad.engine === "tone";
  const isAnalog = pad.engine === "bellows-analog";

  return (
    <section style={sectionStyle}>
      <div style={engineBar}>
        <label style={inlineLabel}>
          <strong style={{ width: 90 }}>Sound engine</strong>
          <select
            value={pad.engine}
            onChange={(e) =>
              onChange({ engine: e.target.value as PadEngineType })
            }
            style={{ ...selectStyle, minWidth: 180 }}
          >
            <option value="tone">Warm Pad (current)</option>
            <option value="bellows-analog">Bellows Fat Analog</option>
            <option value="bellows-motion">Bellows Motion Pad</option>
          </select>
        </label>
        <span style={hint}>
          {isTone
            ? "Original Tone.js engine with all detailed oscillator controls."
            : "AudioWorklet engine; timeline, automation, envelope, filter, ambience and master EQ remain active."}
        </span>
      </div>
      <div style={grid}>
        <Card title="Voicing">
          <label style={inlineLabel}>
            <span style={{ width: 70 }}>
              {pad.engine === "bellows-motion" ? "Character" : "Waveform"}
            </span>
            <select
              value={pad.waveform}
              onChange={(e) =>
                onChange({ waveform: e.target.value as PadWaveform })
              }
              style={selectStyle}
            >
              {WAVEFORMS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          {isTone && (
            <Slider
              label="Unison"
              value={pad.unisonCount}
              min={1}
              max={8}
              step={1}
              onChange={(v) => onChange({ unisonCount: Math.round(v) })}
            />
          )}
          {(isTone || isAnalog) && (
            <Slider
              label="Spread"
              value={pad.unisonDetuneCents}
              min={0}
              max={50}
              step={0.5}
              unit="c"
              onChange={(v) => setAutomated("unisonDetuneCents", v)}
            />
          )}
          {isTone && (
            <>
              <Slider
                label="Width"
                value={pad.stereoWidth}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => setAutomated("stereoWidth", v)}
              />
              <Slider
                label="Drift rate"
                value={pad.driftRateHz}
                min={0.02}
                max={6}
                step={0.01}
                unit="Hz"
                logScale
                onChange={(v) => setAutomated("driftRateHz", v)}
              />
            </>
          )}
          {(isTone || isAnalog) && (
            <Slider
              label="Drift depth"
              value={pad.driftDepthCents}
              min={0}
              max={30}
              step={0.5}
              unit="c"
              onChange={(v) => setAutomated("driftDepthCents", v)}
            />
          )}
          <div style={hint}>
            {isTone
              ? "Unison oscillators are spread across stereo with independent drift phases."
              : isAnalog
                ? "Band-limited analog oscillators with worklet-native detune and drift."
                : "A scanned wavetable creates a smoother, evolving pad texture."}
          </div>
        </Card>

        <Card title="Body">
          {(isTone || isAnalog) && (
            <Slider
              label="Sub level"
              value={pad.subLevel}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => setAutomated("subLevel", v)}
            />
          )}
          {isTone && (
            <>
              <label style={inlineLabel}>
                <span style={{ width: 70 }}>Sub octave</span>
                <select
                  value={pad.subOctave}
                  onChange={(e) =>
                    onChange({ subOctave: parseInt(e.target.value, 10) })
                  }
                  style={selectStyle}
                >
                  <option value={-1}>-1 oct</option>
                  <option value={-2}>-2 oct</option>
                </select>
              </label>
              <Slider
                label="Mono below"
                value={pad.monoBelowHz}
                min={20}
                max={400}
                step={1}
                unit="Hz"
                logScale
                onChange={(v) => setAutomated("monoBelowHz", v)}
              />
            </>
          )}
          <Slider
            label="Glue"
            value={pad.glue}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("glue", v)}
          />
          <div style={hint}>
            {isTone
              ? "Sub adds weight; Mono below centres the low end. Glue compresses the whole pad."
              : "Glue gently compresses the worklet output so sustained notes sit together."}
          </div>
        </Card>

        {isTone && <Card title="Layers">
          <Slider
            label="Osc 2"
            value={pad.osc2Level}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("osc2Level", v)}
          />
          <label style={inlineLabel}>
            <span style={{ width: 70 }}>Osc 2 wave</span>
            <select
              value={pad.osc2Waveform}
              onChange={(e) =>
                onChange({ osc2Waveform: e.target.value as PadWaveform })
              }
              style={selectStyle}
            >
              {WAVEFORMS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
          <label style={inlineLabel}>
            <span style={{ width: 70 }}>Interval</span>
            <select
              value={pad.osc2Semitones}
              onChange={(e) =>
                onChange({ osc2Semitones: parseInt(e.target.value, 10) })
              }
              style={selectStyle}
            >
              {OSC2_INTERVALS.map((i) => (
                <option key={i.semis} value={i.semis}>
                  {i.label}
                </option>
              ))}
            </select>
          </label>
          <Slider
            label="Noise"
            value={pad.noiseLevel}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("noiseLevel", v)}
          />
          <Slider
            label="Noise tone"
            value={pad.noiseToneHz}
            min={500}
            max={14000}
            step={10}
            unit="Hz"
            logScale
            onChange={(v) => setAutomated("noiseToneHz", v)}
          />
          <Slider
            label="Humanize"
            value={pad.humanize}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("humanize", v)}
          />
          <div style={hint}>
            Osc 2 layers a different waveform at an interval for a richer
            timbre. Noise adds breathy air that follows each note's
            envelope. Humanize gives every new note slightly different
            tuning, brightness and level.
          </div>
        </Card>}

        <Card title="Envelope">
          <Slider
            label="Attack"
            value={pad.attack}
            min={0.01}
            max={8}
            step={0.01}
            unit="s"
            logScale
            onChange={(v) => setAutomated("attack", v)}
          />
          <Slider
            label="Decay"
            value={pad.decay}
            min={0.01}
            max={5}
            step={0.01}
            unit="s"
            logScale
            onChange={(v) => setAutomated("decay", v)}
          />
          <Slider
            label="Sustain"
            value={pad.sustain}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("sustain", v)}
          />
          <Slider
            label="Release"
            value={pad.release}
            min={0.01}
            max={12}
            step={0.01}
            unit="s"
            logScale
            onChange={(v) => setAutomated("release", v)}
          />
          <EnvelopeGraph
            a={pad.attack}
            d={pad.decay}
            s={pad.sustain}
            r={pad.release}
          />
        </Card>

        <Card title="Filter">
          <Slider
            label="Cutoff"
            value={pad.filterHz}
            min={80}
            max={18000}
            step={1}
            unit="Hz"
            logScale
            onChange={(v) => setAutomated("filterHz", v)}
          />
          {isTone && <label style={inlineLabel}>
            <span style={{ width: 70 }}>Slope</span>
            <select
              value={pad.filterSlope}
              onChange={(e) =>
                onChange({
                  filterSlope: e.target.value === "12" ? 12 : 24,
                })
              }
              style={selectStyle}
            >
              <option value={12}>12 dB/oct (gentle)</option>
              <option value={24}>24 dB/oct (warm, analog)</option>
            </select>
          </label>}
          {isTone && <Slider
            label="Key track"
            value={pad.filterKeyTrack}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("filterKeyTrack", v)}
          />}
          <Slider
            label="Q"
            value={pad.filterQ}
            min={0.1}
            max={12}
            step={0.05}
            onChange={(v) => setAutomated("filterQ", v)}
          />
          <Slider
            label="Env"
            value={pad.filterEnvAmount}
            min={0}
            max={5000}
            step={10}
            unit="c"
            onChange={(v) => setAutomated("filterEnvAmount", v)}
          />
          <div style={hint}>
            Every note has its own filter envelope, so new notes can swell
            without reopening the filter on older notes.
          </div>
          {(isTone || pad.engine === "bellows-motion") && <Slider
            label={isTone ? "LFO rate" : "Motion rate"}
            value={pad.filterLfoRateHz}
            min={0.02}
            max={8}
            step={0.01}
            unit="Hz"
            logScale
            onChange={(v) => setAutomated("filterLfoRateHz", v)}
          />}
          {(isTone || pad.engine === "bellows-motion") && <Slider
            label={isTone ? "LFO depth" : "Motion depth"}
            value={pad.filterLfoDepth}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("filterLfoDepth", v)}
          />}
          <div style={hint}>
            LFO sweeps cutoff down from base by up to one octave.
          </div>
          <PadFilterResponse pad={pad} />
        </Card>

        <Card title="Saturation">
          <Slider
            label="Drive"
            value={pad.saturation}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("saturation", v)}
          />
          <div style={hint}>
            Compensated soft drive adds warmth before chorus and ambience
            without simply making the patch louder.
          </div>
        </Card>

        <Card title="Chorus">
          <Slider
            label="Rate"
            value={pad.chorusRateHz}
            min={0.05}
            max={4}
            step={0.01}
            unit="Hz"
            logScale
            onChange={(v) => setAutomated("chorusRateHz", v)}
          />
          <Slider
            label="Depth"
            value={pad.chorusDepth}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("chorusDepth", v)}
          />
        </Card>

        <Card title="Ambience">
          <Slider
            label="Reverb"
            value={pad.reverbMix}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("reverbMix", v)}
          />
          <Slider
            label="Room"
            value={pad.reverbRoomSize}
            min={0}
            max={0.99}
            step={0.01}
            onChange={(v) => setAutomated("reverbRoomSize", v)}
          />
          <Slider
            label="Tail tone"
            value={pad.reverbDampingHz}
            min={200}
            max={12000}
            step={10}
            unit="Hz"
            logScale
            onChange={(v) => setAutomated("reverbDampingHz", v)}
          />
          <div style={hint}>
            Tail tone changes only the reverb: lower values sound darker
            and softer; higher values sound brighter and airier.
          </div>
          <Slider
            label="Pre-delay"
            value={pad.reverbPreDelaySec}
            min={0}
            max={0.2}
            step={0.001}
            unit="s"
            onChange={(v) => setAutomated("reverbPreDelaySec", v)}
          />
          <Slider
            label="Delay"
            value={pad.delayMix}
            min={0}
            max={0.6}
            step={0.01}
            onChange={(v) => setAutomated("delayMix", v)}
          />
          <label style={inlineLabel}>
            <span style={{ width: 70 }}>Delay sync</span>
            <select
              value={pad.delaySync}
              onChange={(e) =>
                onChange({ delaySync: e.target.value as PadDelaySync })
              }
              style={selectStyle}
            >
              {PAD_DELAY_SYNCS.map((s) => (
                <option key={s} value={s}>
                  {s === "off" ? "free (seconds)" : s}
                </option>
              ))}
            </select>
          </label>
          {pad.delaySync === "off" ? (
            <Slider
              label="Delay time"
              value={pad.delayTimeSec}
              min={0.05}
              max={1.5}
              step={0.005}
              unit="s"
              logScale
              onChange={(v) => setAutomated("delayTimeSec", v)}
            />
          ) : (
            <Slider
              label="Tempo"
              value={pad.tempoBpm}
              min={40}
              max={200}
              step={1}
              unit="bpm"
              onChange={(v) => onChange({ tempoBpm: Math.round(v) })}
            />
          )}
          <Slider
            label="Feedback"
            value={pad.delayFeedback}
            min={0}
            max={0.75}
            step={0.01}
            onChange={(v) => setAutomated("delayFeedback", v)}
          />
          <div style={hint}>
            Dry, reverb, and ping-pong delay returns are normalized to keep
            ambience changes from overloading the output.
          </div>
        </Card>

        <Card title="Master">
          <label style={inlineLabel}>
            <input
              type="checkbox"
              checked={pad.enabled}
              onChange={(e) => onChange({ enabled: e.target.checked })}
            />
            <span>Enable audio</span>
          </label>
          <Slider
            label="Master"
            value={pad.master}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => setAutomated("master", v)}
          />
          <label style={{ ...inlineLabel, marginTop: 6 }}>
            <input
              type="checkbox"
              checked={pad.eq.enabled}
              onChange={(e) => setEq({ enabled: e.target.checked })}
            />
            <span>EQ</span>
          </label>
          <PadEqDisplay eq={pad.eq} />
          <Slider label="Low" value={pad.eq.lowDb} min={-18} max={18} step={0.5} unit="dB" onChange={(v) => setEq({ lowDb: v })} />
          <Slider label="Low freq" value={pad.eq.lowHz} min={20} max={1000} step={1} unit="Hz" logScale onChange={(v) => setEq({ lowHz: v })} />
          <Slider label="Mid" value={pad.eq.midDb} min={-18} max={18} step={0.5} unit="dB" onChange={(v) => setEq({ midDb: v })} />
          <Slider label="Mid freq" value={pad.eq.midHz} min={100} max={10000} step={1} unit="Hz" logScale onChange={(v) => setEq({ midHz: v })} />
          <Slider label="Mid Q" value={pad.eq.midQ} min={0.2} max={10} step={0.05} logScale onChange={(v) => setEq({ midQ: v })} />
          <Slider label="High" value={pad.eq.highDb} min={-18} max={18} step={0.5} unit="dB" onChange={(v) => setEq({ highDb: v })} />
          <Slider label="High freq" value={pad.eq.highHz} min={1000} max={18000} step={10} unit="Hz" logScale onChange={(v) => setEq({ highHz: v })} />
          <div style={hint}>
            Shaded area is the live pad output spectrum; the line is the
            EQ curve. Try cutting Mid around 300 Hz to clear boxiness and
            lifting High for air.
          </div>
        </Card>
      </div>
    </section>
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
  unit?: string;
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  logScale,
  unit,
}: SliderProps) {
  const toSlider = (v: number) => (logScale ? Math.log(Math.max(1e-6, v)) : v);
  const fromSlider = (v: number) => (logScale ? Math.exp(v) : v);
  return (
    <label style={rowLabel}>
      <span style={{ fontSize: 11, width: 60 }}>{label}</span>
      <input
        type="range"
        min={toSlider(min)}
        max={toSlider(max)}
        step={logScale ? (toSlider(max) - toSlider(min)) / 500 : step}
        value={toSlider(value)}
        onChange={(e) => onChange(fromSlider(parseFloat(e.target.value)))}
        style={{ flex: 1 }}
      />
      <span
        style={{
          fontSize: 10,
          width: 60,
          textAlign: "right",
          opacity: 0.8,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value >= 100
          ? value.toFixed(0)
          : value >= 10
            ? value.toFixed(1)
            : value.toFixed(2)}
        {unit ? ` ${unit}` : ""}
      </span>
    </label>
  );
}

function EnvelopeGraph({
  a,
  d,
  s,
  r,
}: {
  a: number;
  d: number;
  s: number;
  r: number;
}) {
  // Layout ADSR into a 100-wide box, scaled so the whole envelope
  // (including a nominal 0.4s sustain plateau) fits.
  // Mirrors the engine: linear attack, exponential decay (time constant
  // d / 4) and release (time constant r / 2, still audible past r).
  const total = Math.max(0.1, a + d + 0.4 + r);
  const px = (t: number) => (t / total) * 100;
  const yFor = (level: number) => 24 - Math.max(0, Math.min(1, level)) * 20;
  const sus = Math.max(0, Math.min(1, s));
  const pts: string[] = [`0,24`, `${px(a).toFixed(2)},4`];
  const steps = 24;
  for (let i = 1; i <= steps; i++) {
    const t = (d * i) / steps;
    const level = sus + (1 - sus) * Math.exp(-t / (d / 4));
    pts.push(`${px(a + t).toFixed(2)},${yFor(level).toFixed(2)}`);
  }
  const holdEnd = a + d + 0.4;
  pts.push(`${px(holdEnd).toFixed(2)},${yFor(sus).toFixed(2)}`);
  for (let i = 1; i <= steps; i++) {
    const t = (r * i) / steps;
    const level = sus * Math.exp(-t / (r / 2));
    pts.push(`${px(holdEnd + t).toFixed(2)},${yFor(level).toFixed(2)}`);
  }
  const points = pts.join(" ");
  return (
    <svg
      viewBox="0 0 100 28"
      preserveAspectRatio="none"
      width="100%"
      height="42"
      style={{
        background: "rgba(0,0,0,0.35)",
        border: "1px solid rgba(255,255,255,0.12)",
        borderRadius: 4,
        marginTop: 4,
      }}
    >
      <polyline
        points={points}
        fill="none"
        stroke="#c084fc"
        strokeWidth="1"
        vectorEffect="non-scaling-stroke"
      />
      <polyline
        points={`0,24 ${points} 100,24`}
        fill="rgba(192,132,252,0.15)"
        stroke="none"
      />
    </svg>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={cardStyle}>
      <div style={cardTitle}>{title}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {children}
      </div>
    </div>
  );
}

const sectionStyle: React.CSSProperties = {
  padding: "10px 0",
  borderTop: "1px solid rgba(255,255,255,0.08)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const engineBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 12,
  padding: "8px 10px",
  borderRadius: 6,
  background: "rgba(192,132,252,0.08)",
  border: "1px solid rgba(192,132,252,0.25)",
};
const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: 10,
};
const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6,
  padding: "8px 10px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const cardTitle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  opacity: 0.75,
};
const rowLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};
const inlineLabel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 12,
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
const hint: React.CSSProperties = {
  fontSize: 10,
  opacity: 0.6,
  lineHeight: 1.3,
};
