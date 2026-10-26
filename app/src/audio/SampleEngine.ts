import * as Tone from "tone";
import { useSimStore, sampleTrimRange, type Sample, type SamplesParams } from "../state";
import { getSampleBlob } from "../samples/sampleStorage";
import { clipsActiveAt, type ActiveClip } from "./sampleCycle";
import { applyFilterChain } from "./filterChain";
import { meterAbs } from "./meterAbs";
import { ensureLimitedAux, limitedAuxIfStarted } from "./MasterFxBus";

/**
 * Samples engine — scrubber-synced spans.
 *
 * Each `SampleClip` covers a derived sky-time span. While the playhead
 * is inside that span the engine plays the buffer at the matching
 * offset; leaving the span stops the voice. One voice per clip.
 *
 * Auto-play: start on enter, free-run at clip.playbackRate (matches
 * span math). Scrub / wrap: seek to offset. Pause: hold silent.
 * Random detune + master pitch LFO go through PitchShift so they do
 * not change playback length / timeline lock.
 *
 * Per-voice chain:
 *   Player → PitchShift → gain (position fades) → filter (LP) → panner →
 *      ┬── dryGain ──►
 *      ├── reverb → reverbWet ──►  → sampleBus → master → destination
 *      └── delay  → delayWet  ──►
 */

/** Hour jump larger than this is treated as a scrub / wrap. */
const MAX_SMOOTH_STEP_HOURS = 1.0;
/** Don't bother starting a segment with less buffer than this left. */
const MIN_REMAINING_BUF_SEC = 0.01;
/** Skip gain automation unless the target moved by at least this. */
const GAIN_EPS = 0.01;
const finite = (value: number, fallback: number): number =>
  Number.isFinite(value) ? value : fallback;

function normalizedWetMixes(
  reverb: number,
  delay: number,
): { dry: number; reverb: number; delay: number } {
  const r = Number.isFinite(reverb) ? Math.max(0, Math.min(1, reverb)) : 0;
  const d = Number.isFinite(delay) ? Math.max(0, Math.min(1, delay)) : 0;
  const dry = Math.max(0, 1 - r - d);
  const total = Math.max(1, dry + r + d);
  return { dry: dry / total, reverb: r / total, delay: d / total };
}

interface Voice {
  clipId: string;
  sampleId: string;
  player: Tone.Player;
  pitchShift: Tone.PitchShift;
  gain: Tone.Gain;
  filter: Tone.Filter;
  panner: Tone.Panner;
  dryGain: Tone.Gain;
  reverb: Tone.Freeverb;
  reverbWet: Tone.Gain;
  delay: Tone.FeedbackDelay;
  delayWet: Tone.Gain;
  /** Random detune in cents, baked at span enter. */
  randomCents: number;
  /** Last gain target we ramped toward (for thrash avoidance). */
  lastGainTarget: number;
  /** Buffer offset when the current player segment started. */
  startOffsetSec: number;
  /** Tone.now() when the current player segment started. */
  startedAtTone: number;
  /** True while autoPlay is off and the player is stopped mid-span. */
  paused: boolean;
  disposed: boolean;
  lastPitchSemitones: number;
  /** PitchShift is artifact-prone on transients, so keep its dry path at zero shift. */
  pitchShiftWet: boolean;
}

type EnterRoll = "accepted" | "rejected";

export class SampleEngine {
  private started = false;
  private startPromise: Promise<void> | null = null;
  private master: Tone.Gain | null = null;
  private masterHp: Tone.Filter | null = null;
  private masterLp: Tone.Filter | null = null;
  private bus: Tone.Gain | null = null;
  /** Dry path from bus → master; wet sends subtract from this. */
  private busDry: Tone.Gain | null = null;
  private masterReverb: Tone.Freeverb | null = null;
  private masterReverbWet: Tone.Gain | null = null;
  private masterDelay: Tone.FeedbackDelay | null = null;
  private masterDelayWet: Tone.Gain | null = null;
  private meter: Tone.Meter | null = null;
  private pitchCents = 0;
  private pitchLfoRateHz = 0;
  private pitchLfoDepthCents = 0;
  private pitchLfoShape: "sine" | "triangle" | "square" | "sawtooth" = "sine";
  private audioStartTone = 0;

