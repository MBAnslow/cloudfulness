import type { Bellows, Instrument } from "bellowsjs";
import * as Tone from "tone";
import type { PadEngineType, PadParams, PadWaveform } from "../state";
import { activePadVoicesAt } from "./padCycle";
import { ensureLimitedAux } from "./MasterFxBus";

type BellowsEngineType = Exclude<PadEngineType, "tone">;

interface HeldVoice {
  noteId: number;
  note: string;
}

const clamp = (lo: number, hi: number, value: number): number =>
  Math.max(lo, Math.min(hi, Number.isFinite(value) ? value : lo));

const shapeFor = (waveform: PadWaveform): number =>
  ({ sawtooth: 0, square: 1, triangle: 2, sine: 3 })[waveform];

function delaySeconds(p: PadParams): number {
  if (p.delaySync === "off") return clamp(0.05, 1.5, p.delayTimeSec);
  const beats = {
    "1/4": 1,
    "1/8": 0.5,
    "1/8d": 0.75,
    "1/8t": 1 / 3,
    "1/16": 0.25,
  }[p.delaySync];
  return (60 / clamp(30, 300, p.tempoBpm)) * beats;
}

/**
 * AudioWorklet pad alternative. Bellows generates the voices and effects;
 * its analyser output is rerouted into the app's shared limited master bus.
 * Timeline notes and the public PadParams model remain shared with PadEngine.
 */
export class BellowsPadEngine {
  private bellows: Bellows | null = null;
  private instrument: Instrument | null = null;
  private instrumentType: BellowsEngineType | null = null;
  private startPromise: Promise<void> | null = null;
  private held = new Map<string, HeldVoice>();
  private probabilityGate = new Map<string, boolean>();
  private lastVoiceKey = "";
  private lastFxKey = "";