  private currentPitchCents(): number {
    const t = Math.max(0, Tone.now() - this.audioStartTone);
    let v = 0;
    if (this.pitchLfoDepthCents > 0 && this.pitchLfoRateHz > 0) {
      const phase = ((t * this.pitchLfoRateHz) % 1 + 1) % 1;
      switch (this.pitchLfoShape) {
        case "sine":
          v = Math.sin(phase * Math.PI * 2);
          break;
        case "triangle":
          v = 4 * Math.abs(phase - 0.5) - 1;
          break;
        case "square":
          v = phase < 0.5 ? 1 : -1;
          break;
        case "sawtooth":
          v = 2 * phase - 1;
          break;
      }
    }
    return this.pitchCents + v * this.pitchLfoDepthCents;
  }

  private voices = new Map<string, Voice>();
  private buffers = new Map<string, Tone.ToneAudioBuffer>();
  private loading = new Map<string, Promise<Tone.ToneAudioBuffer | null>>();
  private prevHour = -1;
  /** Probability roll held for the current visit to a clip's span. */
  private enterRolls = new Map<string, EnterRoll>();

  async start(): Promise<void> {
    if (this.started) {
      if (Tone.getContext().rawContext.state !== "running") await Tone.start();
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
    if (this.started) return;
    this.master = new Tone.Gain(0);
    this.masterHp = new Tone.Filter({ type: "highpass", frequency: 10, Q: 0.7 });
    this.masterLp = new Tone.Filter({ type: "lowpass", frequency: 22000, Q: 0.7 });
    this.master.connect(this.masterHp);
    this.masterHp.connect(this.masterLp);
    this.bus = new Tone.Gain(1);
    this.busDry = new Tone.Gain(1);
    this.masterReverb = new Tone.Freeverb({ roomSize: 0.7, dampening: 3000 });
    this.masterReverbWet = new Tone.Gain(0);
    this.masterDelay = new Tone.FeedbackDelay({
      delayTime: 0.25,
      feedback: 0.3,
      wet: 1,
    });
    this.masterDelayWet = new Tone.Gain(0);
    this.meter = new Tone.Meter({ normalRange: true });
    // Dry + parallel wet: dry gain = max(0, 1 - reverb - delay).
    this.bus.connect(this.busDry);
    this.busDry.connect(this.master);
    this.bus.connect(this.masterReverb);
    this.masterReverb.connect(this.masterReverbWet);
    this.masterReverbWet.connect(this.master);
    this.bus.connect(this.masterDelay);
    this.masterDelay.connect(this.masterDelayWet);
    this.masterDelayWet.connect(this.master);
    const aux = await ensureLimitedAux();
    this.masterLp.connect(aux);
    this.masterLp.connect(this.meter);
    this.currentRoutingTarget = null;
    this.audioStartTone = Tone.now();
    this.started = true;
  }

  isStarted(): boolean {
    return this.started;
  }

  private currentRoutingTarget: Tone.InputNode | null | undefined = undefined;
  setRouting(target: Tone.InputNode | null): void {
    if (!this.started || !this.masterLp) return;
    if (this.currentRoutingTarget === target) return;
    this.masterLp.disconnect();
    if (target) {
      this.masterLp.connect(target);
      if (this.meter) this.masterLp.connect(this.meter);
      this.currentRoutingTarget = target;
      return;
    }
    this.currentRoutingTarget = null;
    const auxNow = limitedAuxIfStarted();
    if (auxNow) {
      this.masterLp.connect(auxNow);
      if (this.meter) this.masterLp.connect(this.meter);
      return;
    }
    void ensureLimitedAux().then((aux) => {
      if (this.currentRoutingTarget !== null || !this.masterLp) return;
      this.masterLp.disconnect();
      this.masterLp.connect(aux);
      if (this.meter) this.masterLp.connect(this.meter);
    });
  }

  private previewNodes: {
    source: Tone.ToneBufferSource;
    gain: Tone.Gain;
    panner: Tone.Panner;
  } | null = null;

  /** Peak level after engine EQ (0..1+). */
  getPeakLevel(): number {
    if (!this.meter) return 0;
    return meterAbs(this.meter.getValue());
  }

  async ensureSampleLoaded(sample: Sample): Promise<void> {
    await this.loadBuffer(sample.id);
  }

  /**
   * Audition a library track once through the limited bus, independent
   * of arrangement clips / Samples enable. Stops any prior preview.
   */
  async previewSample(sample: Sample): Promise<void> {
    if (!this.started) await this.start();
    const buf = await this.loadBuffer(sample.id);
    if (!buf) {
      console.warn("[samples] preview: missing buffer", sample.id);
      return;
    }
    this.stopPreview();
    const aux = await ensureLimitedAux();
    const { start, playSec } = sampleTrimRange(sample);
    if (playSec < MIN_REMAINING_BUF_SEC) {
      console.warn("[samples] preview: empty trim", sample.id);
      return;
    }
    const rate = Math.max(0.05, finite(sample.playbackRate, 1));
    const master = useSimStore.getState().samples.master;
    const gainLin =
      Math.max(0, finite(sample.gain, 0)) * Math.max(0, finite(master, 0));
    if (gainLin <= 0) return;
    const source = new Tone.ToneBufferSource({
      url: buf,
      playbackRate: rate,
      fadeIn: 0.008,
      fadeOut: 0.02,
    });
    const gain = new Tone.Gain(gainLin);
    const panner = new Tone.Panner(
      Math.max(-1, Math.min(1, sample.pan ?? 0)),
    );
    source.connect(gain);
    gain.connect(panner);
    panner.connect(aux);
    const now = Tone.now();
    try {
      source.start(now, start, playSec);
    } catch (err) {
      console.warn("[samples] preview start failed", err);
      source.dispose();
      gain.dispose();
      panner.dispose();
      return;
    }
    this.previewNodes = { source, gain, panner };
    const wallSec = playSec / rate + 0.05;
    source.onended = () => {
      if (this.previewNodes?.source === source) this.stopPreview();
    };
    // Safety dispose if onended never fires.
    setTimeout(() => {
      if (this.previewNodes?.source === source) this.stopPreview();
    }, (wallSec + 0.5) * 1000);
  }

  stopPreview(): void {
    const nodes = this.previewNodes;
    this.previewNodes = null;
    if (!nodes) return;
    const now = Tone.now();
    try {
      nodes.gain.gain.cancelScheduledValues(now);
      nodes.gain.gain.setValueAtTime(nodes.gain.gain.value, now);
      nodes.gain.gain.linearRampToValueAtTime(0, now + 0.015);
      nodes.source.stop(now + 0.02);
    } catch {
      /* already stopped */
    }
    setTimeout(() => {
      try {
        nodes.source.dispose();
        nodes.gain.dispose();
        nodes.panner.dispose();
      } catch {
        /* ignore */
      }
    }, 50);
  }

  /** Drop a cached decode so a rewritten blob is picked up next play. */
  invalidateBuffer(sampleId: string): void {
    this.buffers.delete(sampleId);
    this.loading.delete(sampleId);
    for (const [clipId, voice] of [...this.voices.entries()]) {
      if (voice.sampleId !== sampleId) continue;
      this.disposeVoice(voice);
      this.voices.delete(clipId);
    }
  }

  update(
    hour: number,
    cycleSeconds: number,
    p: SamplesParams,
    autoPlay: boolean,
  ): void {
    if (!this.started || !this.master || !this.bus) return;

    this.master.gain.rampTo(
      p.enabled ? Math.max(0, Math.min(3, finite(p.master, 0))) : 0,
      0.05,
    );
    applyFilterChain(this.masterHp, this.masterLp, p.filters);

    this.pitchCents = p.pitchCents;
    this.pitchLfoRateHz = p.pitchLfoRateHz;
    this.pitchLfoDepthCents = p.pitchLfoDepthCents;
    this.pitchLfoShape = p.pitchLfoShape;
    const masterMix = normalizedWetMixes(p.reverbMix, p.delayMix);
    if (this.busDry) {
      this.busDry.gain.rampTo(masterMix.dry, 0.08);
    }
    if (this.masterReverbWet) {
      this.masterReverbWet.gain.rampTo(masterMix.reverb, 0.08);
    }
    if (this.masterReverb) {
      (this.masterReverb.roomSize as unknown as Tone.Signal<"normalRange">).rampTo(
        Math.max(0, Math.min(0.99, finite(p.reverbDecay, 0.7))),
        0.1,
      );
    }
    if (this.masterDelayWet) {
      this.masterDelayWet.gain.rampTo(masterMix.delay, 0.08);
    }
    if (this.masterDelay) {
      this.masterDelay.delayTime.rampTo(
        Math.max(0, Math.min(2, finite(p.delayTimeSec, 0.25))),
        0.08,
      );
      this.masterDelay.feedback.rampTo(
        Math.max(0, Math.min(0.9, finite(p.delayFeedback, 0.3))),
        0.08,
      );
    }

    if (!p.enabled) {
      for (const v of this.voices.values()) this.disposeVoice(v);
      this.voices.clear();
      this.enterRolls.clear();
      this.prevHour = hour;
      return;
    }

    const active = clipsActiveAt(hour, p, cycleSeconds);
    const activeById = new Map(active.map((a) => [a.clipId, a]));
    const clipById = new Map(p.clips.map((c) => [c.id, c]));

    // Prefetch any sample buffers referenced by placed clips.
    for (const c of p.clips) {
      if (!this.buffers.has(c.sampleId) && !this.loading.has(c.sampleId)) {
        this.loadBuffer(c.sampleId).catch(() => undefined);
      }
    }

    const dh = this.prevHour < 0 ? 0 : hour - this.prevHour;
    // Real discontinuity only — stationary (dh === 0) is NOT a scrub.
    const scrubJump =
      this.prevHour >= 0 &&
      (dh < -1e-6 || dh > MAX_SMOOTH_STEP_HOURS);
    const hourMoved =
      this.prevHour >= 0 && Math.abs(hour - this.prevHour) > 1e-6;

    // Drop voices whose clips left the span or were deleted.
    for (const [clipId, v] of [...this.voices.entries()]) {
      if (!activeById.has(clipId) || !clipById.has(clipId)) {
        this.disposeVoice(v);
        this.voices.delete(clipId);
        this.enterRolls.delete(clipId);
      }
    }

    for (const clipId of [...this.enterRolls.keys()]) {
      if (!activeById.has(clipId)) this.enterRolls.delete(clipId);
    }

    for (const a of active) {
      let roll = this.enterRolls.get(a.clipId);
      if (!roll) {
        roll =
          a.triggerProbability >= 1 || Math.random() < a.triggerProbability
            ? "accepted"
            : "rejected";
        this.enterRolls.set(a.clipId, roll);
      }
      if (roll === "rejected") continue;

      const buf = this.buffers.get(a.sampleId);
      if (!buf) {
        this.loadBuffer(a.sampleId).catch(() => undefined);
        continue;
      }

      let voice = this.voices.get(a.clipId);
      if (!voice) {
        const created = this.createVoice(a, buf);
        if (!created) continue;
        voice = created;
        this.voices.set(a.clipId, voice);
        if (autoPlay) {
          this.startSegment(voice, a, buf, a.offsetSec);
        } else {
          voice.paused = true;
          voice.startOffsetSec = a.offsetSec;
        }
        this.applyPitch(voice);
        this.applyPositionGain(voice, a);
        continue;
      }

      this.applyLiveParams(voice, a);
      this.applyPitch(voice);

      if (!autoPlay) {
        if (hourMoved || scrubJump) {
          this.startSegment(voice, a, buf, a.offsetSec);
        } else if (!voice.paused) {
          this.pauseVoice(voice);
        }
        this.applyPositionGain(voice, a);
        continue;
      }

      // autoPlay: free-run at timeline rate. Seek only on real scrub/wrap
      // or if the player stopped early while still inside the span.
      const driftSec = Math.abs(
        this.estimatedOffsetSec(voice) - a.offsetSec,
      );
      if (voice.paused || scrubJump || driftSec > 0.08) {
        this.startSegment(voice, a, buf, a.offsetSec);
      } else if (
        voice.player.state !== "started" &&
        a.offsetSec < a.durationSec - MIN_REMAINING_BUF_SEC
      ) {
        this.startSegment(voice, a, buf, a.offsetSec);
      } else if (voice.player.state === "started") {
        const rate = Math.max(0.05, a.playbackRate);
        if (Math.abs(voice.player.playbackRate - rate) > 0.001) {
          voice.player.playbackRate = rate;
        }
      }
      this.applyPositionGain(voice, a);
    }

    this.prevHour = hour;
  }

  private applyPitch(voice: Voice): void {
    const cents = voice.randomCents + this.currentPitchCents();
    const target = Math.max(-24, Math.min(24, finite(cents / 100, 0)));
    // Tone.PitchShift is a granular/FFT processor and is not transparent at
    // pitch=0, especially on bells and other sharp tonal transients. Use its
    // unprocessed dry path unless the requested shift is actually audible.
    const shouldBeWet = Math.abs(target) >= 0.005;
    if (shouldBeWet !== voice.pitchShiftWet) {
      voice.pitchShift.wet.rampTo(shouldBeWet ? 1 : 0, 0.02);
      voice.pitchShiftWet = shouldBeWet;
    }
    const semitones = Number.isFinite(voice.lastPitchSemitones)
      ? voice.lastPitchSemitones + (target - voice.lastPitchSemitones) * 0.2
      : target;
    if (Math.abs(semitones - voice.lastPitchSemitones) < 0.002) return;
    try {
      voice.pitchShift.pitch = semitones;
      voice.lastPitchSemitones = semitones;
    } catch {
      /* ignore */
    }
  }

  private applyLiveParams(voice: Voice, a: ActiveClip): void {
    voice.panner.pan.rampTo(
      Math.max(-1, Math.min(1, finite(a.pan, 0))),
      0.05,
    );
    voice.filter.frequency.rampTo(
      Math.max(20, Math.min(20000, finite(a.filterHz, 20000))),
      0.05,
    );
    const mix = normalizedWetMixes(a.reverbMix, a.delayMix);
    voice.dryGain.gain.rampTo(mix.dry, 0.08);
    voice.reverbWet.gain.rampTo(mix.reverb, 0.08);
    voice.delayWet.gain.rampTo(mix.delay, 0.08);
    (voice.reverb.roomSize as unknown as Tone.Signal<"normalRange">).rampTo(
      Math.max(0, Math.min(0.99, finite(a.reverbDecay, 0.7))),
      0.1,
    );
    voice.delay.delayTime.rampTo(
      Math.max(0, Math.min(2, finite(a.delayTimeSec, 0.25))),
      0.08,
    );
    voice.delay.feedback.rampTo(
      Math.max(0, Math.min(0.95, finite(a.delayFeedback, 0.3))),
      0.08,
    );
  }

  /**
   * Envelope from buffer position so mid-clip seeks do not re-run a
   * full fade-in from silence. Only ramps when the target moved.
   */
  private applyPositionGain(voice: Voice, a: ActiveClip): void {
    const target = this.positionGainTarget(a);
    if (Math.abs(target - voice.lastGainTarget) < GAIN_EPS) return;
    voice.lastGainTarget = target;
    const now = Tone.now();
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(target, now + 0.02);
    } catch {
      /* ignore */
    }
  }

  private createVoice(
    a: ActiveClip,
    buffer: Tone.ToneAudioBuffer,
  ): Voice | null {
    if (!this.bus) return null;

    const randomCents =
      a.randomPitchCents > 0
        ? (Math.random() * 2 - 1) * a.randomPitchCents
        : 0;

    const player = new Tone.Player({
      autostart: false,
      loop: false,
      fadeIn: 0.008,
      fadeOut: 0.02,
    });
    player.buffer = buffer;
    player.playbackRate = Math.max(0.05, finite(a.playbackRate, 1));

    const pitchShift = new Tone.PitchShift({
      pitch: 0,
      windowSize: 0.1,
      feedback: 0,
      wet: 0,
    });
    const gain = new Tone.Gain(0);
    const filter = new Tone.Filter({
      type: "lowpass",
      frequency: Math.max(20, Math.min(20000, finite(a.filterHz, 20000))),
      Q: 0.7,
    });
    const panner = new Tone.Panner(
      Math.max(-1, Math.min(1, finite(a.pan, 0))),
    );
    const mix = normalizedWetMixes(a.reverbMix, a.delayMix);
    const dryGain = new Tone.Gain(mix.dry);
    const reverb = new Tone.Freeverb({
      roomSize: Math.max(0, Math.min(0.99, a.reverbDecay)),
      dampening: 3000,
    });
    const reverbWet = new Tone.Gain(mix.reverb);
    const delay = new Tone.FeedbackDelay({
      delayTime: Math.max(0, Math.min(2, a.delayTimeSec)),
      feedback: Math.max(0, Math.min(0.95, a.delayFeedback)),
      wet: 1,
    });
    const delayWet = new Tone.Gain(mix.delay);

    player.connect(pitchShift);
    pitchShift.connect(gain);
    gain.connect(filter);
    filter.connect(panner);
    panner.connect(dryGain);
    panner.connect(reverb);
    reverb.connect(reverbWet);
    panner.connect(delay);
    delay.connect(delayWet);
    dryGain.connect(this.bus);
    reverbWet.connect(this.bus);
    delayWet.connect(this.bus);

    return {
      clipId: a.clipId,
      sampleId: a.sampleId,
      player,
      pitchShift,
      gain,
      filter,
      panner,
      dryGain,
      reverb,
      reverbWet,
      delay,
      delayWet,
      randomCents,
      lastGainTarget: -1,
      startOffsetSec: a.offsetSec,
      startedAtTone: Tone.now(),
      paused: true,
      disposed: false,
      lastPitchSemitones: Number.NaN,
      pitchShiftWet: false,
    };
  }