  async start(): Promise<void> {
    if (this.bellows) {
      if (this.bellows.ctx.state !== "running") await this.bellows.ctx.resume();
      return;
    }
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startOnce();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startOnce(): Promise<void> {
    await Tone.start();
    if (this.bellows) return;
    const { Bellows } = await import("bellowsjs");
    const context = Tone.getContext().rawContext as AudioContext;
    const bellows = await Bellows.boot({
      context,
      seed: "cloud-pad",
      masterGain: 0,
      closeContextOnDispose: false,
    });
    bellows.analyser.fftSize = 2048;
    // Bellows normally connects its analyser directly to destination.
    // Keep every engine under the app's shared compressor/brickwall limiter.
    bellows.analyser.disconnect();
    const aux = await ensureLimitedAux();
    bellows.analyser.connect(aux.input as unknown as AudioNode);
    bellows.onError = (message) => console.warn("[pad/bellows]", message);
    this.bellows = bellows;
  }

  isStarted(): boolean {
    return this.bellows !== null;
  }

  update(hour: number, p: PadParams): void {
    const bellows = this.bellows;
    if (!bellows) return;

    if (p.engine === "tone") {
      this.silence();
      bellows.masterGain(0);
      return;
    }

    this.ensureInstrument(p.engine, p);
    const instrument = this.instrument;
    if (!instrument) return;
    this.updateParams(instrument, p);
    bellows.masterGain(p.enabled ? clamp(0, 1, p.master) : 0);

    if (!p.enabled) {
      this.silence();
      return;
    }

    const active = activePadVoicesAt(p.notes, hour);
    const seen = new Set<string>();
    for (const voice of active) {
      seen.add(voice.id);
      if (voice.triggerProbability < 1) {
        const previous = this.probabilityGate.get(voice.id);
        if (previous === undefined) {
          const passes = Math.random() < voice.triggerProbability;
          this.probabilityGate.set(voice.id, passes);
          if (!passes) continue;
        } else if (!previous) {
          continue;
        }
      }

      const existing = this.held.get(voice.id);
      if (existing?.note === voice.note) continue;
      if (existing) instrument.off(existing.noteId);
      const noteId = instrument.on(
        { hz: Tone.Frequency(voice.note).toFrequency() *
          Math.pow(2, voice.detuneCents / 1200) },
        clamp(0, 1, voice.gain),
      );
      this.held.set(voice.id, { noteId, note: voice.note });
    }

    for (const [id, voice] of this.held) {
      if (seen.has(id)) continue;
      instrument.off(voice.noteId);
      this.held.delete(id);
    }
    for (const id of this.probabilityGate.keys()) {
      if (!seen.has(id)) this.probabilityGate.delete(id);
    }
  }

  private ensureInstrument(type: BellowsEngineType, p: PadParams): void {
    if (!this.bellows || (this.instrument && this.instrumentType === type)) return;
    if (this.instrument) {
      this.instrument.allOff();
      this.instrument.dispose({ releaseSeconds: clamp(0, 10, p.release) });
    }
    this.held.clear();
    this.probabilityGate.clear();
    this.lastVoiceKey = "";
    this.lastFxKey = "";

    const engineId = type === "bellows-motion" ? "wavetable" : "va";
    const instrument = this.bellows.voice(engineId, {}, { polyphony: 32 });
    instrument.fx(
      ["compressor", {}],
      ["saturator", {}],
      ["chorus", {}],
      ["fdn", {}],
      ["delay", {}],
      ["eq", {}],
    );
    this.instrument = instrument;
    this.instrumentType = type;
  }

  private updateParams(instrument: Instrument, p: PadParams): void {
    const voiceKey = [
      p.engine, p.waveform, p.unisonDetuneCents, p.subLevel, p.filterHz,
      p.filterQ, p.filterEnvAmount, p.attack, p.decay, p.sustain, p.release,
      p.driftDepthCents, p.filterLfoRateHz, p.filterLfoDepth,
    ].join("|");
    if (voiceKey !== this.lastVoiceKey) {
      if (p.engine === "bellows-motion") {
        instrument
          .param("position", shapeFor(p.waveform) / 3)
          .param("scanRate", clamp(0.01, 8, p.filterLfoRateHz))
          .param("scanDepth", clamp(0, 1, Math.max(p.filterLfoDepth, p.driftDepthCents / 30)))
          .param("envToPosition", clamp(0, 1, p.filterEnvAmount / 5000))
          .param("attack", clamp(0, 10, p.attack))
          .param("decay", clamp(0, 10, p.decay))
          .param("sustain", clamp(0, 1, p.sustain))
          .param("release", clamp(0, 10, p.release))
          .param("filter", 1)
          .param("cutoff", clamp(20, 20000, p.filterHz))
          .param("resonance", clamp(0, 1, p.filterQ / 12));
      } else {
        instrument
          .param("shape", shapeFor(p.waveform))
          .param("detune", clamp(0, 100, p.unisonDetuneCents))
          .param("sub", clamp(0, 1, p.subLevel))
          .param("cutoff", clamp(20, 20000, p.filterHz))
          .param("resonance", clamp(0, 1, p.filterQ / 12))
          .param("envAmount", clamp(-6, 6, p.filterEnvAmount / 1200))
          .param("attack", clamp(0, 10, p.attack))
          .param("decay", clamp(0, 10, p.decay))
          .param("sustain", clamp(0, 1, p.sustain))
          .param("release", clamp(0, 10, p.release))
          .param("fAttack", clamp(0, 10, p.attack))
          .param("fDecay", clamp(0, 10, p.decay))
          .param("fSustain", clamp(0, 1, p.sustain))
          .param("fRelease", clamp(0, 10, p.release))
          .param("drift", clamp(0, 1, p.driftDepthCents / 30));
      }
      this.lastVoiceKey = voiceKey;
    }

    const delay = delaySeconds(p);
    const fxKey = [
      p.glue, p.saturation, p.chorusRateHz, p.chorusDepth, p.reverbMix,
      p.reverbRoomSize, p.reverbDampingHz, p.reverbPreDelaySec, p.delayMix,
      delay, p.delayFeedback, p.eq.enabled, p.eq.lowHz, p.eq.lowDb,
      p.eq.midHz, p.eq.midDb, p.eq.midQ, p.eq.highHz, p.eq.highDb,
    ].join("|");
    if (fxKey === this.lastFxKey) return;

    instrument
      .fxParam(0, "threshold", -24 * clamp(0, 1, p.glue))
      .fxParam(0, "ratio", 1 + clamp(0, 1, p.glue) * 3)
      .fxParam(0, "mix", clamp(0, 1, p.glue))
      .fxParam(1, "drive", 1 + clamp(0, 1, p.saturation) * 8)
      .fxParam(1, "mix", clamp(0, 1, p.saturation))
      .fxParam(1, "output", -3 * clamp(0, 1, p.saturation))
      .fxParam(2, "rate", clamp(0.01, 10, p.chorusRateHz))
      .fxParam(2, "depth", clamp(0, 1, p.chorusDepth))
      .fxParam(2, "mix", clamp(0, 0.75, p.chorusDepth))
      .fxParam(3, "size", 0.25 + clamp(0, 0.99, p.reverbRoomSize) * 2.75)
      .fxParam(3, "decay", 0.6 + Math.pow(clamp(0, 0.99, p.reverbRoomSize), 1.5) * 8)
      .fxParam(3, "damp", clamp(500, 20000, p.reverbDampingHz))
      .fxParam(3, "predelay", clamp(0, 0.25, p.reverbPreDelaySec))
      .fxParam(3, "mix", clamp(0, 0.8, p.reverbMix))
      .fxParam(4, "timeL", clamp(0.001, 4, delay))
      .fxParam(4, "timeR", clamp(0.001, 4, delay * 1.333))
      .fxParam(4, "feedback", clamp(0, 0.9, p.delayFeedback))
      .fxParam(4, "crossFeedback", 0.5)
      .fxParam(4, "mix", clamp(0, 0.8, p.delayMix));

    const eqEnabled = p.eq.enabled ? 1 : 0;
    instrument
      .fxParam(5, "b0freq", clamp(20, 20000, p.eq.lowHz))
      .fxParam(5, "b0gain", p.eq.lowDb)
      .fxParam(5, "b0q", 0.707)
      .fxParam(5, "b0enabled", eqEnabled)
      .fxParam(5, "b2freq", clamp(20, 20000, p.eq.midHz))
      .fxParam(5, "b2gain", p.eq.midDb)
      .fxParam(5, "b2q", p.eq.midQ)
      .fxParam(5, "b2enabled", eqEnabled)
      .fxParam(5, "b5freq", clamp(20, 20000, p.eq.highHz))
      .fxParam(5, "b5gain", p.eq.highDb)
      .fxParam(5, "b5q", 0.707)
      .fxParam(5, "b5enabled", eqEnabled);
    this.lastFxKey = fxKey;
  }

  private silence(): void {
    if (this.instrument && this.held.size > 0) this.instrument.allOff();
    this.held.clear();
    this.probabilityGate.clear();
  }

  getSpectrum(): Float32Array | null {
    if (!this.bellows) return null;
    const values = new Float32Array(this.bellows.analyser.frequencyBinCount);
    this.bellows.analyser.getFloatFrequencyData(values);
    return values;
  }

  getSampleRate(): number {
    return this.bellows?.ctx.sampleRate ?? Tone.getContext().sampleRate;
  }
}

let singleton: BellowsPadEngine | null = null;
export function getBellowsPadEngine(): BellowsPadEngine {
  if (!singleton) singleton = new BellowsPadEngine();
  return singleton;
}