  private startSegment(
    voice: Voice,
    a: ActiveClip,
    buffer: Tone.ToneAudioBuffer,
    offsetSec: number,
  ): void {
    const now = Tone.now();
    const rate = Math.max(0.05, finite(a.playbackRate, 1));
    const regionStart = Math.max(0, a.bufferStartSec);
    const regionEnd = Math.min(
      buffer.duration,
      regionStart + Math.max(0, a.durationSec),
    );
    const offset = Math.max(
      regionStart,
      Math.min(Math.max(regionStart, regionEnd - 1e-4), regionStart + offsetSec),
    );
    const remainingBuf = Math.max(0, regionEnd - offset);
    if (remainingBuf < MIN_REMAINING_BUF_SEC) {
      try {
        if (voice.player.state === "started") voice.player.stop(now);
      } catch {
        /* not started */
      }
      voice.paused = true;
      voice.startOffsetSec = offsetSec;
      return;
    }

    const fadeEnd = now + 0.008;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, fadeEnd);
      if (voice.player.state === "started") voice.player.stop(fadeEnd);
    } catch {
      /* not started */
    }

    if (voice.player.buffer !== buffer) {
      voice.player.buffer = buffer;
    }
    voice.player.playbackRate = rate;
    const startAt = now + 0.012;
    try {
      voice.player.start(startAt, offset, remainingBuf);
    } catch (err) {
      console.warn("[samples] player.start failed", err);
      return;
    }

    voice.startOffsetSec = offsetSec;
    voice.startedAtTone = startAt;
    voice.paused = false;
    const target = this.positionGainTarget(a);
    voice.gain.gain.setValueAtTime(0, startAt);
    voice.gain.gain.linearRampToValueAtTime(target, startAt + 0.015);
    voice.lastGainTarget = target;
  }

  private pauseVoice(voice: Voice): void {
    if (voice.paused) return;
    const now = Tone.now();
    const elapsed = Math.max(0, now - voice.startedAtTone);
    voice.startOffsetSec =
      voice.startOffsetSec + elapsed * voice.player.playbackRate;
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + 0.008);
      voice.player.stop(now + 0.01);
    } catch {
      /* already stopped */
    }
    voice.paused = true;
  }

  private disposeVoice(v: Voice): void {
    if (v.disposed) return;
    v.disposed = true;
    const now = Tone.now();
    try {
      v.gain.gain.cancelScheduledValues(now);
      v.gain.gain.setValueAtTime(v.gain.gain.value, now);
      v.gain.gain.linearRampToValueAtTime(0, now + 0.02);
      v.player.stop(now + 0.03);
    } catch {
      /* already stopped */
    }
    setTimeout(() => {
      v.player.dispose();
      v.pitchShift.dispose();
      v.gain.dispose();
      v.filter.dispose();
      v.panner.dispose();
      v.dryGain.dispose();
      v.reverb.dispose();
      v.reverbWet.dispose();
      v.delay.dispose();
      v.delayWet.dispose();
    }, 220);
  }

  private estimatedOffsetSec(voice: Voice): number {
    if (voice.paused) return voice.startOffsetSec;
    const elapsed = Math.max(0, Tone.now() - voice.startedAtTone);
    return voice.startOffsetSec + elapsed * voice.player.playbackRate;
  }

  private positionGainTarget(a: ActiveClip): number {
    const offset = a.offsetSec;
    const dur = Math.max(1e-4, a.durationSec);
    const fi = Math.max(0, a.fadeInSec);
    const fo = Math.max(0, a.fadeOutSec);
    let env = 1;
    if (fi > 0 && offset < fi) env = Math.min(env, offset / fi);
    if (fo > 0 && offset > dur - fo) {
      env = Math.min(env, Math.max(0, (dur - offset) / fo));
    }
    return Math.max(0, finite(a.gain, 0)) * env;
  }

  private async loadBuffer(
    sampleId: string,
  ): Promise<Tone.ToneAudioBuffer | null> {
    const cached = this.buffers.get(sampleId);
    if (cached) return cached;
    const pending = this.loading.get(sampleId);
    if (pending) return pending;
    const p = (async () => {
      const blob = await getSampleBlob(sampleId);
      if (!blob) return null;
      const arr = await blob.arrayBuffer();
      const ab = await Tone.getContext().rawContext.decodeAudioData(
        arr.slice(0),
      );
      const tab = new Tone.ToneAudioBuffer(ab);
      this.buffers.set(sampleId, tab);
      const store = useSimStore.getState();
      const meta = store.samples.library.find((s) => s.id === sampleId);
      if (meta && Math.abs(meta.durationSec - ab.duration) > 0.05) {
        const dur = ab.duration;
        store.setSamples({
          library: store.samples.library.map((s) => {
            if (s.id !== sampleId) return s;
            const start = Math.max(0, Math.min(dur, s.trimStartSec ?? 0));
            const end = Math.max(
              start,
              Math.min(dur, s.trimEndSec ?? dur),
            );
            return {
              ...s,
              durationSec: dur,
              trimStartSec: start,
              trimEndSec: end,
            };
          }),
        });
      }
      return tab;
    })();
    this.loading.set(sampleId, p);
    try {
      return await p;
    } finally {
      this.loading.delete(sampleId);
    }
  }
}

let singleton: SampleEngine | null = null;
export function getSampleEngine(): SampleEngine {
  if (!singleton) singleton = new SampleEngine();
  return singleton;
}
