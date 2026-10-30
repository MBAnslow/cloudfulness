import { create } from "zustand";
import { CUSTOM_SWATCH_ID, getSwatch } from "./lighting/swatches";
import { buildAtmosphericChannelStops } from "./lighting/atmospherePalette";
import {
  DEFAULT_LED_COLOR_PROFILE,
  resolveLedColorProfile,
  type LedColorProfile,
} from "./lighting/ledColor";
import { loadSnapshot, type Snapshot } from "./state/persistence";

export type Vec3 = [number, number, number];

export type LedViewMode =
  | "breathIntensity"
  | "timeOfDay"
  | "breathPlusTimeOfDay";

/**
 * How the per-LED points are visualized in the 3D scene:
 *   "sensors" — matte spheres that sample lighting at their surface
 *               position. Represents the sampling side of the rendering
 *               pipeline (what the app uses internally to decide colors).
 *   "leds"    — narrow oriented hemispheres with additive blending that
 *               emit their per-LED stream color. Represents what actually
 *               gets streamed to WLED.
 */
export type LedDisplayMode = "sensors" | "leds";
export type BreathTimeCombineMode = "revealOnInhale" | "linearMix";
export type AudioInstrument = "drone" | "pad" | "samples";
export type AudioSolo = AudioInstrument | null;
export type AudioMuted = Record<AudioInstrument, boolean>;

export interface LedStreamPipeline {
  /** Enables the base time-of-day lighting stage. */
  timeOfDayStage: boolean;
  /** Enables breath masking/compositing stages. */
  breathStage: boolean;
  /** Enables additive lightning contribution stage. */
  lightningStage: boolean;
  /** Enables locator hard override in streamed output. */
  locatorOverrideStage: boolean;
}

/**
 * Animatable lightning params — stored per keyframe and linearly
 * interpolated across the lightning active window (sky timeline).
 * Only these fields ride the storm envelope; geometry/look extras stay global.
 */
/** main, highlight1, highlight2 — sampled live from colour-stop timelines. */
export type LightningPalette = [string, string, string];

/**
 * A colour pin on a lightning colour/tint timeline. `t` is progress
 * through the lightning active window, [0, 1] (same axis as storm keys).
 */
export interface LightningColorStop {
  id: string;
  t: number;
  color: string;
}

/** Default bolt colour: main + two highlight channel timelines. */
export interface LightningColorTracks {
  main: LightningColorStop[];
  highlight1: LightningColorStop[];
  highlight2: LightningColorStop[];
}

function makeColorStopId(): string {
  return `lcs-${Math.random().toString(36).slice(2, 8)}`;
}

function channelStopsPair(
  colorA: string,
  colorB: string,
): LightningColorStop[] {
  return [
    { id: makeColorStopId(), t: 0, color: colorA },
    { id: makeColorStopId(), t: 1, color: colorB },
  ];
}

export function buildDefaultLightningColors(): LightningColorTracks {
  return {
    main: channelStopsPair("#cfe7ff", "#e8f4ff"),
    highlight1: channelStopsPair("#a8c8ff", "#c4d9ff"),
    highlight2: channelStopsPair("#fff2c9", "#fff6d6"),
  };
}

export interface LightningAnimParams {
  intensityRange: [number, number];
  /** Cloud-flash strikes per real (wall-clock) minute at this storm point. */
  strikesPerMinute: number;
  /**
   * Cloud-to-ground "strike" bolts per real minute. These start at the
   * cloud top, hit the ground, and flood-light the whole cloud.
   */
  strikePerMinute: number;
  /**
   * Transient image “sprites” projected through the cloud per real minute.
   * Each trigger picks a random uploaded image and a random ±X/Y/Z axis.
   */
  spritesPerMinute: number;
  /** Per-sprite strobe duty range sampled at spawn, [0.05, 0.95]. */
  spriteStrobeDutyRange: [number, number];
  /**
   * Per-segment branch probability in [0, 1]. At each interior main-bolt
   * vertex, a weaker side branch spawns with this chance (1 = every segment).
   */
  subFlashes: number;
  /** Max bolt endpoint span as a fraction of cloud size, [0, 1]. */
  spanScale: number;
  /** Min bolt length as a fraction of mean cloud radius. */
  minSpanScale: number;
  boltGain: number;
  /** Additive gain for projected sprite image flashes. */
  spriteGain: number;
  backgroundGain: number;
  thunderDelayMs: number;
  /** Stereo pan for bolt/background audio, −1 = left … +1 = right. */
  pan: number;
}

export interface LightningKeyframe {
  id: string;
  /**
   * Normalized progress through the lightning active window, [0, 1].
   * Sampled from the current sky timeline position.
   */
  t: number;
  values: LightningAnimParams;
}

export interface LightningParams {
  enabled: boolean;
  /**
   * Default bolt colour timelines (main + 2 highlights). Interpolate
   * across the storm window like sky sun/moon pins.
   */
  colors: LightningColorTracks;
  /**
   * Per-strike additive gain range. Mirrored in keyframes; live flashes
   * interpolate the range and map a frozen per-strike random through it.
   */
  intensityRange: [number, number];
  /**
   * Keyframes over the lightning active window (sky timeline progress).
   * Current sky time maps to u∈[0,1] within Start→End hour; values are
   * linearly interpolated. ≥2 stops.
   */
  keyframes: LightningKeyframe[];
  /** Average cloud-flash strikes per real (wall-clock) minute. Also keyframed. */
  strikesPerMinute: number;
  /**
   * Average cloud-to-ground strikes per real minute. Also keyframed.
   * Separate from in-cloud flashes.
   */
  strikePerMinute: number;
  /**
   * Average projected sprite flashes per real minute. Also keyframed.
   * Requires at least one uploaded `spriteSamples` image.
   */
  spritesPerMinute: number;
  /**
   * Characteristic distance (m) over which an LED's contribution from a
   * lit segment drops by 1/e. Continuous exponential falloff — every
   * LED receives some light, larger values = more diffuse glow through
   * the cloud. Global (not keyframed).
   */
  falloffDistance: number;
  /** Number of samples in a bolt polyline (jaggedness). */
  boltSegments: number;
  /** Per-strike lateral randomness range, [0,1]. Sampled per strike. */
  boltJitterRange: [number, number];
  /**
   * Per-strike bolt tip travel speed range, in world metres per second.
   * The flash duration is derived from `path_length / speed * 4` so
   * longer bolts and slower speeds automatically produce longer flashes.
   * The `* 4` factor preserves the historical ~25% travel / ~75% fade
   * envelope split.
   */
  travelSpeedRange: [number, number];
  /**
   * Per-segment branch probability in [0, 1]. Mirrored in keyframes;
   * live strikes sample the interpolated value at spawn.
   */
  subFlashes: number;
  /** Max portion of the ellipsoid extents the bolt endpoints span, [0,1]. */
  spanScale: number;
  /**
   * Minimum bolt length as a fraction of the mean ellipsoid radius.
   * If randomly sampled endpoints fall closer than this, we resample
   * so bolts don't degenerate into a tiny spark.
   */
  minSpanScale: number;
  /** Hour in [0, 24) at which lightning activity switches on. */
  activeStartHour: number;
  /** Hour in [0, 24) at which lightning activity switches off. */
  activeEndHour: number;
  /**
   * Uploaded cloud-flash sound library. One is chosen (by intensity /
   * length tags) per in-cloud bolt (`strikesPerMinute` / kind "cloud").
   */
  boltSamples: LightningSample[];
  /**
   * Single one-shot for cloud-to-ground strikes (`strikePerMinute` /
   * kind "strike"). Null = silent for ground strikes.
   */
  strikeSample: LightningSample | null;
  /** Optional looping background ambience (rain, thunder rumble, …). */
  backgroundSample: LightningSample | null;
  /** Randomly selected one-shot audio library for storm sprite flashes. */
  spriteAudioSamples: LightningSample[];
  /**
   * Uploaded sprite image library. Each sprite trigger picks one at
   * random and projects it through the cloud along a random ±X/Y/Z axis.
   */
  spriteSamples: LightningSpriteSample[];
  /**
   * How long a sprite flash lasts (ms), including on/off strobe pulses.
   * Global (not keyframed).
   */
  spriteDurationMs: number;
  /** Strobe flash rate in Hz while a sprite is active. */
  spriteStrobeHz: number;
  /** Fraction of each strobe period the image is “on”, [0.05, 0.95]. */
  spriteStrobeDuty: number;
  /**
   * Base playback gain for bolt sounds. The actual per-trigger gain
   * is scaled by the strike's sampled intensity so louder flashes get
   * louder bolts and gentler flashes fade toward this floor.
   */
  boltGain: number;
  /** Additive LED gain for projected sprites. Also keyframed. */
  spriteGain: number;
  /** Playback gain for the sprite sound effect, independent of brightness. */
  spriteAudioGain: number;
  /** Modulate sprite brightness from the source audio waveform. */
  spriteAudioReactiveBrightness: boolean;
  /** Playback gain for the background loop, [0, 1]. */
  backgroundGain: number;
  /**
   * ± range in cents for a random pitch shift applied to each bolt
   * trigger (uniform in [-range, +range]). 0 = deterministic.
   */
  boltPitchJitterCents: number;
  /**
   * Delay in milliseconds between the visual bolt spawning and the
   * bolt sample being triggered. Mimics thunder arriving after the
   * flash (sound travels ~340 m/s vs. instantaneous light). 0 = fire
   * simultaneously. Clamped to [0, 2000] on load.
   */
  thunderDelayMs: number;
  /**
   * Stereo pan for bolt and background audio (−1 left … +1 right).
   * Also keyframed across the active window.
   */
  pan: number;
  /**
   * Target simulation FPS for lightning updates + LED contribution.
   * Lower values create a stroboscopic, film-like flicker by
   * refreshing bolt state less often than the render loop.
   * Range 1..60.
   */
  simFps: number;
}

/**
 * Metadata for a lightning audio asset. The binary blob lives in
 * IndexedDB (shared with the samples panel storage) keyed by `id`;
 * only these lightweight fields make it into the localStorage
 * snapshot. `durationSec` is optional (background loop doesn't need
 * it) and populated at upload time when known.
 */
export type BoltIntensityTag = "low" | "medium" | "high";
export type BoltLengthTag = "short" | "medium" | "long";

export const BOLT_INTENSITY_TAGS: BoltIntensityTag[] = [
  "low",
  "medium",
  "high",
];
export const BOLT_LENGTH_TAGS: BoltLengthTag[] = ["short", "medium", "long"];

/** Metadata for a storm sprite image (blob in IndexedDB by `id`). */
export interface LightningSpriteSample {
  id: string;
  name: string;
  width?: number;
  height?: number;
}

export interface LightningSample {
  id: string;
  name: string;
  durationSec?: number;
  /** Per-asset playback trim. Defaults to 1 for legacy samples. */
  gain?: number;
  /**
   * Manual intensity bands this clip suits. Empty = untagged (matches
   * any intensity as a fallback). Tick one or more in the lightning UI.
   */
  intensityTags: BoltIntensityTag[];
  /**
   * Manual flash-length bands this clip suits. Empty = untagged
   * (matches any length as a fallback).
   */
  lengthTags: BoltLengthTag[];
}

/**
 * Persistent per-LED breath filter (TOD gate memory). Separate from the
 * breath wave params and from the participant rim tint.
 */
export interface BreathFilterKeyframe {
  id: string;
  /**
   * Normalized progress through the breath active window, [0, 1]
   * (same axis as breath `activeStartHour` → `activeEndHour`).
   */
  t: number;
  /** Filter threshold floor at this storm point, [0, 1]. */
  threshold: number;
}

export interface BreathFilterParams {
  enabled: boolean;
  /**
   * Floor for the filter and default TOD activation [0,1]. Decay never
   * goes below this; at 1 every LED shows full time-of-day. Mirrored
   * from the selected keyframe; live value is sampled from keyframes.
   */
  threshold: number;
  /**
   * Threshold envelope over the breath active window (≥2 stops).
   * Current sky time maps to u∈[0,1] within breath Start→End hour.
   */
  keyframes: BreathFilterKeyframe[];
  /**
   * After the breath wave leaves an LED, how long (seconds) the slowest
   * (low-noise) LEDs keep their latched reveal before clearing. Higher
   * cooldown noise only clears sooner. Range 0.1–30.
   */
  decayMaxSeconds: number;
  /** Spatial frequency of the cooldown noise field. */
  cooldownScale: number;
  /**
   * Cooldown noise extents: low ≈ flat mid values, high ≈ more fBm
   * octaves and full [0,1] blotches. Each LED’s relative decay speed
   * is this noise value.
   */
  cooldownContrast: number;
  /** Seed for the procedural cooldown field; regenerate to reshuffle. */
  seed: number;
  /**
   * Debug: paint each LED with its cooldown noise value (0=black linger,
   * 1=white snap) instead of the normal shading.
   */
  showNoise: boolean;
}

/** Ellipsoid semi-axes in metres. */
export interface EllipsoidParams {
  rx: number;
  ry: number;
  rz: number;
}

export interface CloudParams {
  /**
   * Cloud opacity, in [0, 1]:
   *   0 — fully transparent; the cloud blocks no light, every LED gets the
   *       same hemispherical irradiance regardless of which side it's on.
   *   1 — fully opaque; LEDs on the far side of the cloud relative to a
   *       light source receive nothing (the original half-Lambert response).
   * Values in between fade smoothly between the two extremes.
   */
  opacity: number;
  /**
   * Whether the ellipsoid mesh is rendered in the 3D view. The LED shading
   * always uses `opacity` regardless of this flag — toggling it just hides
   * or shows the visual representation of the cloud body.
   */
  showOpacity: boolean;
  /** Rotation of the cloud around world up axis, in degrees. */
  rotationYDeg: number;
  /** Tilt of the cloud around world X axis, in degrees. */
  rotationXDeg: number;
  /** World-space X offset of the cloud center, in metres. */
  offsetX: number;
  /** World-space Y offset of the cloud center, in metres. Positive
   * values lift the whole cloud (mesh + LEDs) up off the ground. */
  offsetY: number;
  /** World-space Z offset of the cloud center, in metres. */
  offsetZ: number;
  /**
   * When true, per-LED mapping offsets (along surface normals) are applied
   * in the simulator. When false, LEDs sit on their hand-placed surface
   * positions only.
   */
  applyLedOffset: boolean;
}

/** A second, visual-only GLB that diffuses the live LED output. */
export interface CloudTopParams {
  /** IndexedDB blob id, or null when no cloud-top model is loaded. */
  id: string | null;
  /** Display name of the uploaded model. */
  name: string;
  visible: boolean;
  /** Transform relative to the global cloud transform. */
  scale: number;
  yawDeg: number;
  tiltDeg: number;
  offsetX: number;
  offsetY: number;
  offsetZ: number;
  /** Surface appearance. */
  tint: string;
  /** Strength and local-space spread of LED light transported by the model. */
  glowStrength: number;
  glowRadius: number;
  /** Cosine-lobe exponent for outward emission; higher values narrow the beam. */
  glowFocus: number;
}

export interface StrandParams {
  /** Bead size for each rendered LED, in metres. */
  ledSize: number;
  /**
   * Hemisphere averaging focus for sensor sampling.
   * 0 = uniform hemisphere average; higher values bias samples toward the
   * sensor normal (head-on light contributes more than grazing light).
   */
  sensorHemisphereFocus: number;
  /** Hue-preserving brightness gamma applied to final LED output. */
  colorProfile: LedColorProfile;
}

export interface AmbientLightParams {
  color: string;
  intensity: number;
  /** Suppress ambient/sky fill where direct light is strong. */
  ducking: number;
}

export interface DirectionalLightParams {
  color: string;
  intensity: number;
  /** World-space position of the directional light source (metres). */
  position: Vec3;
  /**
   * Angular spread of the light in [0, 1]:
   *   0 — perfectly narrow / point-source / "laser": only the half of the
   *       cloud facing the light is illuminated, with a hard terminator at
   *       the equator (flat Lambert `max(0, n · ℓ)` regardless of cloud
   *       opacity).
   *   1 — fully broad / hemispherical "sky": light wraps around the LED's
   *       outward hemisphere, side LEDs get partial illumination, and
   *       cloud opacity controls how much of that wrap reaches the back.
   * Values in between blend linearly. With `spread = 1` the shading model
   * is identical to the previous behavior, so this parameter cleanly
   * extends the old one without changing existing presets.
   */
  spread: number;
}

/** Which sky channel a stop belongs to. */
export type SkyChannel = "sun" | "moon" | "ambient" | "rim";

/**
 * A single stop on one sky channel's timeline. Pins a single color
 * (only for its channel) at a specific hour. Each channel has its own
 * independent list of stops, so you can shape sun, moon, and ambient
 * colors on completely different schedules.
 *
 * `swatchId` references either a named preset in `SKY_SWATCHES` or the
 * sentinel value `"custom"`. It's UI-only metadata used to display the
 * swatch name and to detect when a user has hand-edited a stop away
 * from its preset. The actual color on the stop is the source of
 * truth for the shading model.
 */
export interface SkyChannelStop {
  id: string;
  /** Time of day in decimal hours, in [0, 24). */
  timeHours: number;
  /** Preset id from `SKY_SWATCHES`, or "custom". */
  swatchId: string;
  color: string;
  /**
   * Optional brightness at this hour, independent of the colour.
   * Missing on older stops: sun and moon keep the altitude envelope,
   * and ambient keeps its altitude floor.
   */
  intensity?: number;
}

export interface SkyParams {
  /** Enables the sun/moon 24-hour sky sequence. */
  enabled: boolean;
  /** Master amount of the time-of-day visualization effect. */
  visualizationAmount: number;
  /** Advances `timeHours` automatically every frame. */
  autoPlay: boolean;
  /** Time of day in decimal hours [0, 24). */
  timeHours: number;
  /** How many real-time seconds one full 24h sky cycle takes. */
  cycleSeconds: number;
  /**
   * While true, `setSky` ignores `cycleSeconds` so arrangements synced to
   * the cycle can't be knocked out by a stray edit or preset load. Only
   * `setCycleLocked` changes it.
   */
  cycleLocked: boolean;
  /** Global intensity scale for the sky ambient component. */
  ambientScale: number;
  /** Global intensity scale for sun contribution. */
  sunScale: number;
  /** Global intensity scale for moon contribution. */
  moonScale: number;
  /** Angular spread of sun light (0 = tight hotspot, 1 = broad sky-like). */
  sunSpread: number;
  /** Angular spread of moon light (0 = tight hotspot, 1 = broad sky-like). */
  moonSpread: number;
  /** Radial sun beam falloff (0 = flat cone, 1 = centre-weighted). */
  sunBeamFocus: number;
  /** Exaggerate illumination on the cloud crown while the sun is low. */
  sunTopHighlightBoost: number;
  /** Radial moon beam falloff (0 = flat cone, 1 = centre-weighted). */
  moonBeamFocus: number;
  /** Point-light distance falloff exponent shared by sun and moon. */
  lightDecay: number;
  /** Show visual cone overlays for sun/moon spread. */
  showSpreadCones: boolean;
  /** Legacy spherical orbit radius (metres), retained for compatibility. */
  orbitRadius: number;
  /** Ellipsoidal orbit radii for simulated sun/moon point lights (metres). */
  orbitRadiusX: number;
  orbitRadiusY: number;
  orbitRadiusZ: number;
  /** Legacy shared horizon controls retained for snapshot compatibility. */
  horizonCutoffDeg?: number;
  horizonSoftnessDeg?: number;
  /** Sun altitude where its contribution begins and reaches full strength. */
  sunHorizonStartDeg: number;
  sunHorizonFullDeg: number;
  /** Moon altitude where its contribution begins and reaches full strength. */
  moonHorizonStartDeg: number;
  moonHorizonFullDeg: number;
  /**
   * Draggable timeline of sun-color stops across the 24-hour day. The
   * sky cycle sorts stops by `timeHours` internally and interpolates
   * linearly between neighbours (wrapping midnight → next stop + 24h).
   */
  sunStops: SkyChannelStop[];
  /** Draggable moon-color timeline (independent from sun and ambient). */
  moonStops: SkyChannelStop[];
  /** Draggable ambient-color timeline (independent from sun and moon). */
  ambientStops: SkyChannelStop[];
  /**
   * Grazing-edge colour across the day. Ignored while `rimEnabled` is false,
   * which is the default so older configs keep their previous look.
   */
  rimStops: SkyChannelStop[];
  /** Optional rim on sun- or moon-facing edges. Off until configured. */
  rimEnabled: boolean;
  /** Scales the rim stop intensity. */
  rimScale: number;
  /** How far onto the lit face the grazing band reaches. 0 is a hairline. */
  rimWidth: number;
  /**
   * Darkens ambient fill on downward and occluded LEDs. 0 keeps the
   * previous uniform fill.
   */
  ambientOcclusion: number;
  /** Fraction of ambient fill kept in the darkest fold. 0 can go fully dark. */
  ambientShadowFloor: number;
}

/** Legacy single-list stop, kept only for one-shot snapshot migration. */
interface LegacyTriStop {
  id: string;
  timeHours: number;
  swatchId: string;
  ambientColor: string;
  sunColor: string;
  moonColor: string;
}

export type DroneWaveform = "sine" | "triangle" | "sawtooth" | "square";

/**
 * A single note placed on the 24h piano roll. Voiced continuously
 * while `startHour <= sky.timeHours < endHour`. Notes are named
 * (e.g. "C3", "F#4") for direct Tone.js frequency lookup and can
 * overlap freely (each is an independent voice, keyed by id).
 *
 * Times are clamped to `[0, 24)` and `startHour < endHour`. No wrap
 * across midnight — draw two notes if you want that.
 */
export interface DroneNote {
  id: string;
  note: string;
  /** Note-on time in decimal hours, in [0, 24). */
  startHour: number;
  /** Note-off time in decimal hours, in (0, 24]. */
  endHour: number;
  /**
   * Per-note gain multiplier, [0, 1]. Applied on top of `masterGain`
   * and the ADSR envelope. Optional for backward-compat with older
   * saved snapshots — resolves to 1 when missing.
   */
  gain?: number;
  /** Per-note pitch offset in cents. Defaults to 0. */
  detuneCents?: number;
  /** Number of stacked oscillators for this note (unison). 1..8. */
  unisonCount?: number;
  /** Symmetric detune spread across the unison stack, in cents. */
  unisonDetuneCents?: number;
  /**
   * Peak per-oscillator pitch drift in cents. Each unison osc gets its
   * own slow LFO wandering its detune by ±this amount; 0 disables drift.
   */
  unisonDriftCents?: number;
  /** Drift LFO base rate, Hz. Each osc jitters slightly around this. */
  unisonDriftRateHz?: number;
  // --- Per-note effects. All optional; unset means "transparent"
  // (no tremolo, filter fully open, no wobble) so old notes keep
  // working. These stack on top of the master effects in the chain:
  //   osc -> perNoteFilter -> env -> perNoteTremolo
  //       -> bus -> masterFilter -> masterTremolo -> distortion -> reverb
  /** Per-note tremolo rate in Hz. */
  tremoloRateHz?: number;
  /** Per-note tremolo depth, [0, 1]. */
  tremoloDepth?: number;
  tremoloShape?: DroneLfoShape;
  /** Per-note filter cutoff in Hz. */
  filterHz?: number;
  filterQ?: number;
  filterLfoRateHz?: number;
  filterLfoDepth?: number;
  filterLfoShape?: DroneLfoShape;
  /**
   * Layer voices around the fundamental:
   *   octave layers: -2, -1, 0, +1, +2, +3
   *   extension layers: ext1, ext2, ext3 (user-choosable semitone offsets)
   * Each voice is an independent sine oscillator with level, tremolo and
   * drift controls. Undefined = fully silent layers.
   *
   * Backward compatibility: a plain `number[]` is still accepted and mapped
   * to levels with default interval offsets.
   */
  harmonics?: (HarmonicVoice | number | undefined)[];
}

export const HARMONIC_OCTAVE_OFFSETS = [-12, 0, 12, 24, 36] as const;
export const HARMONIC_EXTENSION_DEFAULTS = [4, 7, 10] as const;
export const HARMONIC_COUNT =
  HARMONIC_OCTAVE_OFFSETS.length + HARMONIC_EXTENSION_DEFAULTS.length;

export function harmonicLayerDefaultSemitones(index: number): number {
  if (index < HARMONIC_OCTAVE_OFFSETS.length) return HARMONIC_OCTAVE_OFFSETS[index];
  const ext = index - HARMONIC_OCTAVE_OFFSETS.length;
  return HARMONIC_EXTENSION_DEFAULTS[ext] ?? 0;
}

/**
 * Per-harmonic modulated oscillator. `level` is the direct gain
 * multiplier feeding the summing bus. `tremDepth` amplitude-modulates
 * the harmonic at `tremRateHz`; `driftDepth` frequency-modulates it
 * (in cents) at `driftRateHz`. All defaults are 0 so an untouched
 * harmonic is silent and transparent.
 */
export interface HarmonicVoice {
  level: number;
  /** Pitch offset from base note in semitones. */
  intervalSemitones: number;
  tremRateHz: number;
  tremDepth: number;
  driftCents: number;
  driftRateHz: number;
  /**
   * Overtone amount in [0, 1]. 0 = pure sine, 1 = sawtooth-like bright
   * spectrum built from a decaying partials series. Adds harmonic
   * content to break sine-vs-sine beating and give the layer body.
   */
  overtones: number;
}

export const HARMONIC_VOICE_DEFAULTS: HarmonicVoice = {
  level: 0,
  intervalSemitones: 0,
  tremRateHz: 4,
  tremDepth: 0,
  driftCents: 0,
  driftRateHz: 0.3,
  overtones: 0,
};

/**
 * Fully-resolved per-note effect params. `undefined` fields on a
 * `DroneNote` fall through to defaults that make the per-voice fx
 * chain transparent.
 */
export interface NoteFx {
  gain: number;
  detuneCents: number;
  unisonCount: number;
  unisonDetuneCents: number;
  unisonDriftCents: number;
  unisonDriftRateHz: number;
  tremoloRateHz: number;
  tremoloDepth: number;
  tremoloShape: DroneLfoShape;
  filterHz: number;
  filterQ: number;
  filterLfoRateHz: number;
  filterLfoDepth: number;
  filterLfoShape: DroneLfoShape;
  /** Fully-resolved per-partial voices, length == HARMONIC_COUNT. */
  harmonics: HarmonicVoice[];
}

export const NOTE_FX_DEFAULTS: NoteFx = {
  gain: 0,
  detuneCents: 0,
  unisonCount: 1,
  unisonDetuneCents: 0,
  unisonDriftCents: 0,
  unisonDriftRateHz: 0.3,
  tremoloRateHz: 4,
  tremoloDepth: 0,
  tremoloShape: "sine",
  // 20 kHz cutoff is above the audible band, so the biquad is
  // effectively bypassed until the user dials it down.
  filterHz: 20000,
  filterQ: 0.7,
  filterLfoRateHz: 2,
  filterLfoDepth: 0,
  filterLfoShape: "sine",
  harmonics: Array.from({ length: HARMONIC_COUNT }, (_, i) => ({
    ...HARMONIC_VOICE_DEFAULTS,
    intervalSemitones: harmonicLayerDefaultSemitones(i),
  })),
};

function clampInt(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clamp01(n: number | undefined): number {
  if (n === undefined || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function resolveHarmonicVoice(
  index: number,
  h: HarmonicVoice | number | undefined,
): HarmonicVoice {
  const base = harmonicLayerDefaultSemitones(index);
  if (h === undefined) return { ...HARMONIC_VOICE_DEFAULTS, intervalSemitones: base };
  if (typeof h === "number") {
    // Backward compat with the older scalar-level schema.
    return {
      ...HARMONIC_VOICE_DEFAULTS,
      level: clamp01(h),
      intervalSemitones: base,
    };
  }
  return {
    level: clamp01(h.level),
    intervalSemitones: clampInt(
      h.intervalSemitones ?? base,
      -36,
      36,
    ),
    tremRateHz: h.tremRateHz ?? HARMONIC_VOICE_DEFAULTS.tremRateHz,
    tremDepth: clamp01(h.tremDepth),
    driftCents: h.driftCents ?? HARMONIC_VOICE_DEFAULTS.driftCents,
    driftRateHz: h.driftRateHz ?? HARMONIC_VOICE_DEFAULTS.driftRateHz,
    overtones: clamp01(h.overtones),
  };
}

function resolveHarmonics(
  h: (HarmonicVoice | number | undefined)[] | undefined,
): HarmonicVoice[] {
  const out: HarmonicVoice[] = [];
  for (let i = 0; i < HARMONIC_COUNT; i++) {
    out.push(resolveHarmonicVoice(i, h?.[i]));
  }
  return out;
}

export function resolveNoteFx(note: DroneNote): NoteFx {
  return {
    gain: note.gain ?? NOTE_FX_DEFAULTS.gain,
    detuneCents: note.detuneCents ?? NOTE_FX_DEFAULTS.detuneCents,
    unisonCount: clampInt(
      note.unisonCount ?? NOTE_FX_DEFAULTS.unisonCount,
      1,
      8,
    ),
    unisonDetuneCents:
      note.unisonDetuneCents ?? NOTE_FX_DEFAULTS.unisonDetuneCents,
    unisonDriftCents:
      note.unisonDriftCents ?? NOTE_FX_DEFAULTS.unisonDriftCents,
    unisonDriftRateHz:
      note.unisonDriftRateHz ?? NOTE_FX_DEFAULTS.unisonDriftRateHz,
    harmonics: resolveHarmonics(note.harmonics),
    tremoloRateHz: note.tremoloRateHz ?? NOTE_FX_DEFAULTS.tremoloRateHz,
    tremoloDepth: note.tremoloDepth ?? NOTE_FX_DEFAULTS.tremoloDepth,
    tremoloShape: note.tremoloShape ?? NOTE_FX_DEFAULTS.tremoloShape,
    filterHz: note.filterHz ?? NOTE_FX_DEFAULTS.filterHz,
    filterQ: note.filterQ ?? NOTE_FX_DEFAULTS.filterQ,
    filterLfoRateHz: note.filterLfoRateHz ?? NOTE_FX_DEFAULTS.filterLfoRateHz,
    filterLfoDepth: note.filterLfoDepth ?? NOTE_FX_DEFAULTS.filterLfoDepth,
    filterLfoShape: note.filterLfoShape ?? NOTE_FX_DEFAULTS.filterLfoShape,
  };
}

export type DroneLfoShape = "sine" | "triangle" | "square" | "sawtooth";

/** One-pole biquad configuration reused by per-engine HPF/LPF slots. */
export interface FilterParams {
  enabled: boolean;
  hz: number;
  q: number;
}
export interface FilterChain {
  lp: FilterParams;
  hp: FilterParams;
}

export const DEFAULT_FILTER_CHAIN: FilterChain = {
  lp: { enabled: false, hz: 12000, q: 0.7 },
  hp: { enabled: false, hz: 60, q: 0.7 },
};

function resolveFilterChain(input: unknown): FilterChain {
  const d = DEFAULT_FILTER_CHAIN;
  const src = (input && typeof input === "object" ? input : {}) as Partial<FilterChain>;
  const one = (
    slot: Partial<FilterParams> | undefined,
    def: FilterParams,
  ): FilterParams => ({
    enabled: typeof slot?.enabled === "boolean" ? slot.enabled : def.enabled,
    hz:
      typeof slot?.hz === "number"
        ? Math.max(10, Math.min(22000, slot.hz))
        : def.hz,
    q:
      typeof slot?.q === "number"
        ? Math.max(0.1, Math.min(20, slot.q))
        : def.q,
  });
  return { lp: one(src.lp, d.lp), hp: one(src.hp, d.hp) };
}

export interface DroneParams {
  enabled: boolean;
  /** Master output gain, [0, 1]. */
  masterGain: number;
  waveform: DroneWaveform;
  /** Attack time, seconds (0.001–5). */
  attack: number;
  /** Decay time, seconds (0.001–5). */
  decay: number;
  /** Sustain level, [0, 1]. */
  sustain: number;
  /** Release time, seconds (0.001–8). */
  release: number;
  /** Amplitude LFO ("tremolo") rate, Hz. */
  tremoloRateHz: number;
  /** Tremolo depth, [0, 1]. 0 = off, 1 = full modulation to silence. */
  tremoloDepth: number;
  tremoloShape: DroneLfoShape;
  /** Master saturation amount, [0, 1]. 0 = clean, 1 = fully saturated. */
  saturation: number;
  /** Post-FX: distortion (single soft-clip waveshaper). */
  distortionEnabled: boolean;
  /** Distortion drive amount, [0, 1]. */
  distortionDrive: number;
  /** Distortion wet mix, [0, 1]. */
  distortionMix: number;
  /** Per-engine HPF+LPF chain applied on the master before output. */
  filters: FilterChain;
  notes: DroneNote[];
}

/**
 * A single warm-pad note placed on its own 24h piano roll. Deliberately
 * leaner than `DroneNote`: pads use a single global synth patch so no
 * per-note tremolo/filter/harmonics/unison are exposed.
 */
export interface PadNote {
  id: string;
  note: string;
  /** Note-on time in decimal hours, in [0, 24). */
  startHour: number;
  /** Note-off time in decimal hours, in (0, 24]. */
  endHour: number;
  /** Per-note gain multiplier, [0, 1]. Optional; defaults to 1. */
  gain?: number;
  /** Per-note pitch offset in cents. Defaults to 0. */
  detuneCents?: number;
  /**
   * Probability the note will actually fire when the playhead enters
   * its window. The roll happens once per entry; if it fails the note
   * stays silent for that whole pass and re-rolls on the next entry.
   * Undefined = 1 (always fire).
   */
  triggerProbability?: number;
}

export type PadWaveform = "sine" | "sawtooth" | "square" | "triangle";
/** Selectable sound generator. Bellows engines run in an AudioWorklet. */
export type PadEngineType = "tone" | "bellows-analog" | "bellows-motion";
export type PadFilterSlope = 12 | 24;
export type PadDelaySync = "off" | "1/4" | "1/8" | "1/8d" | "1/8t" | "1/16";
export const PAD_DELAY_SYNCS: PadDelaySync[] = ["off", "1/4", "1/8", "1/8d", "1/8t", "1/16"];

/** Three-band master EQ on the pad output. Not keyframed. */
export interface PadEq {
  enabled: boolean;
  /** Low shelf corner, Hz. */
  lowHz: number;
  lowDb: number;
  /** Peaking band centre, Hz. */
  midHz: number;
  midDb: number;
  midQ: number;
  /** High shelf corner, Hz. */
  highHz: number;
  highDb: number;
}

export const DEFAULT_PAD_EQ: PadEq = {
  enabled: true,
  lowHz: 120,
  lowDb: 0,
  midHz: 800,
  midDb: 0,
  midQ: 1,
  highHz: 8000,
  highDb: 0,
};

function resolvePadEq(input: unknown): PadEq {
  const src = (input && typeof input === "object" ? input : {}) as Partial<PadEq>;
  const num = (v: unknown, def: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : def;
  const d = DEFAULT_PAD_EQ;
  return {
    enabled: typeof src.enabled === "boolean" ? src.enabled : d.enabled,
    lowHz: num(src.lowHz, d.lowHz, 20, 1000),
    lowDb: num(src.lowDb, d.lowDb, -18, 18),
    midHz: num(src.midHz, d.midHz, 100, 10000),
    midDb: num(src.midDb, d.midDb, -18, 18),
    midQ: num(src.midQ, d.midQ, 0.2, 10),
    highHz: num(src.highHz, d.highHz, 1000, 18000),
    highDb: num(src.highDb, d.highDb, -18, 18),
  };
}

/**
 * Warm-pad synth patch. One instance per track — the pad engine is
 * intentionally simpler than the drone engine: unison-detuned voices,
 * ADSR, low-pass with env amount, chorus for width, reverb for space.
 */
export interface PadParams {
  enabled: boolean;
  /** Sound generator; shared timing, notes, and master controls stay unchanged. */
  engine: PadEngineType;
  /** Master output gain, [0, 1]. */
  master: number;
  waveform: PadWaveform;
  /** Number of stacked unison oscillators per voice, 1..8. */
  unisonCount: number;
  /** Symmetric detune spread across the unison stack, cents. */
  unisonDetuneCents: number;
  /** Stereo pan spread across the unison stack, [0, 1]. */
  stereoWidth: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  /** Base cutoff of the low-pass, Hz (20–20000). */
  filterHz: number;
  filterQ: number;
  /**
   * Filter envelope amount in cents (0..5000). ADSR opens the cutoff
   * up by this many cents above `filterHz` at note-on, tracking sustain.
   */
  filterEnvAmount: number;
  /** Chorus LFO rate, Hz. */
  chorusRateHz: number;
  /** Chorus wet mix, [0, 1]. */
  chorusDepth: number;
  /**
   * Per-oscillator pitch-drift LFO rate, Hz. Each unison osc gets its
   * own randomised phase so drift feels organic rather than in lock-step.
   */
  driftRateHz: number;
  /** Peak drift depth, cents. 0 disables. */
  driftDepthCents: number;
  /** Filter cutoff LFO rate, Hz. */
  filterLfoRateHz: number;
  /**
   * Filter cutoff LFO depth, [0, 1]. 1 sweeps the cutoff down by a
   * full octave from the base at the LFO's trough; 0 disables.
   */
  filterLfoDepth: number;
  /** Low-pass slope, dB/octave. 24 is a darker, more analog-style pad. */
  filterSlope: PadFilterSlope;
  /** Cutoff follows pitch: 0 = fixed, 1 = cutoff scales 1:1 with note frequency. */
  filterKeyTrack: number;
  /** Second oscillator layer level, [0, 1]. 0 disables. */
  osc2Level: number;
  osc2Waveform: PadWaveform;
  /** Second oscillator interval above/below the note, semitones (-24..24). */
  osc2Semitones: number;
  /** Per-voice filtered noise "air" level, [0, 1]. */
  noiseLevel: number;
  /** Noise band centre, Hz. */
  noiseToneHz: number;
  /** Per-note random tuning / cutoff / level variation, [0, 1]. */
  humanize: number;
  /** Delay time source: free seconds, or a note division of `tempoBpm`. */
  delaySync: PadDelaySync;
  tempoBpm: number;
  /** Per-voice mono sine sub oscillator level, [0, 1]. 0 disables. */
  subLevel: number;
  /** Sub oscillator octave below the note: -1 or -2. */
  subOctave: number;
  /** Side-channel high-pass on the bus; content below this is mono, Hz. */
  monoBelowHz: number;
  /** Bus glue compression amount, [0, 1]. 0 = bypass-equivalent. */
  glue: number;
  /** Waveshaper drive, [0, 1]. 0 = clean. */
  saturation: number;
  /** Parallel reverb return level, [0, 1]. */
  reverbMix: number;
  /** Freeverb room size, [0, 0.99]. */
  reverbRoomSize: number;
  /** Reverb high-frequency damping cutoff, Hz. */
  reverbDampingHz: number;
  /** Delay before the reverb tank, seconds. */
  reverbPreDelaySec: number;
  /** Parallel stereo delay return level, [0, 1]. */
  delayMix: number;
  /** Delay time, seconds. */
  delayTimeSec: number;
  /** Delay feedback, [0, 0.9]. */
  delayFeedback: number;
  /** Per-engine HPF+LPF chain applied on the master before output. */
  filters: FilterChain;
  /** Master tone-shaping EQ. */
  eq: PadEq;
  /** Independent per-parameter automation points across the 24-hour day. */
  keyframes: PadKeyframe[];
  notes: PadNote[];
}

export const PAD_KEYFRAME_PARAMS = [
  "master",
  "unisonDetuneCents",
  "stereoWidth",
  "driftRateHz",
  "driftDepthCents",
  "attack",
  "decay",
  "sustain",
  "release",
  "filterHz",
  "filterQ",
  "filterEnvAmount",
  "filterLfoRateHz",
  "filterLfoDepth",
  "filterKeyTrack",
  "osc2Level",
  "noiseLevel",
  "noiseToneHz",
  "humanize",
  "subLevel",
  "monoBelowHz",
  "glue",
  "saturation",
  "chorusRateHz",
  "chorusDepth",
  "reverbMix",
  "reverbRoomSize",
  "reverbDampingHz",
  "reverbPreDelaySec",
  "delayMix",
  "delayTimeSec",
  "delayFeedback",
] as const;

export type PadKeyframeParam = (typeof PAD_KEYFRAME_PARAMS)[number];

export interface PadKeyframe {
  id: string;
  /** Position on the circular day timeline, [0, 24). */
  hour: number;
  /** The one synth parameter controlled by this point. */
  param: PadKeyframeParam;
  value: number;
}

/** Day-timeline automation params on a sample library track. */
export type SampleAutoParam =
  | "gain"
  | "pan"
  | "filterHz"
  | "reverbMix"
  | "delayMix";

export const SAMPLE_AUTO_PARAMS: SampleAutoParam[] = [
  "gain",
  "pan",
  "filterHz",
  "reverbMix",
  "delayMix",
];

/** One breakpoint on the 24h sky timeline for a track automation lane. */
export interface SampleAutoPoint {
  id: string;
  /** Sky hour, [0, 24). */
  hour: number;
  value: number;
}

/**
 * Uploaded audio-sample metadata + per-track playback settings.
 * The actual binary blob lives in IndexedDB keyed by `id`; only these
 * lightweight fields go into the localStorage snapshot.
 *
 * All placements of this sample on the arrangement share these params.
 * Re-uploading the same file creates a new library entry (new track)
 * with its own independent settings.
 */
export interface Sample {
  id: string;
  name: string;
  /** Duration of the decoded buffer in seconds (full file). */
  durationSec: number;
  /**
   * Inclusive play region start within the buffer, seconds.
   * Clips use `[trimStartSec, trimEndSec)` as the audible length.
   */
  trimStartSec: number;
  /** Exclusive play region end within the buffer, seconds. */
  trimEndSec: number;
  /** Linear gain multiplier, [0, 1]. */
  gain: number;
  /** Stereo pan, [-1, 1]. */
  pan: number;
  /**
   * Per-voice lowpass cutoff (Hz). 20 kHz ≈ open. Overridden by
   * `automation.filterHz` when that lane has points.
   */
  filterHz: number;
  /** Playback rate (>0). 1 = normal, 2 = double speed / octave up. */
  playbackRate: number;
  /** Fade-in duration in seconds (applied near buffer start). */
  fadeInSec: number;
  /** Fade-out duration in seconds (applied near buffer end). */
  fadeOutSec: number;
  /**
   * On each span enter, pick a random detune in [-randomPitchCents,
   * +randomPitchCents] and hold it for the visit. 0 disables.
   */
  randomPitchCents: number;
  /** Per-track reverb wet mix, [0, 1]. */
  reverbMix: number;
  /** Freeverb roomSize, [0, 1]. */
  reverbDecay: number;
  /** Delay time in seconds (0..2). */
  delayTimeSec: number;
  /** Delay feedback amount [0, 0.95). */
  delayFeedback: number;
  /** Delay wet mix, [0, 1]. */
  delayMix: number;
  /**
   * Probability each placement sounds when the playhead enters its span.
   * Rolled once per visit. 1 = always play.
   */
  triggerProbability: number;
  /**
   * Optional day-timeline automation curves. Empty / missing lane →
   * use the matching static knob (`gain`, `pan`, …).
   */
  automation: Partial<Record<SampleAutoParam, SampleAutoPoint[]>>;
}

/** Defaults for a newly uploaded library track (trim end set at upload). */
export const DEFAULT_SAMPLE_TRACK = {
  trimStartSec: 0,
  gain: 1,
  pan: 0,
  filterHz: 20000,
  playbackRate: 1,
  fadeInSec: 0.01,
  fadeOutSec: 0.05,
  randomPitchCents: 0,
  reverbMix: 0,
  reverbDecay: 0.7,
  delayTimeSec: 0.25,
  delayFeedback: 0.3,
  delayMix: 0,
  triggerProbability: 1,
  automation: {},
} as const satisfies Omit<Sample, "id" | "name" | "durationSec" | "trimEndSec">;

/** Clamped trim window and playable length for a library sample. */
export function sampleTrimRange(sample: Sample): {
  start: number;
  end: number;
  playSec: number;
} {
  const dur = Math.max(0, sample.durationSec);
  const start = Math.max(
    0,
    Math.min(dur, Number.isFinite(sample.trimStartSec) ? sample.trimStartSec : 0),
  );
  const endRaw = Number.isFinite(sample.trimEndSec)
    ? sample.trimEndSec
    : dur;
  const end = Math.max(start, Math.min(dur, endRaw));
  return { start, end, playSec: Math.max(0, end - start) };
}

export function samplePlayDurationSec(sample: Sample): number {
  return sampleTrimRange(sample).playSec;
}

function resolveSampleAutomation(
  raw: unknown,
): Partial<Record<SampleAutoParam, SampleAutoPoint[]>> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: Partial<Record<SampleAutoParam, SampleAutoPoint[]>> = {};
  for (const param of SAMPLE_AUTO_PARAMS) {
    const arr = src[param];
    if (!Array.isArray(arr)) continue;
    const points: SampleAutoPoint[] = [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const o = item as Record<string, unknown>;
      const hour = typeof o.hour === "number" && Number.isFinite(o.hour) ? o.hour : NaN;
      const value =
        typeof o.value === "number" && Number.isFinite(o.value) ? o.value : NaN;
      if (!(hour >= 0) || !(value === value)) continue;
      const id =
        typeof o.id === "string" && o.id
          ? o.id
          : `auto-${param}-${points.length}-${Math.round(hour * 1000)}`;
      points.push({
        id,
        hour: ((hour % 24) + 24) % 24,
        value: clampSampleAutoValue(param, value),
      });
    }
    if (points.length > 0) out[param] = points;
  }
  return out;
}

export function clampSampleAutoValue(
  param: SampleAutoParam,
  value: number,
): number {
  switch (param) {
    case "gain":
    case "reverbMix":
    case "delayMix":
      return Math.max(0, Math.min(1, value));
    case "pan":
      return Math.max(-1, Math.min(1, value));
    case "filterHz":
      return Math.max(20, Math.min(20000, value));
  }
}

function resolveSampleTrackFields(
  raw: Record<string, unknown> | undefined,
  fallback?: Record<string, unknown>,
  durationSec = 0,
): Omit<Sample, "id" | "name" | "durationSec"> {
  const g = (key: string, def: number): number => {
    const v = raw?.[key] ?? fallback?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : def;
  };
  const dur = Math.max(0, durationSec);
  const trimStartSec = Math.max(
    0,
    Math.min(dur, g("trimStartSec", DEFAULT_SAMPLE_TRACK.trimStartSec)),
  );
  const trimEndSec = Math.max(
    trimStartSec,
    Math.min(dur, g("trimEndSec", dur)),
  );
  const automationRaw = raw?.automation ?? fallback?.automation;
  return {
    trimStartSec,
    trimEndSec,
    gain: Math.max(0, Math.min(1, g("gain", DEFAULT_SAMPLE_TRACK.gain))),
    pan: Math.max(-1, Math.min(1, g("pan", DEFAULT_SAMPLE_TRACK.pan))),
    filterHz: Math.max(
      20,
      Math.min(20000, g("filterHz", DEFAULT_SAMPLE_TRACK.filterHz)),
    ),
    playbackRate: Math.max(
      0.05,
      Math.min(8, g("playbackRate", DEFAULT_SAMPLE_TRACK.playbackRate)),
    ),
    fadeInSec: Math.max(0, g("fadeInSec", DEFAULT_SAMPLE_TRACK.fadeInSec)),
    fadeOutSec: Math.max(0, g("fadeOutSec", DEFAULT_SAMPLE_TRACK.fadeOutSec)),
    randomPitchCents: Math.max(
      0,
      Math.min(1200, g("randomPitchCents", DEFAULT_SAMPLE_TRACK.randomPitchCents)),
    ),
    reverbMix: Math.max(
      0,
      Math.min(1, g("reverbMix", DEFAULT_SAMPLE_TRACK.reverbMix)),
    ),
    reverbDecay: Math.max(
      0,
      Math.min(1, g("reverbDecay", DEFAULT_SAMPLE_TRACK.reverbDecay)),
    ),
    delayTimeSec: Math.max(
      0,
      Math.min(2, g("delayTimeSec", DEFAULT_SAMPLE_TRACK.delayTimeSec)),
    ),
    delayFeedback: Math.max(
      0,
      Math.min(0.95, g("delayFeedback", DEFAULT_SAMPLE_TRACK.delayFeedback)),
    ),
    delayMix: Math.max(
      0,
      Math.min(1, g("delayMix", DEFAULT_SAMPLE_TRACK.delayMix)),
    ),
    triggerProbability: Math.max(
      0,
      Math.min(
        1,
        g("triggerProbability", DEFAULT_SAMPLE_TRACK.triggerProbability),
      ),
    ),
    automation: resolveSampleAutomation(automationRaw),
  };
}

/**
 * A single placed sample clip on the 24h arrangement timeline. Sound
 * parameters live on the parent `Sample` (track); the clip only stores
 * where it starts. Width is derived:
 *   widthHours = (samplePlayDurationSec(sample) / sample.playbackRate) * (24 / cycleSeconds)
 */
export interface SampleClip {
  id: string;
  sampleId: string;
  /** Span start in decimal hours, [0, 24). */
  startHour: number;
}

/**
 * Samples track params. `library` is the uploaded audio set (metadata
 * only); `clips` is the arrangement placed on top of it. One horizontal
 * lane per library entry in the UI.
 */
export interface SamplesParams {
  enabled: boolean;
  /** Master gain for the samples bus, [0, 3]. */
  master: number;
  /** Global pitch offset in cents applied to every trigger. */
  pitchCents: number;
  /** Rate (Hz) of the master pitch LFO. */
  pitchLfoRateHz: number;
  /** Depth (cents) of the master pitch LFO around `pitchCents`. */
  pitchLfoDepthCents: number;
  /** Waveform shape for the master pitch LFO. */
  pitchLfoShape: DroneLfoShape;
  /** Master reverb wet mix, [0, 1] (send from all clips). */
  reverbMix: number;
  /** Master reverb roomSize, [0, 0.99]. */
  reverbDecay: number;
  /** Master delay wet mix, [0, 1]. */
  delayMix: number;
  /** Master delay time (s), [0, 2]. */
  delayTimeSec: number;
  /** Master delay feedback, [0, 0.9]. */
  delayFeedback: number;
  /** Per-engine HPF+LPF chain applied on the master before output. */
  filters: FilterChain;
  library: Sample[];
  clips: SampleClip[];
}

/**
 * A named contiguous slice of the 24h day. `endHour < startHour`
 * means the period wraps midnight (e.g. Night = 20 → 0).
 * Two adjacent periods share an edge — the "next" period always
 * begins where the previous one ends.
 */
export interface DayPeriod {
  id: string;
  name: string;
  startHour: number;
  endHour: number;
  /** Display swatch on the day-cycle bar and scrubber overlay. */
  color: string;
}

export interface DayCycleParams {
  periods: DayPeriod[];
  activePeriodId: string;
  /**
   * When true and `sky.autoPlay` is on, the clock advances into the
   * next period at the end of the current one instead of looping
   * inside it. Off = classic behaviour (loop within period until the
   * user clicks Next).
   */
  autoNext: boolean;
}

/**
 * Shared master frequency processing applied downstream of each
 * instrument's own master gain. A single HPF + LPF is shared by all
 * engines that opt in via the corresponding `applyTo*` flag; opted-out
 * engines route around the EQ to a direct destination path.
 */
export interface MasterFxParams {
  /** Low-pass filter enabled. */
  lpEnabled: boolean;
  /** Low-pass cutoff, Hz (20–20000). */
  lpHz: number;
  /** Low-pass Q, 0.1–12. */
  lpQ: number;
  /** High-pass filter enabled. */
  hpEnabled: boolean;
  /** High-pass cutoff, Hz (20–20000). */
  hpHz: number;
  /** High-pass Q, 0.1–12. */
  hpQ: number;
  /** Route drone through the shared EQ chain. */
  applyToDrone: boolean;
  /** Route pad through the shared EQ chain. */
  applyToPad: boolean;
  /** Route samples through the shared EQ chain. */
  applyToSamples: boolean;
  /** Program output gain after the three engines sum, [0, 1.5]. */
  outputGain: number;
}

/** Length of a period in decimal hours, handling wrap-around. */
export function periodLengthHours(p: DayPeriod): number {
  return p.endHour >= p.startHour
    ? p.endHour - p.startHour
    : 24 - p.startHour + p.endHour;
}

/**
 * Whether the given hour is inside `[startHour, endHour)` on a cyclic
 * 24h axis (handling `end < start` wrap).
 */
export function periodContainsHour(p: DayPeriod, hour: number): boolean {
  const n = ((hour % 24) + 24) % 24;
  return p.endHour >= p.startHour
    ? n >= p.startHour && n < p.endHour
    : n >= p.startHour || n < p.endHour;
}

/**
 * True when `hour` sits inside `[startHour, endHour)` on the cyclic
 * 24h axis. When `endHour < startHour` the range wraps midnight
 * (e.g. 20 → 4 covers 20..24 and 0..4).
 */
export function hourInRange(
  hour: number,
  startHour: number,
  endHour: number,
): boolean {
  const n = ((hour % 24) + 24) % 24;
  const start = Math.max(0, Math.min(24, startHour));
  const end = Math.max(0, Math.min(24, endHour));
  if (end === start) return false;
  return end > start
    ? n >= start && n < end
    : n >= start || n < end;
}

/**
 * Progress through an active hour window as `u ∈ [0, 1]`.
 * Maps the current sky hour onto a keyframe timeline.
 * Returns 0 when outside the window.
 */
export function activeWindowProgress(
  hour: number,
  startHour: number,
  endHour: number,
): number {
  if (!hourInRange(hour, startHour, endHour)) return 0;
  const n = ((hour % 24) + 24) % 24;
  const start = ((startHour % 24) + 24) % 24;
  // Allow endHour === 24 to mean end-of-day (exclusive midnight).
  const end =
    endHour >= 24 ? 24 : ((endHour % 24) + 24) % 24;
  let elapsed: number;
  let duration: number;
  if (end > start) {
    elapsed = n - start;
    duration = end - start;
  } else if (end === 24 && start === 0) {
    elapsed = n;
    duration = 24;
  } else {
    duration = 24 - start + end;
    elapsed = n >= start ? n - start : 24 - start + n;
  }
  if (duration <= 1e-9) return 0;
  return Math.max(0, Math.min(1, elapsed / duration));
}

/** True when breath is enabled and the sky clock is inside its active window. */
export function isBreathActive(
  breath: Pick<BreathParams, "enabled" | "activeStartHour" | "activeEndHour">,
  skyHour: number,
): boolean {
  return (
    breath.enabled &&
    hourInRange(skyHour, breath.activeStartHour, breath.activeEndHour)
  );
}

/** Length of `[startHour, endHour)` on the cyclic 24h axis. */
export function activeWindowDurationHours(
  startHour: number,
  endHour: number,
): number {
  const start = ((startHour % 24) + 24) % 24;
  const end = ((endHour % 24) + 24) % 24;
  if (end === start) return 0;
  return end > start ? end - start : 24 - start + end;
}

function linearHourSpans(
  startHour: number,
  endHour: number,
): Array<[number, number]> {
  const start = ((startHour % 24) + 24) % 24;
  const end = ((endHour % 24) + 24) % 24;
  if (end === start) return [];
  if (end > start) return [[start, end]];
  return [
    [start, 24],
    [0, end],
  ];
}

/**
 * Hours elapsed from `startHour` to `hour` along the active window
 * (supports `hour === 24` as end-of-day for exclusive span ends).
 */
function offsetHoursFromWindowStart(hour: number, startHour: number): number {
  const start = ((startHour % 24) + 24) % 24;
  const h = hour >= 24 ? 24 : ((hour % 24) + 24) % 24;
  if (h >= start) return h - start;
  return 24 - start + h;
}

export interface PeriodWindowSpan {
  periodId: string;
  name: string;
  color: string;
  /** Inclusive start on the keyframe axis. */
  u0: number;
  /** Exclusive end on the keyframe axis. */
  u1: number;
}

/**
 * Day-cycle periods that overlap the lightning active window, as
 * contiguous spans on the keyframe timeline `u ∈ [0, 1]`.
 */
export function periodsCrossingActiveWindow(
  periods: DayPeriod[],
  startHour: number,
  endHour: number,
): PeriodWindowSpan[] {
  const duration = activeWindowDurationHours(startHour, endHour);
  if (duration <= 1e-9) return [];
  const windowSpans = linearHourSpans(startHour, endHour);
  const out: PeriodWindowSpan[] = [];
  for (const p of periods) {
    const periodSpans = linearHourSpans(p.startHour, p.endHour);
    for (const [wa, wb] of windowSpans) {
      for (const [pa, pb] of periodSpans) {
        const lo = Math.max(wa, pa);
        const hi = Math.min(wb, pb);
        if (hi - lo <= 1e-6) continue;
        const u0 = offsetHoursFromWindowStart(lo, startHour) / duration;
        const u1 = offsetHoursFromWindowStart(hi, startHour) / duration;
        if (u1 - u0 <= 1e-6) continue;
        out.push({
          periodId: p.id,
          name: p.name,
          color: p.color,
          u0: Math.max(0, Math.min(1, u0)),
          u1: Math.max(0, Math.min(1, u1)),
        });
      }
    }
  }
  out.sort((a, b) => a.u0 - b.u0 || a.u1 - b.u1);
  return out;
}

export interface WledParams {
  host: string;
  fps: number;
  enabled: boolean;
}

/** Max simultaneous horizon participants. */
export const MAX_BREATH_PARTICIPANTS = 4;

/**
 * A person standing on the horizon around the cloud. Each runs their
 * own inhale/exhale cycle (simulated via `phaseOffset` for now; later
 * a live breath signal can replace the oscillator).
 */
export interface BreathParticipant {
  id: string;
  color: string;
  enabled: boolean;
  /** Horizon angle around the cloud center, degrees. */
  azimuthDeg: number;
  /**
   * Normalized phase shift in cycles, [0, 1). Simulated offset only —
   * ignored once a live breath signal is wired in.
   */
  phaseOffset: number;
  /**
   * Stable seed for this participant's cloud-fixed fog field. Shared
   * fog params (scale/amount/contrast/edge) apply to all participants;
   * only the seed differs so each person gets a unique volume look.
   */
  fogSeed: number;
}

/** New random fog-field seed for a participant. */
export function makeBreathFogSeed(): number {
  return (Math.random() * 0x7fffffff) | 0;
}

/** Deterministic seed from an id (migration when fogSeed is missing). */
export function fogSeedFromId(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** @deprecated Prefer BreathParticipant. Kept for snapshot migration. */
export type Breather = BreathParticipant;

export type BreathEffectMode = "travellingWave" | "localInflation";

export interface BreathParams {
  enabled: boolean;
  /**
   * When true, the shared breath clock freezes so the oscillator,
   * travelling waves, and LED mask hold their current state — useful
   * for inspecting the spatial visualization.
   */
  paused: boolean;
  /**
   * Spatial breath rendering:
   * - travellingWave: the original exhale volume crosses the cloud
   * - localInflation: an inhale-driven volume grows at each participant's
   *   nearest point on the cloud
   */
  effectMode: BreathEffectMode;
  /**
   * Mutually exclusive breath source:
   * - `internal` — simulated per-participant oscillator
   * - `osc` — TouchDesigner `/breathN/breath_binary`; -1 inhales, +1 exhales
   */
  triggerSource: "internal" | "osc";
  /** Duration of inhale ramp (seconds). */
  inhaleSeconds: number;
  /** Duration of hold at the inhalation peak (seconds). */
  holdPeakSeconds: number;
  /** Duration of exhale ramp (seconds). */
  exhaleSeconds: number;
  /** Duration of hold at the exhalation trough (seconds). */
  holdTroughSeconds: number;
  /** Shared vertical offset from the horizon plane (metres). +up / −down. */
  horizonDistance: number;
  /** Shared radial distance from cloud center to participants (metres). */
  cloudDistance: number;
  /** Lateral half-extent of the travelling breath volume (metres). */
  waveWidth: number;
  /** Vertical half-extent of the travelling breath volume (metres). */
  waveHeight: number;
  /**
   * Half-extent along the travel axis (metres) — toward/away from the
   * participant.
   */
  waveDepth: number;
  /** Wave travel speed toward/through the cloud (m/s). */
  waveSpeed: number;
  /** Maximum radius of a participant-attached local inhale volume (metres). */
  localInflationRadius: number;
  /** Peak local inhale mask multiplier, [0, 1]. */
  localInflationStrength: number;
  /**
   * Shapes radius growth from lung fullness. >1 delays expansion;
   * <1 expands earlier in the inhale.
   */
  localInflationGrowthExponent: number;
  /** Falloff exponent for the LED mask (>1 concentrates, <1 broadens). */
  falloffExponent: number;
  /**
   * Spatial frequency of volumetric fog noise (higher = finer blobs).
   * Sampled in metres from the cloud center (fixed fog volume); the
   * travelling spheroid only gates / envelopes that field.
   */
  noiseScale: number;
  /** 0 = smooth envelope only, 1 = fully noise-shaped density. */
  noiseAmount: number;
  /** Sharpens dense vs empty fog regions (>1 = higher contrast). */
  noiseContrast: number;
  /**
   * How strongly the cloud-fixed fog scallops the spheroid, from the
   * surface deep into the volume [0,2].
   */
  edgeNoise: number;
  /**
   * Thickness of the participant-colour rim shell around the wave
   * sphere surface (metres).
   */
  rimThickness: number;
  /** How strongly the rim tints LEDs toward the participant colour [0,1]. */
  rimAmount: number;
  /**
   * Angular width of the rim arc in degrees [0,360]. Midpoint faces
   * away from the participant (far side of the wave). 360 = full shell.
   */
  rimArcDegrees: number;
  /** Blend in combined mode: 0 = time of day, 1 = breath. */
  breathVsTimeMix: number;
  /**
   * Hour in [0, 24] at which breath waves / mask / audio mod switch on.
   * Pairs with {@link activeEndHour}; wraps midnight when end < start.
   * Use end = 24 for "through end of day" with start = 0 (always on).
   */
  activeStartHour: number;
  /**
   * Hour in [0, 24] at which breath activity switches off.
   * Same wrap rules as lightning's active window.
   */
  activeEndHour: number;
  /**
   * One-shot played at each breath-out (wave spawn), with random
   * PitchShift in ±{@link exhalePitchJitterCents}. Null = silent.
   */
  exhaleSample: LightningSample | null;
  /** Playback gain for the exhale one-shot. */
  exhaleGain: number;
  /** Random pitch jitter (±cents) applied per exhale trigger. */
  exhalePitchJitterCents: number;
  /** Up to {@link MAX_BREATH_PARTICIPANTS} people on the horizon. */
  participants: BreathParticipant[];
}

type BreathPatch = Partial<BreathParams>;

export interface SimState {
  ellipsoid: EllipsoidParams;
  cloud: CloudParams;
  cloudTop: CloudTopParams;
  strand: StrandParams;
  ambient: AmbientLightParams;
  directional: DirectionalLightParams;
  sky: SkyParams;
  wled: WledParams;
  breath: BreathParams;
  lightning: LightningParams;
  breathFilter: BreathFilterParams;
  drone: DroneParams;
  pad: PadParams;
  samples: SamplesParams;
  dayCycle: DayCycleParams;
  masterFx: MasterFxParams;
  /**
   * Per-parameter breath-modulation amount, signed in [-1, 1]. Keyed by
   * a stable slider ID (e.g. "drone.masterGain"). Positive = base value
   * moves up on exhale, negative = moves down; magnitude is the fraction
   * of the slider's range applied at full exhale. UI-only for now.
   */
  breathMod: Record<string, number>;
  /** When true, `breathMod` values are applied every frame to the running engines. */
  breathModEnabled: boolean;
  /**
   * Upper bound on mean LED reveal for breath-mod audio. Raw reveal is
   * divided by this and clamped to [0,1], so values below 1 let audio
   * fully saturate without requiring every LED to be fully revealed.
   */
  breathModRevealCeiling: number;
  ledViewMode: LedViewMode;
  ledDisplayMode: LedDisplayMode;
  breathTimeCombineMode: BreathTimeCombineMode;
  ledStreamPipeline: LedStreamPipeline;
  ledLocator: LedLocatorState;
  mapping: MappingParams;
  mesh: MeshTargetParams;
  ui: UiParams;
  /** Transient mixer solo; intentionally not persisted. */
  audioSolo: AudioSolo;
  audioMuted: AudioMuted;
  setEllipsoid: (e: Partial<EllipsoidParams>) => void;
  setCloud: (c: Partial<CloudParams>) => void;
  setCloudTop: (c: Partial<CloudTopParams>) => void;
  setStrand: (s: Partial<StrandParams>) => void;
  setAmbient: (a: Partial<AmbientLightParams>) => void;
  setDirectional: (d: Partial<DirectionalLightParams>) => void;
  setSky: (sk: Partial<SkyParams>) => void;
  setCycleLocked: (locked: boolean) => void;
  setWled: (w: Partial<WledParams>) => void;
  setBreath: (b: BreathPatch) => void;
  setLightning: (l: Partial<LightningParams>) => void;
  setBreathFilter: (b: Partial<BreathFilterParams>) => void;
  setDrone: (d: Partial<DroneParams>) => void;
  addDroneNote: (note: DroneNote) => void;
  updateDroneNote: (id: string, patch: Partial<DroneNote>) => void;
  removeDroneNote: (id: string) => void;
  clearDroneNotes: () => void;
  setPad: (p: Partial<PadParams>) => void;
  addPadNote: (note: PadNote) => void;
  updatePadNote: (id: string, patch: Partial<PadNote>) => void;
  removePadNote: (id: string) => void;
  clearPadNotes: () => void;
  setSamples: (p: Partial<SamplesParams>) => void;
  addSample: (sample: Sample) => void;
  removeSample: (id: string) => void;
  updateSample: (id: string, patch: Partial<Sample>) => void;
  addSampleClip: (clip: SampleClip) => void;
  updateSampleClip: (id: string, patch: Partial<SampleClip>) => void;
  removeSampleClip: (id: string) => void;
  clearSampleClips: () => void;
  setDayCycle: (patch: Partial<DayCycleParams>) => void;
  setMasterFx: (patch: Partial<MasterFxParams>) => void;
  setBreathMod: (key: string, value: number) => void;
  setBreathModEnabled: (v: boolean) => void;
  setBreathModRevealCeiling: (v: number) => void;
  updateDayPeriod: (id: string, patch: Partial<DayPeriod>) => void;
  setActivePeriod: (id: string) => void;
  advancePeriod: () => void;
  previousPeriod: () => void;
  setLedViewMode: (mode: LedViewMode) => void;
  setLedDisplayMode: (mode: LedDisplayMode) => void;
  setBreathTimeCombineMode: (mode: BreathTimeCombineMode) => void;
  setLedStreamPipeline: (patch: Partial<LedStreamPipeline>) => void;
  setLedLocator: (patch: Partial<LedLocatorState>) => void;
  toggleLocatedLed: (index: number) => void;
  clearLocatedLeds: () => void;
  setMapping: (m: Partial<MappingParams>) => void;
  setMesh: (m: Partial<MeshTargetParams>) => void;
  setUi: (u: Partial<UiParams>) => void;
  setAudioSolo: (solo: AudioSolo) => void;
  setAudioMuted: (instrument: AudioInstrument, muted: boolean) => void;
  addMappedLed: (dir: Vec3, pos?: Vec3, normal?: Vec3) => void;
  moveMappedLed: (index: number, dir: Vec3, pos?: Vec3, normal?: Vec3) => void;
  updateMappedLed: (index: number, patch: Partial<MappedLed>) => void;
  removeLastMappedLed: () => void;
  clearMappedLeds: () => void;
  addMappingGaussian: (g: Omit<MappingGaussian, "id"> & { id?: string }) => void;
  updateMappingGaussian: (id: string, patch: Partial<MappingGaussian>) => void;
  removeMappingGaussian: (id: string) => void;
  /** Zero all per-LED offsets and remove every Gaussian bump. */
  clearMappingBumps: () => void;
}

export interface LedLocatorState {
  enabled: boolean;
  highlighted: number[];
  color: string;
}

/**
 * A single manually-placed LED in the mapping app. Its location is stored
 * as a unit-sphere direction so it stays glued to the ellipsoid surface
 * when the cloud dimensions change: the surface point is simply
 * `(rx, ry, rz) * dir`.
 */
export interface MappedLed {
  /**
   * Unit-sphere direction used in ellipsoid mode. In mesh mode a `dir` is
   * still stored (the normalised `pos` from origin) so the flip/orientation
   * helpers continue to work uniformly, but bead placement uses `pos`.
   */
  dir: Vec3;
  /** Mesh-local surface point on the uploaded mesh (mesh mode only). */
  pos?: Vec3;
  /** Outward-pointing surface normal at `pos` (mesh mode only). */
  normal?: Vec3;
  /**
   * Metres along the outward normal from the hand-placed surface point.
   * Does not mutate `pos`; applied at display / sim time. Default 0.
   */
  offset?: number;
}

/**
 * Persisted UI toggles for the floating panels on the simulator page.
 * Kept in the store (rather than component-local `useState`) so they
 * round-trip through the snapshot save/load like every other choice.
 */
export interface UiParams {
  showMaster: boolean;
  showBreath: boolean;
  showLightning: boolean;
  showBreathFilter: boolean;
  showTimeOfDay: boolean;
  showCloud: boolean;
  showStream: boolean;
}

export type MappingMode = "ellipsoid" | "mesh";

/** Active tool in the mapping app. */
export type MappingTool = "place" | "offset" | "gaussian";

/**
 * A compact smooth dome on the mesh surface. Legacy names are retained so
 * existing configuration files continue to load unchanged. It lifts nearby
 * LEDs and tilts normals from the dome slope.
 */
export interface MappingGaussian {
  id: string;
  /** Mesh-local surface point at the bump centre. */
  pos: Vec3;
  /** Outward surface normal at the centre (mesh-local). */
  normal: Vec3;
  /** Peak lift along the normal (metres). */
  amplitude: number;
  /** Tangential half-width of the elliptical falloff (metres). */
  width: number;
  /** Tangential half-height of the elliptical falloff (metres). */
  height: number;
  /** Rotation of the ellipse around the surface normal (degrees). */
  rotationDeg: number;
}

export interface MeshTargetParams {
  /** IndexedDB blob id, or null if no mesh is loaded. */
  id: string | null;
  /** Display name (usually the source filename). */
  name: string;
  /** Uniform scale applied to the imported mesh. */
  scale: number;
  /** Rotation around the vertical (Y) axis, degrees. */
  yawDeg: number;
  /** Rotation around the X axis, degrees. */
  tiltDeg: number;
  /** Vertical offset from origin, metres. */
  offsetY: number;
}

export interface MappingParams {
  /** LEDs in the order they were placed on the strand. */
  leds: MappedLed[];
  /** Which surface the mapping app targets — the ellipsoid or an uploaded mesh. */
  mode: MappingMode;
  /** Active interaction tool in the mapping view. */
  tool: MappingTool;
  /** Mirror mapping orientation vertically (swap top/bottom). */
  flipUpDown: boolean;
  /** Mirror mapping orientation horizontally (swap left/right). */
  flipLeftRight: boolean;
  /**
   * When true, the logical sequence (LED numbering + the order streamed to
   * the simulator/WLED) is the reverse of the placement order — i.e. the
   * last-placed bead becomes #1. Flips which physical end counts as the
   * start of the string.
   */
  reversed: boolean;
  /** Bead display size in the mapping view (metres). */
  ledSize: number;
  /**
   * Maximum world-space distance the next LED can sit from the previous
   * one, in metres. Modelled as an upper bound on the length of each
   * strand segment: clicks farther than this from the last placed bead
   * are rejected and the hover preview turns red. Ignored for the first
   * bead in the strand.
   */
  maxSegmentLength: number;
  /**
   * When false, the mapping view shows hand-placed LEDs only: offsets and
   * domes are not drawn, do not move beads, and their controls are hidden.
   * The saved offsets and domes are left intact.
   */
  showOffsetsAndDomes: boolean;
  /** Show the 3D smooth-dome displacement surfaces in the mapping view. */
  showBumpSurfaces: boolean;
  /** Show mapped LEDs as full-size outward sensor hemispheres. */
  showBallSensors: boolean;
  /** Fraction of direct light blocked by smooth-dome surfaces, 0..1. */
  bumpLightOpacity: number;
  /** Fraction of direct light blocked by the pyramid mesh, 0..1. */
  pyramidLightOpacity: number;
  /** Blend from smooth max-union (0) to additive overlapping dome heights (1). */
  bumpAdditivity: number;
  /** Visual opacity of the mapping pyramid mesh. */
  meshSurfaceOpacity: number;
  /** Visual opacity of dome surfaces in mapping. */
  bumpSurfaceOpacity: number;
  /** Render the baked iso-surface preview in mapping. */
  showBakedSurface: boolean;
  /** Use baked iso-surface for bump occlusion in mapping/simulation. */
  useBakedSurface: boolean;
  /** Signature of the dome parameters used for the latest bake. */
  bakedSurfaceSignature: string | null;
  /** Increment to request a new baked surface build. */
  bakeSurfaceRequestNonce: number;
  /** Mapping-only inspection light orbit angle around the mesh. */
  mappingLightAngleDeg: number;
  /** Mapping-light vertical sweep: 0° above, 180° level, 360° below. */
  mappingLightElevationDeg: number;
  /** Mapping-only inspection light distance from the mesh centre. */
  mappingLightRadius: number;
  /** Mapping-only inspection light brightness. */
  mappingLightIntensity: number;
  /** Mapping-light angular response (same model as simulation sun/moon). */
  mappingLightSpread: number;
  /** Mapping-light radial beam falloff. */
  mappingLightFocus: number;
  /** Mapping-light distance falloff exponent. */
  mappingLightDecay: number;
  /** Mapping-only inspection light and streamed output colour. */
  mappingLightColor: string;
  /** Surface domes that lift / tilt nearby LEDs (legacy persisted name). */
  gaussians: MappingGaussian[];
}

/**
 * The default seed spread across the 24-hour day, per channel. The
 * sun channel emphasises daytime transitions (dawn → noon → sunset),
 * the moon channel emphasises night/twilight, and ambient covers the
 * whole cycle. Users can freely add, delete, and move stops in each
 * track after loading. Declared before `DEFAULTS` so it's out of the
 * temporal dead zone by the time `DEFAULTS` seeds itself.
 */
type ChannelSeed = Array<[number, string]>;

const SUN_SEED: ChannelSeed = [
  [4.5, "blueHour"],
  [6, "azureTwilight"],
  [6.75, "roseDawn"],
  [8, "goldenPeach"],
  [12, "noonSky"],
  [16, "warmDay"],
  [18.25, "emberSunset"],
  [19, "crimsonSunset"],
];

const MOON_SEED: ChannelSeed = [
  [0, "moonlitBlue"],
  [4.5, "blueHour"],
  [7, "roseDawn"],
  [18.5, "emberSunset"],
  [20.5, "violetDusk"],
  [22, "blueHour"],
];

const AMBIENT_SEED: ChannelSeed = [
  [0, "moonlitBlue"],
  [5, "blueHour"],
  [7, "roseDawn"],
  [12, "noonSky"],
  [17, "warmDay"],
  [19, "emberSunset"],
  [21, "violetDusk"],
];

function seedColorFromSwatch(channel: SkyChannel, swatchId: string): string {
  const s = getSwatch(swatchId);
  return channel === "sun"
    ? s.sunColor
    : channel === "moon"
      ? s.moonColor
      : s.ambientColor;
}

export function buildDefaultChannelStops(channel: SkyChannel): SkyChannelStop[] {
  if (channel === "rim") return buildAtmosphericChannelStops("rim");
  const seed =
    channel === "sun" ? SUN_SEED : channel === "moon" ? MOON_SEED : AMBIENT_SEED;
  return seed.map(([hour, swatchId], i) => ({
    id: `${channel}-${i}-${swatchId}`,
    timeHours: hour,
    swatchId,
    color: seedColorFromSwatch(channel, swatchId),
  }));
}

const DEFAULTS = {
  ellipsoid: { rx: 1.2, ry: 0.8, rz: 1.0 } as EllipsoidParams,
  cloud: {
    opacity: 0.6,
    showOpacity: true,
    rotationXDeg: 0,
    rotationYDeg: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    applyLedOffset: true,
  } as CloudParams,
  cloudTop: {
    id: null,
    name: "",
    visible: true,
    scale: 1,
    yawDeg: 0,
    tiltDeg: 0,
    offsetX: 0,
    offsetY: 0,
    offsetZ: 0,
    tint: "#ffffff",
    glowStrength: 1.5,
    glowRadius: 0.25,
    glowFocus: 4,
  } as CloudTopParams,
  strand: {
    ledSize: 0.04,
    sensorHemisphereFocus: 0,
    colorProfile: { ...DEFAULT_LED_COLOR_PROFILE },
  } as StrandParams,
  ambient: {
    color: "#262830",
    intensity: 0.25,
    ducking: 0.75,
  } as AmbientLightParams,
  directional: {
    color: "#ffffff",
    intensity: 1.0,
    position: [3, 4, 2],
    spread: 1.0,
  } as DirectionalLightParams,
  sky: {
    enabled: true,
    visualizationAmount: 1,
    autoPlay: true,
    timeHours: 12,
    cycleSeconds: 180,
    cycleLocked: true,
    ambientScale: 1,
    sunScale: 1,
    moonScale: 1,
    sunSpread: 0.9,
    moonSpread: 0.9,
    sunBeamFocus: 0.65,
    sunTopHighlightBoost: 0,
    moonBeamFocus: 0.65,
    lightDecay: 1,
    showSpreadCones: false,
    orbitRadius: 12,
    orbitRadiusX: 12,
    orbitRadiusY: 12,
    orbitRadiusZ: 12,
    sunHorizonStartDeg: -8,
    sunHorizonFullDeg: 3,
    moonHorizonStartDeg: -8,
    moonHorizonFullDeg: 3,
    sunStops: buildDefaultChannelStops("sun"),
    moonStops: buildDefaultChannelStops("moon"),
    ambientStops: buildDefaultChannelStops("ambient"),
    rimStops: buildDefaultChannelStops("rim"),
    rimEnabled: false,
    rimScale: 1,
    rimWidth: 0.4,
    ambientOcclusion: 0,
    ambientShadowFloor: 0,
  } as SkyParams,
  wled: { host: "192.168.1.50", fps: 30, enabled: false } as WledParams,
  breath: {
    enabled: true,
    paused: false,
    effectMode: "travellingWave",
    triggerSource: "internal",
    inhaleSeconds: 2.5,
    holdPeakSeconds: 0.8,
    exhaleSeconds: 3.5,
    holdTroughSeconds: 0.9,
    horizonDistance: 0,
    cloudDistance: 2.5,
    waveWidth: 0.25,
    waveHeight: 0.25,
    waveDepth: 0.25,
    waveSpeed: 1.2,
    localInflationRadius: 0.65,
    localInflationStrength: 1,
    localInflationGrowthExponent: 1,
    falloffExponent: 2.1,
    noiseScale: 2.0,
    noiseAmount: 0.85,
    noiseContrast: 1.2,
    edgeNoise: 0.15,
    rimThickness: 0.06,
    rimAmount: 0.75,
    rimArcDegrees: 180,
    breathVsTimeMix: 0.5,
    // Full day by default — narrow via Breath panel / sky timeline strip.
    activeStartHour: 0,
    activeEndHour: 24,
    exhaleSample: null,
    exhaleGain: 0.7,
    exhalePitchJitterCents: 200,
    participants: [
      {
        id: "participant-0",
        color: "#77d5ff",
        enabled: true,
        azimuthDeg: 0,
        phaseOffset: 0,
        fogSeed: fogSeedFromId("participant-0"),
      },
    ],
  } as BreathParams,
  lightning: {
    enabled: false,
    colors: buildDefaultLightningColors(),
    intensityRange: [0.9, 1.5],
    keyframes: [
      {
        id: "kf-0",
        t: 0,
        values: {
          intensityRange: [0.5, 0.9],
          strikesPerMinute: 2,
          strikePerMinute: 0.3,
          spritesPerMinute: 0.5,
          spriteStrobeDutyRange: [0.3, 0.6],
          subFlashes: 0.25,
          spanScale: 0.7,
          minSpanScale: 0.4,
          boltGain: 0.6,
          spriteGain: 1.2,
          backgroundGain: 0.25,
          thunderDelayMs: 800,
          pan: 0,
        },
      },
      {
        id: "kf-1",
        t: 0.5,
        values: {
          intensityRange: [0.9, 1.5],
          strikesPerMinute: 8,
          strikePerMinute: 1,
          spritesPerMinute: 2,
          spriteStrobeDutyRange: [0.2, 0.55],
          subFlashes: 0.4,
          spanScale: 0.85,
          minSpanScale: 0.5,
          boltGain: 0.8,
          spriteGain: 1.6,
          backgroundGain: 0.35,
          thunderDelayMs: 800,
          pan: 0,
        },
      },
      {
        id: "kf-2",
        t: 1,
        values: {
          intensityRange: [0.5, 0.9],
          strikesPerMinute: 2,
          strikePerMinute: 0.3,
          spritesPerMinute: 0.5,
          spriteStrobeDutyRange: [0.3, 0.6],
          subFlashes: 0.25,
          spanScale: 0.7,
          minSpanScale: 0.4,
          boltGain: 0.6,
          spriteGain: 1.2,
          backgroundGain: 0.25,
          thunderDelayMs: 800,
          pan: 0,
        },
      },
    ],
    strikesPerMinute: 2,
    strikePerMinute: 0.5,
    spritesPerMinute: 1,
    falloffDistance: 0.1,
    boltSegments: 10,
    boltJitterRange: [0.25, 0.55],
    travelSpeedRange: [0.5, 2],
    subFlashes: 0.4,
    spanScale: 0.85,
    minSpanScale: 0.5,
    activeStartHour: 20,
    activeEndHour: 4,
    boltSamples: [],
    strikeSample: null,
    backgroundSample: null,
    spriteAudioSamples: [],
    spriteSamples: [],
    spriteDurationMs: 180,
    spriteStrobeHz: 18,
    spriteStrobeDuty: 0.45,
    boltGain: 0.8,
    spriteGain: 1.4,
    spriteAudioGain: 1,
    spriteAudioReactiveBrightness: true,
    backgroundGain: 0.35,
    boltPitchJitterCents: 200,
    thunderDelayMs: 800,
    pan: 0,
    simFps: 60,
  } as LightningParams,
  breathFilter: {
    enabled: true,
    threshold: 0,
    keyframes: [
      { id: "bf-kf-0", t: 0, threshold: 0 },
      { id: "bf-kf-1", t: 1, threshold: 0 },
    ],
    decayMaxSeconds: 2,
    cooldownScale: 2,
    cooldownContrast: 3,
    seed: 1,
    showNoise: false,
  } as BreathFilterParams,
  drone: {
    enabled: false,
    // Sensible pad defaults: fully open filter so the raw tone is
    // audible without further tweaking, gentle ADSR, no modulation.
    masterGain: 0.4,
    waveform: "triangle",
    attack: 0.6,
    decay: 0.8,
    sustain: 0.9,
    release: 1.5,
    tremoloRateHz: 4,
    tremoloDepth: 0,
    tremoloShape: "sine",
    saturation: 0,
    distortionEnabled: false,
    distortionDrive: 0.5,
    distortionMix: 0.5,
    filters: DEFAULT_FILTER_CHAIN,
    // A single C1 sustained through the whole 24h so the app makes
    // sound out of the box; users layer more notes on top.
    notes: [
      {
        id: "drone-n0",
        note: "C1",
        startHour: 0,
        endHour: 24,
        gain: 0,
        filterHz: 20000,
      },
    ],
  } as DroneParams,
  pad: {
    enabled: false,
    // Warm-pad defaults: slow attack + release, saw + subtle unison spread,
    // moderately closed low-pass with a gentle envelope, slow chorus, and
    // a comfortable amount of reverb.
    engine: "tone",
    master: 0.35,
    waveform: "sawtooth",
    unisonCount: 3,
    unisonDetuneCents: 12,
    stereoWidth: 0.7,
    attack: 1.5,
    decay: 0.4,
    sustain: 0.8,
    release: 3.0,
    filterHz: 900,
    filterQ: 0.7,
    filterEnvAmount: 1200,
    chorusRateHz: 0.3,
    chorusDepth: 0.4,
    driftRateHz: 0.25,
    driftDepthCents: 4,
    filterLfoRateHz: 0.4,
    filterLfoDepth: 0,
    filterSlope: 24,
    filterKeyTrack: 0.4,
    osc2Level: 0,
    osc2Waveform: "triangle",
    osc2Semitones: 12,
    noiseLevel: 0,
    noiseToneHz: 6000,
    humanize: 0.25,
    delaySync: "off",
    tempoBpm: 90,
    subLevel: 0.25,
    subOctave: -1,
    monoBelowHz: 140,
    glue: 0.3,
    saturation: 0.15,
    reverbMix: 0.3,
    reverbRoomSize: 0.78,
    reverbDampingHz: 3500,
    reverbPreDelaySec: 0.035,
    delayMix: 0.1,
    delayTimeSec: 0.375,
    delayFeedback: 0.25,
    filters: DEFAULT_FILTER_CHAIN,
    eq: DEFAULT_PAD_EQ,
    keyframes: [],
    notes: [],
  } as PadParams,
  samples: {
    enabled: false,
    master: 0.7,
    pitchCents: 0,
    pitchLfoRateHz: 1,
    pitchLfoDepthCents: 0,
    pitchLfoShape: "sine",
    reverbMix: 0,
    reverbDecay: 0.7,
    delayMix: 0,
    delayTimeSec: 0.25,
    delayFeedback: 0.3,
    filters: DEFAULT_FILTER_CHAIN,
    library: [],
    clips: [],
  } as SamplesParams,
  dayCycle: {
    periods: [
      { id: "dawn", name: "Dawn", startHour: 5, endHour: 8, color: "#f472b6" },
      { id: "day", name: "Day", startHour: 8, endHour: 17, color: "#facc15" },
      { id: "dusk", name: "Dusk", startHour: 17, endHour: 20, color: "#fb923c" },
      { id: "night", name: "Night", startHour: 20, endHour: 0, color: "#6366f1" },
      {
        id: "magicalNight",
        name: "Magical night",
        startHour: 0,
        endHour: 5,
        color: "#c084fc",
      },
    ],
    activePeriodId: "dawn",
    autoNext: false,
  } as DayCycleParams,
  masterFx: {
    lpEnabled: false,
    lpHz: 20000,
    lpQ: 0.7,
    hpEnabled: false,
    hpHz: 40,
    hpQ: 0.7,
    applyToDrone: true,
    applyToPad: true,
    applyToSamples: true,
    outputGain: 1,
  } as MasterFxParams,
  breathMod: {} as Record<string, number>,
  breathModEnabled: false,
  breathModRevealCeiling: 1,
  ledViewMode: "breathPlusTimeOfDay" as LedViewMode,
  ledDisplayMode: "sensors" as LedDisplayMode,
  breathTimeCombineMode: "revealOnInhale" as BreathTimeCombineMode,
  ledStreamPipeline: {
    timeOfDayStage: true,
    breathStage: true,
    lightningStage: true,
    locatorOverrideStage: true,
  } as LedStreamPipeline,
  ledLocator: {
    enabled: false,
    highlighted: [],
    color: "#ffe14d",
  } as LedLocatorState,
  mapping: {
    leds: [],
    mode: "ellipsoid",
    tool: "place",
    flipUpDown: false,
    flipLeftRight: false,
    reversed: false,
    ledSize: 0.01,
    maxSegmentLength: 0.05,
    showOffsetsAndDomes: true,
    showBumpSurfaces: false,
    showBallSensors: false,
    bumpLightOpacity: 1,
    pyramidLightOpacity: 1,
    bumpAdditivity: 0.2,
    meshSurfaceOpacity: 0.65,
    bumpSurfaceOpacity: 0.62,
    showBakedSurface: false,
    useBakedSurface: false,
    bakedSurfaceSignature: null,
    bakeSurfaceRequestNonce: 0,
    mappingLightAngleDeg: 45,
    mappingLightElevationDeg: 0,
    mappingLightRadius: 5,
    mappingLightIntensity: 1.5,
    mappingLightSpread: 0.9,
    mappingLightFocus: 0.65,
    mappingLightDecay: 1,
    mappingLightColor: "#fff3d0",
    gaussians: [],
  } as MappingParams,
  mesh: {
    id: null,
    name: "",
    scale: 1,
    yawDeg: 0,
    tiltDeg: 0,
    offsetY: 0,
  } as MeshTargetParams,
  ui: {
    showMaster: true,
    showBreath: true,
    showLightning: false,
    showBreathFilter: false,
    showTimeOfDay: false,
    showCloud: false,
    showStream: false,
  } as UiParams,
  audioSolo: null as AudioSolo,
  audioMuted: {
    drone: false,
    pad: false,
    samples: false,
  } as AudioMuted,
};

function normalizeLedViewMode(mode: unknown): LedViewMode {
  if (mode === "lightOnly") return "timeOfDay";
  if (mode === "breathPlusLight") return "breathPlusTimeOfDay";
  if (
    mode === "breathIntensity" ||
    mode === "timeOfDay" ||
    mode === "breathPlusTimeOfDay"
  ) {
    return mode;
  }
  return DEFAULTS.ledViewMode;
}

/**
 * Migration from the previous tri-color stop model where each stop
 * pinned sun/moon/ambient together. We just fan each old stop out into
 * one channel stop for each of the three lists at the same hour.
 */
function channelsFromLegacyStops(
  stops: LegacyTriStop[],
): Pick<SkyParams, "sunStops" | "moonStops" | "ambientStops"> {
  const mk = (channel: SkyChannel): SkyChannelStop[] =>
    stops.map((s, i) => ({
      id: `${channel}-legacy-${i}-${s.id}`,
      timeHours: s.timeHours,
      swatchId: s.swatchId,
      color:
        channel === "sun"
          ? s.sunColor
          : channel === "moon"
            ? s.moonColor
            : s.ambientColor,
    }));
  return {
    sunStops: mk("sun"),
    moonStops: mk("moon"),
    ambientStops: mk("ambient"),
  };
}

/**
 * Older-still snapshots stored a fixed-phase palette. Convert it to
 * three independent channel timelines by iterating the phase → hour
 * mapping and pulling the matching channel color from each entry.
 */
function channelsFromLegacyPalette(
  palette: Record<string, { ambientColor?: string; sunColor?: string; moonColor?: string }>,
): Pick<SkyParams, "sunStops" | "moonStops" | "ambientStops"> {
  const phaseToHour: Record<string, number> = {
    night: 0,
    preDawn: 4.5,
    blueHour: 6,
    sunrise: 6.75,
    goldenHour: 8,
    day: 12,
    afternoon: 16,
    sunset: 18.5,
    twilight: 20,
  };
  const mk = (channel: SkyChannel): SkyChannelStop[] => {
    const out: SkyChannelStop[] = [];
    let i = 0;
    for (const [phaseId, hour] of Object.entries(phaseToHour)) {
      const p = palette[phaseId];
      if (!p) continue;
      const c =
        channel === "sun"
          ? p.sunColor
          : channel === "moon"
            ? p.moonColor
            : p.ambientColor;
      out.push({
        id: `${channel}-legacy-${i++}-${phaseId}`,
        timeHours: hour,
        swatchId: CUSTOM_SWATCH_ID,
        color: c ?? "#101828",
      });
    }
    return out;
  };
  const sun = mk("sun");
  return sun.length > 0
    ? { sunStops: sun, moonStops: mk("moon"), ambientStops: mk("ambient") }
    : {
        sunStops: buildDefaultChannelStops("sun"),
        moonStops: buildDefaultChannelStops("moon"),
        ambientStops: buildDefaultChannelStops("ambient"),
      };
}

/**
 * Resolve a saved sky payload (which may be from any historical schema
 * version) into three channel arrays. Preference order: existing
 * per-channel arrays → legacy `stops` list → older-still `palette` map
 * → hardcoded defaults.
 */
function resolveChannelStops(
  savedSky: Partial<SkyParams> & {
    stops?: LegacyTriStop[];
    palette?: Record<string, unknown>;
  },
): Pick<SkyParams, "sunStops" | "moonStops" | "ambientStops" | "rimStops"> {
  let fallback: Pick<SkyParams, "sunStops" | "moonStops" | "ambientStops">;
  if (Array.isArray(savedSky.stops) && savedSky.stops.length > 0) {
    fallback = channelsFromLegacyStops(savedSky.stops);
  } else if (savedSky.palette && typeof savedSky.palette === "object") {
    fallback = channelsFromLegacyPalette(
      savedSky.palette as Record<
        string,
        { ambientColor?: string; sunColor?: string; moonColor?: string }
      >,
    );
  } else {
    fallback = {
      sunStops: DEFAULTS.sky.sunStops,
      moonStops: DEFAULTS.sky.moonStops,
      ambientStops: DEFAULTS.sky.ambientStops,
    };
  }
  return {
    sunStops: Array.isArray(savedSky.sunStops)
      ? savedSky.sunStops
      : fallback.sunStops,
    moonStops: Array.isArray(savedSky.moonStops)
      ? savedSky.moonStops
      : fallback.moonStops,
    ambientStops: Array.isArray(savedSky.ambientStops)
      ? savedSky.ambientStops
      : fallback.ambientStops,
    rimStops: Array.isArray(savedSky.rimStops)
      ? savedSky.rimStops
      : DEFAULTS.sky.rimStops,
  };
}

/**
 * Reconcile a saved `drone` payload against the current shape. Merges
 * legacy schemas (flat timbre fields, or the timbre-stops variant) by
 * taking the first timbre stop or the flat fields as the current
 * global synth patch. Missing fields fall back to defaults.
 */
function resolveDroneParams(
  saved: (Partial<DroneParams> & Record<string, unknown>) | undefined,
): DroneParams {
  if (!saved) return DEFAULTS.drone;
  const notes = Array.isArray(saved.notes)
    ? (saved.notes as DroneNote[])
    : DEFAULTS.drone.notes;
  const legacyStops = saved.timbreStops as
    | Array<{ timbre?: Partial<DroneParams> }>
    | undefined;
  const legacyTimbre = legacyStops?.[0]?.timbre ?? undefined;
  const pick = <K extends keyof DroneParams>(k: K): DroneParams[K] => {
    const v =
      (saved as Record<string, unknown>)[k] ??
      (legacyTimbre as Record<string, unknown> | undefined)?.[k];
    return (v ?? DEFAULTS.drone[k]) as DroneParams[K];
  };
  const attackLegacy = (saved as Record<string, unknown>).attackSec;
  const releaseLegacy = (saved as Record<string, unknown>).releaseSec;
  return {
    enabled:
      typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.drone.enabled,
    masterGain: pick("masterGain"),
    waveform: pick("waveform"),
    attack:
      typeof attackLegacy === "number" ? attackLegacy : pick("attack"),
    decay: pick("decay"),
    sustain: pick("sustain"),
    release:
      typeof releaseLegacy === "number" ? releaseLegacy : pick("release"),
    tremoloRateHz: pick("tremoloRateHz"),
    tremoloDepth: pick("tremoloDepth"),
    tremoloShape: pick("tremoloShape"),
    saturation:
      typeof saved.saturation === "number"
        ? saved.saturation
        : DEFAULTS.drone.saturation,
    distortionEnabled: pick("distortionEnabled"),
    distortionDrive: pick("distortionDrive"),
    distortionMix: pick("distortionMix"),
    filters: resolveFilterChain((saved as Record<string, unknown>).filters),
    notes,
  };
}

/**
 * Reconcile a saved `pad` payload against the current shape. Missing
 * fields fall back to defaults; unknown fields are ignored.
 */
function resolvePadKeyframes(
  input: unknown,
  fallback: PadParams,
): PadKeyframe[] {
  if (!Array.isArray(input)) return [];
  const out: PadKeyframe[] = [];
  const ids = new Set<string>();
  const params = new Set<string>(PAD_KEYFRAME_PARAMS);
  const addPoint = (
    idBase: string,
    hour: number,
    param: PadKeyframeParam,
    value: number,
  ) => {
    let id = idBase;
    let suffix = 2;
    while (ids.has(id)) id = `${idBase}-${suffix++}`;
    ids.add(id);
    out.push({
      id,
      hour: ((hour % 24) + 24) % 24,
      param,
      value,
    });
  };
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (
      typeof rec.id !== "string" ||
      !rec.id ||
      typeof rec.hour !== "number" ||
      !Number.isFinite(rec.hour)
    ) {
      continue;
    }

    // Current independent-lane format.
    if (
      typeof rec.param === "string" &&
      params.has(rec.param) &&
      typeof rec.value === "number" &&
      Number.isFinite(rec.value)
    ) {
      addPoint(
        rec.id,
        rec.hour,
        rec.param as PadKeyframeParam,
        rec.value,
      );
      continue;
    }

    // Legacy full-patch snapshot: expand it into one point per parameter.
    if (rec.values && typeof rec.values === "object") {
      const valuesRec = rec.values as Record<string, unknown>;
      for (const param of PAD_KEYFRAME_PARAMS) {
        const rawValue = valuesRec[param];
        const value =
          typeof rawValue === "number" && Number.isFinite(rawValue)
            ? rawValue
            : fallback[param];
        addPoint(`${rec.id}-${param}`, rec.hour, param, value);
      }
    }
  }
  return out.sort(
    (a, b) =>
      a.hour - b.hour ||
      PAD_KEYFRAME_PARAMS.indexOf(a.param) -
        PAD_KEYFRAME_PARAMS.indexOf(b.param),
  );
}

function resolvePadParams(
  saved: (Partial<PadParams> & Record<string, unknown>) | undefined,
): PadParams {
  if (!saved) return DEFAULTS.pad;
  const notes = Array.isArray(saved.notes)
    ? (saved.notes as PadNote[])
    : DEFAULTS.pad.notes;
  const pick = <K extends keyof PadParams>(k: K): PadParams[K] => {
    const v = (saved as Record<string, unknown>)[k];
    return (v ?? DEFAULTS.pad[k]) as PadParams[K];
  };
  const resolved: PadParams = {
    enabled:
      typeof saved.enabled === "boolean" ? saved.enabled : DEFAULTS.pad.enabled,
    engine:
      saved.engine === "bellows-analog" || saved.engine === "bellows-motion"
        ? saved.engine
        : "tone",
    master: pick("master"),
    waveform: pick("waveform"),
    unisonCount: pick("unisonCount"),
    unisonDetuneCents: pick("unisonDetuneCents"),
    stereoWidth: pick("stereoWidth"),
    attack: pick("attack"),
    decay: pick("decay"),
    sustain: pick("sustain"),
    release: pick("release"),
    filterHz: pick("filterHz"),
    filterQ: pick("filterQ"),
    filterEnvAmount: pick("filterEnvAmount"),
    chorusRateHz: pick("chorusRateHz"),
    chorusDepth: pick("chorusDepth"),
    driftRateHz: pick("driftRateHz"),
    driftDepthCents: pick("driftDepthCents"),
    filterLfoRateHz: pick("filterLfoRateHz"),
    filterLfoDepth: pick("filterLfoDepth"),
    filterSlope: pick("filterSlope") === 12 ? 12 : 24,
    filterKeyTrack: pick("filterKeyTrack"),
    osc2Level: pick("osc2Level"),
    osc2Waveform: pick("osc2Waveform"),
    osc2Semitones: pick("osc2Semitones"),
    noiseLevel: pick("noiseLevel"),
    noiseToneHz: pick("noiseToneHz"),
    humanize: pick("humanize"),
    delaySync: PAD_DELAY_SYNCS.includes(pick("delaySync"))
      ? pick("delaySync")
      : "off",
    tempoBpm: pick("tempoBpm"),
    subLevel: pick("subLevel"),
    subOctave: pick("subOctave") === -2 ? -2 : -1,
    monoBelowHz: pick("monoBelowHz"),
    glue: pick("glue"),
    saturation: pick("saturation"),
    reverbMix: pick("reverbMix"),
    reverbRoomSize: pick("reverbRoomSize"),
    reverbDampingHz: pick("reverbDampingHz"),
    reverbPreDelaySec: pick("reverbPreDelaySec"),
    delayMix: pick("delayMix"),
    delayTimeSec: pick("delayTimeSec"),
    delayFeedback: pick("delayFeedback"),
    filters: resolveFilterChain((saved as Record<string, unknown>).filters),
    eq: resolvePadEq((saved as Record<string, unknown>).eq),
    keyframes: [],
    notes,
  };
  resolved.keyframes = resolvePadKeyframes(
    (saved as Record<string, unknown>).keyframes,
    resolved,
  );
  return resolved;
}

/**
 * Reconcile a saved `samples` payload against the current shape.
 * Coerces malformed entries to defaults. Drops clips whose `sampleId`
 * doesn't exist in the loaded library — the referenced blob may have
 * been evicted from IndexedDB.
 */
function resolveSamplesParams(
  saved: (Partial<SamplesParams> & Record<string, unknown>) | undefined,
): SamplesParams {
  if (!saved) return DEFAULTS.samples;
  const rawClips = Array.isArray(saved.clips)
    ? (saved.clips as unknown as Array<Record<string, unknown>>)
    : [];
  // First legacy clip per sampleId supplies track params when the
  // library entry itself doesn't yet carry them.
  const legacyBySample = new Map<string, Record<string, unknown>>();
  for (const c of rawClips) {
    if (!c || typeof c.sampleId !== "string") continue;
    if (!legacyBySample.has(c.sampleId)) legacyBySample.set(c.sampleId, c);
  }

  const library: Sample[] = Array.isArray(saved.library)
    ? (saved.library as unknown as Array<Record<string, unknown>>)
        .filter(
          (s) =>
            s && typeof s.id === "string" && typeof s.name === "string",
        )
        .map((s) => {
          const id = s.id as string;
          const durationSec =
            typeof s.durationSec === "number" && Number.isFinite(s.durationSec)
              ? Math.max(0, s.durationSec)
              : 0;
          const track = resolveSampleTrackFields(
            s,
            legacyBySample.get(id),
            durationSec,
          );
          return {
            id,
            name: s.name as string,
            durationSec,
            ...track,
          };
        })
    : DEFAULTS.samples.library;
  const libIds = new Set(library.map((s) => s.id));
  const clips: SampleClip[] = rawClips
    .filter(
      (c) =>
        c &&
        typeof c.id === "string" &&
        typeof c.sampleId === "string" &&
        libIds.has(c.sampleId),
    )
    .map((c) => ({
      id: c.id as string,
      sampleId: c.sampleId as string,
      startHour: Math.max(
        0,
        Math.min(24, typeof c.startHour === "number" ? c.startHour : 0),
      ),
    }));
  return {
    enabled:
      typeof saved.enabled === "boolean"
        ? saved.enabled
        : DEFAULTS.samples.enabled,
    master:
      typeof saved.master === "number"
        ? Math.max(0, Math.min(3, saved.master))
        : DEFAULTS.samples.master,
    pitchCents:
      typeof saved.pitchCents === "number"
        ? Math.max(-1200, Math.min(1200, saved.pitchCents))
        : DEFAULTS.samples.pitchCents,
    pitchLfoRateHz:
      typeof saved.pitchLfoRateHz === "number"
        ? Math.max(0, Math.min(20, saved.pitchLfoRateHz))
        : DEFAULTS.samples.pitchLfoRateHz,
    pitchLfoDepthCents:
      typeof saved.pitchLfoDepthCents === "number"
        ? Math.max(0, Math.min(1200, saved.pitchLfoDepthCents))
        : DEFAULTS.samples.pitchLfoDepthCents,
    pitchLfoShape:
      saved.pitchLfoShape === "triangle" ||
      saved.pitchLfoShape === "square" ||
      saved.pitchLfoShape === "sawtooth" ||
      saved.pitchLfoShape === "sine"
        ? saved.pitchLfoShape
        : DEFAULTS.samples.pitchLfoShape,
    reverbMix:
      typeof saved.reverbMix === "number"
        ? Math.max(0, Math.min(1, saved.reverbMix))
        : DEFAULTS.samples.reverbMix,
    reverbDecay:
      typeof saved.reverbDecay === "number"
        ? Math.max(0, Math.min(0.99, saved.reverbDecay))
        : DEFAULTS.samples.reverbDecay,
    delayMix:
      typeof saved.delayMix === "number"
        ? Math.max(0, Math.min(1, saved.delayMix))
        : DEFAULTS.samples.delayMix,
    delayTimeSec:
      typeof saved.delayTimeSec === "number"
        ? Math.max(0, Math.min(2, saved.delayTimeSec))
        : DEFAULTS.samples.delayTimeSec,
    delayFeedback:
      typeof saved.delayFeedback === "number"
        ? Math.max(0, Math.min(0.9, saved.delayFeedback))
        : DEFAULTS.samples.delayFeedback,
    filters: resolveFilterChain((saved as Record<string, unknown>).filters),
    library,
    clips,
  };
}

/**
 * Reconcile a saved breath payload, migrating the legacy single-area +
 * breathers model into horizon participants + travelling-wave params.
 */
function resolveBreath(input: unknown): BreathParams {
  const d = DEFAULTS.breath;
  if (!input || typeof input !== "object") return d;
  const saved = input as Record<string, unknown>;
  const legacyArea =
    (saved.area as Record<string, unknown> | undefined) ??
    (saved.wind as Record<string, unknown> | undefined) ??
    {};

  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  // Legacy `horizonDistance` was radial distance to the cloud. Prefer an
  // explicit `cloudDistance` when present; otherwise migrate the old field
  // into cloudDistance and default vertical offset to 0.
  const hasCloudDistance = typeof saved.cloudDistance === "number";
  const cloudDistance = hasCloudDistance
    ? num(saved.cloudDistance, d.cloudDistance)
    : num(
        saved.horizonDistance,
        num(legacyArea.distanceFromCloud, d.cloudDistance) + 1.5,
      );
  const horizonDistance = hasCloudDistance
    ? num(saved.horizonDistance, d.horizonDistance)
    : 0;
  const legacyRadius = Math.max(
    0,
    Math.min(0.5, num(saved.waveRadius, Math.min(0.5, num(legacyArea.radius, d.waveWidth)))),
  );
  const waveWidth = Math.max(
    0,
    Math.min(0.5, num(saved.waveWidth, legacyRadius)),
  );
  const waveHeight = Math.max(
    0,
    Math.min(0.5, num(saved.waveHeight, legacyRadius)),
  );
  const waveDepth = Math.max(
    0,
    Math.min(2, num(saved.waveDepth, waveWidth)),
  );
  const falloffExponent = num(
    saved.falloffExponent,
    num(legacyArea.falloffExponent, d.falloffExponent),
  );
  const breathVsTimeMix = num(
    saved.breathVsTimeMix,
    num(legacyArea.breathVsTimeMix, d.breathVsTimeMix),
  );
  const waveSpeed = num(saved.waveSpeed, d.waveSpeed);
  const noiseScale = num(saved.noiseScale, d.noiseScale);
  const noiseAmount = num(saved.noiseAmount, d.noiseAmount);
  const noiseContrast = num(saved.noiseContrast, d.noiseContrast);
  const edgeNoise = num(saved.edgeNoise, d.edgeNoise);
  const rimThickness = num(saved.rimThickness, d.rimThickness);
  const rimAmount = num(saved.rimAmount, d.rimAmount);
  const rimArcDegrees = num(saved.rimArcDegrees, d.rimArcDegrees);

  const rawList: unknown[] = Array.isArray(saved.participants)
    ? (saved.participants as unknown[])
    : Array.isArray(saved.breathers)
      ? (saved.breathers as unknown[])
      : [];

  const participants: BreathParticipant[] = [];
  const n = Math.min(MAX_BREATH_PARTICIPANTS, Math.max(1, rawList.length || 1));
  for (let i = 0; i < n; i++) {
    const raw = (rawList[i] ?? {}) as Record<string, unknown>;
    const evenly = (i / n) * 360;
    const legacyAz =
      i === 0 && typeof legacyArea.sourceAzimuthDeg === "number"
        ? (legacyArea.sourceAzimuthDeg as number)
        : evenly;
    participants.push({
      id:
        typeof raw.id === "string" && raw.id
          ? raw.id
          : `participant-${i}`,
      color:
        typeof raw.color === "string" && raw.color
          ? raw.color
          : d.participants[0]?.color ?? "#77d5ff",
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : true,
      azimuthDeg: num(raw.azimuthDeg, legacyAz),
      phaseOffset: Math.max(0, Math.min(1, num(raw.phaseOffset, (i * 0.17) % 1))),
      fogSeed: (() => {
        if (typeof raw.fogSeed === "number" && Number.isFinite(raw.fogSeed)) {
          return raw.fogSeed >>> 0;
        }
        const id =
          typeof raw.id === "string" && raw.id
            ? raw.id
            : `participant-${i}`;
        return fogSeedFromId(id);
      })(),
    });
  }
  if (participants.length === 0) {
    participants.push({ ...d.participants[0] });
  }

  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : d.enabled,
    paused: typeof saved.paused === "boolean" ? saved.paused : d.paused,
    effectMode:
      saved.effectMode === "localInflation" ||
      saved.effectMode === "travellingWave"
        ? saved.effectMode
        : d.effectMode,
    triggerSource:
      saved.triggerSource === "osc" || saved.triggerSource === "internal"
        ? saved.triggerSource
        : d.triggerSource,
    inhaleSeconds: Math.max(0, num(saved.inhaleSeconds, d.inhaleSeconds)),
    holdPeakSeconds: Math.max(0, num(saved.holdPeakSeconds, d.holdPeakSeconds)),
    exhaleSeconds: Math.max(0, num(saved.exhaleSeconds, d.exhaleSeconds)),
    holdTroughSeconds: Math.max(0, num(saved.holdTroughSeconds, d.holdTroughSeconds)),
    horizonDistance,
    cloudDistance: Math.max(0.2, cloudDistance),
    waveWidth,
    waveHeight,
    waveDepth,
    waveSpeed: Math.max(0, Math.min(2, waveSpeed)),
    localInflationRadius: Math.max(
      0.02,
      Math.min(
        3,
        num(saved.localInflationRadius, d.localInflationRadius),
      ),
    ),
    localInflationStrength: Math.max(
      0,
      Math.min(
        1,
        num(saved.localInflationStrength, d.localInflationStrength),
      ),
    ),
    localInflationGrowthExponent: Math.max(
      0.1,
      Math.min(
        4,
        num(
          saved.localInflationGrowthExponent,
          d.localInflationGrowthExponent,
        ),
      ),
    ),
    falloffExponent: Math.max(0, Math.min(10, falloffExponent)),
    noiseScale: Math.max(0.1, Math.min(20, noiseScale)),
    noiseAmount: Math.max(0, Math.min(1, noiseAmount)),
    noiseContrast: Math.max(0.1, Math.min(5, noiseContrast)),
    edgeNoise: Math.max(0, Math.min(2, edgeNoise)),
    rimThickness: Math.max(0, Math.min(0.2, rimThickness)),
    rimAmount: Math.max(0, Math.min(1, rimAmount)),
    rimArcDegrees: Math.max(0, Math.min(360, rimArcDegrees)),
    breathVsTimeMix: Math.max(0, Math.min(1, breathVsTimeMix)),
    activeStartHour: Math.max(
      0,
      Math.min(24, num(saved.activeStartHour, d.activeStartHour)),
    ),
    activeEndHour: Math.max(
      0,
      Math.min(24, num(saved.activeEndHour, d.activeEndHour)),
    ),
    exhaleSample: (() => {
      const raw = saved.exhaleSample;
      if (!raw || typeof raw !== "object") return null;
      return resolveLightningSample(raw as Record<string, unknown>);
    })(),
    exhaleGain: Math.max(0, Math.min(3, num(saved.exhaleGain, d.exhaleGain))),
    exhalePitchJitterCents: Math.max(
      0,
      Math.min(1200, num(saved.exhalePitchJitterCents, d.exhalePitchJitterCents)),
    ),
    participants,
  };
}

/**
 * Reconcile a saved `dayCycle` payload. Falls back to defaults for a
 * missing or malformed slice; unknown activeId → first period.
 * Migrates the legacy single Night (20→5) into Night + Magical night.
 */
function resolveDayCycle(
  saved: Partial<DayCycleParams> | undefined,
): DayCycleParams {
  if (!saved) return DEFAULTS.dayCycle;
  let periods: DayPeriod[] = Array.isArray(saved.periods) && saved.periods.length > 0
    ? saved.periods
        .filter((p): p is DayPeriod =>
          !!p &&
          typeof p.id === "string" &&
          typeof p.name === "string" &&
          typeof p.startHour === "number" &&
          typeof p.endHour === "number" &&
          typeof p.color === "string",
        )
        .map((p) => ({
          id: p.id,
          name: p.name,
          startHour: Math.max(0, Math.min(24, p.startHour)),
          endHour: Math.max(0, Math.min(24, p.endHour)),
          color: p.color,
        }))
    : DEFAULTS.dayCycle.periods;
  periods = migrateLegacyNightPeriod(periods);
  const activePeriodId =
    saved.activePeriodId && periods.some((p) => p.id === saved.activePeriodId)
      ? saved.activePeriodId
      : periods[0].id;
  const autoNext =
    typeof saved.autoNext === "boolean" ? saved.autoNext : DEFAULTS.dayCycle.autoNext;
  return { periods, activePeriodId, autoNext };
}

/**
 * If the saved cycle still has a single Night spanning 20→5 (and no
 * Magical night yet), split it into Night 20→0 and Magical night 0→5.
 */
function migrateLegacyNightPeriod(periods: DayPeriod[]): DayPeriod[] {
  if (periods.some((p) => p.id === "magicalNight")) return periods;
  const nightIdx = periods.findIndex((p) => p.id === "night");
  if (nightIdx < 0) return periods;
  const night = periods[nightIdx];
  // Only rewrite the classic default span; leave custom night ranges alone.
  const isLegacySpan =
    Math.abs(night.startHour - 20) < 1e-6 && Math.abs(night.endHour - 5) < 1e-6;
  if (!isLegacySpan) return periods;
  const next = [...periods];
  next[nightIdx] = {
    ...night,
    name: night.name || "Night",
    startHour: 20,
    endHour: 0,
  };
  next.splice(nightIdx + 1, 0, {
    id: "magicalNight",
    name: "Magical night",
    startHour: 0,
    endHour: 5,
    color: "#c084fc",
  });
  return next;
}

/**
 * Reconcile a saved `masterFx` payload. If missing, tries to migrate
 * values from the legacy drone-scoped LPF/HPF fields so users don't
 * lose their previously-tuned master EQ. Peak filter fields are
 * dropped entirely.
 */
function resolveMasterFx(
  saved: Partial<MasterFxParams> | undefined,
  legacyDrone?: Record<string, unknown>,
): MasterFxParams {
  const d = DEFAULTS.masterFx;
  const pickBool = (
    v: unknown,
    fallback: boolean,
  ): boolean => (typeof v === "boolean" ? v : fallback);
  const pickNum = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  if (saved && typeof saved === "object") {
    return {
      lpEnabled: pickBool(saved.lpEnabled, d.lpEnabled),
      lpHz: pickNum(saved.lpHz, d.lpHz),
      lpQ: pickNum(saved.lpQ, d.lpQ),
      hpEnabled: pickBool(saved.hpEnabled, d.hpEnabled),
      hpHz: pickNum(saved.hpHz, d.hpHz),
      hpQ: pickNum(saved.hpQ, d.hpQ),
      applyToDrone: pickBool(saved.applyToDrone, d.applyToDrone),
      applyToPad: pickBool(saved.applyToPad, d.applyToPad),
      applyToSamples: pickBool(saved.applyToSamples, d.applyToSamples),
      outputGain: Math.max(
        0,
        Math.min(1.5, pickNum(saved.outputGain, d.outputGain)),
      ),
    };
  }
  if (legacyDrone) {
    return {
      lpEnabled: pickBool(legacyDrone.filterEnabled, d.lpEnabled),
      lpHz: pickNum(legacyDrone.filterHz, d.lpHz),
      lpQ: pickNum(legacyDrone.filterQ, d.lpQ),
      hpEnabled: pickBool(legacyDrone.highPassEnabled, d.hpEnabled),
      hpHz: pickNum(legacyDrone.highPassHz, d.hpHz),
      hpQ: pickNum(legacyDrone.highPassQ, d.hpQ),
      applyToDrone: d.applyToDrone,
      applyToPad: d.applyToPad,
      applyToSamples: d.applyToSamples,
      outputGain: d.outputGain,
    };
  }
  return d;
}

/**
 * Reconcile a saved `lightning` payload. Any missing range field is
 * back-filled from its legacy scalar so previously-saved snapshots
 * (before the ranges existed) keep working with sensible values.
 */
function cloneColorStop(s: LightningColorStop): LightningColorStop {
  return { id: s.id, t: s.t, color: s.color };
}

function cloneColorStops(list: LightningColorStop[]): LightningColorStop[] {
  return list.map(cloneColorStop);
}

export function cloneColorTracks(
  t: LightningColorTracks,
): LightningColorTracks {
  return {
    main: cloneColorStops(t.main),
    highlight1: cloneColorStops(t.highlight1),
    highlight2: cloneColorStops(t.highlight2),
  };
}

function resolveColorStops(
  input: unknown,
  fallback: LightningColorStop[],
): LightningColorStop[] {
  if (!Array.isArray(input) || input.length === 0) {
    return cloneColorStops(fallback);
  }
  const out: LightningColorStop[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw !== "object") continue;
    const rec = raw as Record<string, unknown>;
    if (typeof rec.color !== "string") continue;
    const t =
      typeof rec.t === "number" && Number.isFinite(rec.t)
        ? Math.max(0, Math.min(1, rec.t))
        : typeof rec.timeHours === "number" && Number.isFinite(rec.timeHours)
          ? Math.max(0, Math.min(1, rec.timeHours / 24))
          : NaN;
    if (!Number.isFinite(t)) continue;
    const id =
      typeof rec.id === "string" && rec.id.length > 0
        ? rec.id
        : `lcs-${i}-${Math.random().toString(36).slice(2, 6)}`;
    out.push({ id, t, color: rec.color });
  }
  return out.length > 0 ? out : cloneColorStops(fallback);
}

function resolveColorTracks(
  input: unknown,
  fallback: LightningColorTracks,
): LightningColorTracks {
  if (!input || typeof input !== "object") return cloneColorTracks(fallback);
  const rec = input as Record<string, unknown>;
  return {
    main: resolveColorStops(rec.main, fallback.main),
    highlight1: resolveColorStops(rec.highlight1, fallback.highlight1),
    highlight2: resolveColorStops(rec.highlight2, fallback.highlight2),
  };
}

function trackFromStaticPalette(palette: LightningPalette): LightningColorTracks {
  return {
    main: channelStopsPair(palette[0], palette[0]),
    highlight1: channelStopsPair(palette[1], palette[1]),
    highlight2: channelStopsPair(palette[2], palette[2]),
  };
}

/**
 * Prefer `colors`; migrate legacy `paletteTracks` / `palettes` / trio
 * `colors` so old snapshots keep working.
 */
function resolveLightningColors(
  saved: Record<string, unknown>,
  fallbackColors: LightningColorTracks,
): LightningColorTracks {
  if (saved.colors && typeof saved.colors === "object" && !Array.isArray(saved.colors)) {
    return resolveColorTracks(saved.colors, fallbackColors);
  }
  if (Array.isArray(saved.paletteTracks) && saved.paletteTracks[0]) {
    return resolveColorTracks(saved.paletteTracks[0], fallbackColors);
  }
  if (Array.isArray(saved.palettes) && saved.palettes[0]) {
    const p = saved.palettes[0];
    if (
      Array.isArray(p) &&
      p.length === 3 &&
      typeof p[0] === "string" &&
      typeof p[1] === "string" &&
      typeof p[2] === "string"
    ) {
      return trackFromStaticPalette([p[0], p[1], p[2]]);
    }
  }
  if (
    Array.isArray(saved.color) &&
    saved.color.length === 3 &&
    typeof saved.color[0] === "string"
  ) {
    return trackFromStaticPalette([
      saved.color[0] as string,
      saved.color[1] as string,
      saved.color[2] as string,
    ]);
  }
  return cloneColorTracks(fallbackColors);
}

function cloneAnimParams(src: LightningAnimParams): LightningAnimParams {
  return {
    intensityRange: [src.intensityRange[0], src.intensityRange[1]],
    strikesPerMinute: src.strikesPerMinute,
    strikePerMinute: src.strikePerMinute,
    spritesPerMinute: src.spritesPerMinute,
    spriteStrobeDutyRange: [
      src.spriteStrobeDutyRange[0],
      src.spriteStrobeDutyRange[1],
    ],
    subFlashes: src.subFlashes,
    spanScale: src.spanScale,
    minSpanScale: src.minSpanScale,
    boltGain: src.boltGain,
    spriteGain: src.spriteGain,
    backgroundGain: src.backgroundGain,
    thunderDelayMs: src.thunderDelayMs,
    pan: src.pan,
  };
}

/**
 * `subFlashes` used to be an integer flicker count (0–4). Values above 1
 * are treated as legacy and remapped onto [0, 1] via `/4`.
 */
function migrateSubFlashes(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v > 1) return Math.min(1, v / 4);
  return Math.max(0, Math.min(1, v));
}

function animParamsFromRoot(p: {
  intensityRange: [number, number];
  strikesPerMinute: number;
  strikePerMinute: number;
  spritesPerMinute: number;
  spriteStrobeDutyRange: [number, number];
  subFlashes: number;
  spanScale: number;
  minSpanScale: number;
  boltGain: number;
  spriteGain: number;
  backgroundGain: number;
  thunderDelayMs: number;
  pan: number;
}): LightningAnimParams {
  return cloneAnimParams(p);
}

function scaleIntensityRange(
  base: [number, number],
  scale: number,
): [number, number] {
  const s = Math.max(0, scale);
  return [base[0] * s, base[1] * s];
}

function resolveAnimParams(
  input: unknown,
  fallback: LightningAnimParams,
): LightningAnimParams {
  if (!input || typeof input !== "object") return cloneAnimParams(fallback);
  const rec = input as Record<string, unknown>;
  const intensityRange = (() => {
    const v = rec.intensityRange;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "number" &&
      typeof v[1] === "number"
    ) {
      return [Math.min(v[0], v[1]), Math.max(v[0], v[1])] as [number, number];
    }
    return fallback.intensityRange;
  })();
  const spriteStrobeDutyRange = (() => {
    const v = rec.spriteStrobeDutyRange;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "number" &&
      typeof v[1] === "number"
    ) {
      const lo = Math.max(0.05, Math.min(0.95, Math.min(v[0], v[1])));
      const hi = Math.max(lo, Math.min(0.95, Math.max(v[0], v[1])));
      return [lo, hi] as [number, number];
    }
    const legacy = rec.spriteStrobeDuty;
    if (typeof legacy === "number" && Number.isFinite(legacy)) {
      const duty = Math.max(0.05, Math.min(0.95, legacy));
      return [duty, duty] as [number, number];
    }
    return fallback.spriteStrobeDutyRange;
  })();
  const num = (v: unknown, fb: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : fb;
  const spanScale = Math.max(0, Math.min(1, num(rec.spanScale, fallback.spanScale)));
  const minSpanScale = Math.max(
    0,
    Math.min(spanScale, num(rec.minSpanScale, fallback.minSpanScale)),
  );
  return {
    intensityRange,
    strikesPerMinute: Math.max(
      0,
      Math.min(40, num(rec.strikesPerMinute, fallback.strikesPerMinute)),
    ),
    strikePerMinute: Math.max(
      0,
      Math.min(40, num(rec.strikePerMinute, fallback.strikePerMinute)),
    ),
    spritesPerMinute: Math.max(
      0,
      Math.min(40, num(rec.spritesPerMinute, fallback.spritesPerMinute)),
    ),
    spriteStrobeDutyRange,
    subFlashes: migrateSubFlashes(num(rec.subFlashes, fallback.subFlashes)),
    spanScale,
    minSpanScale,
    boltGain: Math.max(0, Math.min(3, num(rec.boltGain, fallback.boltGain))),
    spriteGain: Math.max(0, Math.min(3, num(rec.spriteGain, fallback.spriteGain))),
    backgroundGain: Math.max(
      0,
      Math.min(3, num(rec.backgroundGain, fallback.backgroundGain)),
    ),
    thunderDelayMs: Math.max(
      0,
      Math.min(2000, num(rec.thunderDelayMs, fallback.thunderDelayMs)),
    ),
    pan: Math.max(-1, Math.min(1, num(rec.pan, fallback.pan))),
  };
}

function resolveLightningKeyframes(
  input: unknown,
  legacyEnvelope: unknown,
  fallback: LightningKeyframe[],
  rootAnim: LightningAnimParams,
): LightningKeyframe[] {
  if (Array.isArray(input) && input.length >= 2) {
    const out: LightningKeyframe[] = [];
    for (let i = 0; i < input.length; i++) {
      const raw = input[i];
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const t = typeof rec.t === "number" && Number.isFinite(rec.t) ? rec.t : NaN;
      if (!Number.isFinite(t)) continue;
      const id =
        typeof rec.id === "string" && rec.id.length > 0
          ? rec.id
          : `kf-${i}-${Math.random().toString(36).slice(2, 7)}`;
      out.push({
        id,
        t: Math.max(0, Math.min(1, t)),
        values: resolveAnimParams(rec.values, rootAnim),
      });
    }
    if (out.length >= 2) {
      out.sort((a, b) => a.t - b.t);
      return out;
    }
  }
  // Migrate intensityEnvelope → keyframes scaling intensityRange by value.
  if (Array.isArray(legacyEnvelope) && legacyEnvelope.length >= 2) {
    const out: LightningKeyframe[] = [];
    for (let i = 0; i < legacyEnvelope.length; i++) {
      const raw = legacyEnvelope[i];
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const t = typeof rec.t === "number" && Number.isFinite(rec.t) ? rec.t : NaN;
      const value =
        typeof rec.value === "number" && Number.isFinite(rec.value)
          ? rec.value
          : NaN;
      if (!Number.isFinite(t) || !Number.isFinite(value)) continue;
      const id =
        typeof rec.id === "string" && rec.id.length > 0
          ? rec.id
          : `kf-mig-${i}`;
      const values = cloneAnimParams(rootAnim);
      values.intensityRange = scaleIntensityRange(rootAnim.intensityRange, value);
      out.push({ id, t: Math.max(0, Math.min(1, t)), values });
    }
    if (out.length >= 2) {
      out.sort((a, b) => a.t - b.t);
      return out;
    }
  }
  return fallback.map((k) => ({
    id: k.id,
    t: k.t,
    values: cloneAnimParams(k.values),
  }));
}

function resolveIntensityTags(input: unknown): BoltIntensityTag[] {
  if (!Array.isArray(input)) return [];
  const out: BoltIntensityTag[] = [];
  for (const v of input) {
    if (v === "low" || v === "medium" || v === "high") {
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

function resolveLengthTags(input: unknown): BoltLengthTag[] {
  if (!Array.isArray(input)) return [];
  const out: BoltLengthTag[] = [];
  for (const v of input) {
    if (v === "short" || v === "medium" || v === "long") {
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

export function resolveLightningSample(
  input: Record<string, unknown>,
): LightningSample | null {
  if (typeof input.id !== "string" || !input.id) return null;
  if (typeof input.name !== "string") return null;
  const durationSec =
    typeof input.durationSec === "number" && Number.isFinite(input.durationSec)
      ? input.durationSec
      : undefined;
  const gain =
    typeof input.gain === "number" && Number.isFinite(input.gain)
      ? Math.max(0, Math.min(1, input.gain))
      : 1;
  return {
    id: input.id,
    name: input.name,
    ...(durationSec !== undefined ? { durationSec } : {}),
    gain,
    intensityTags: resolveIntensityTags(input.intensityTags),
    lengthTags: resolveLengthTags(input.lengthTags),
  };
}

function resolveLightningSamples(input: unknown): LightningSample[] {
  if (!Array.isArray(input)) return [];
  const out: LightningSample[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const s = resolveLightningSample(raw as Record<string, unknown>);
    if (s) out.push(s);
  }
  return out;
}

export function resolveLightningSpriteSample(
  input: Record<string, unknown>,
): LightningSpriteSample | null {
  if (typeof input.id !== "string" || !input.id) return null;
  if (typeof input.name !== "string") return null;
  const width =
    typeof input.width === "number" && Number.isFinite(input.width)
      ? Math.max(1, Math.floor(input.width))
      : undefined;
  const height =
    typeof input.height === "number" && Number.isFinite(input.height)
      ? Math.max(1, Math.floor(input.height))
      : undefined;
  return {
    id: input.id,
    name: input.name,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function resolveLightningSpriteSamples(input: unknown): LightningSpriteSample[] {
  if (!Array.isArray(input)) return [];
  const out: LightningSpriteSample[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const s = resolveLightningSpriteSample(raw as Record<string, unknown>);
    if (s) out.push(s);
  }
  return out;
}

function resolveLightning(input: unknown): LightningParams {
  const d = DEFAULTS.lightning;
  if (!input || typeof input !== "object") return d;
  const saved = input as Partial<LightningParams> & Record<string, unknown>;
  const asPair = (
    v: unknown,
    fallback: [number, number],
  ): [number, number] => {
    if (Array.isArray(v) && v.length === 2 &&
        typeof v[0] === "number" && typeof v[1] === "number") {
      return [Math.min(v[0], v[1]), Math.max(v[0], v[1])];
    }
    return fallback;
  };
  const asPairFromScalar = (
    rangeKey: keyof LightningParams,
    legacyKey: string,
    fallback: [number, number],
  ): [number, number] => {
    const explicit = (saved as Record<string, unknown>)[rangeKey as string];
    if (Array.isArray(explicit)) return asPair(explicit, fallback);
    const scalar = (saved as Record<string, unknown>)[legacyKey];
    if (typeof scalar === "number") return [scalar, scalar];
    return fallback;
  };
  return {
    ...d,
    ...saved,
    colors: resolveLightningColors(
      saved as Record<string, unknown>,
      d.colors,
    ),
    intensityRange: asPairFromScalar(
      "intensityRange",
      "intensity",
      d.intensityRange,
    ),
    strikesPerMinute: (() => {
      const v =
        typeof saved.strikesPerMinute === "number"
          ? saved.strikesPerMinute
          : d.strikesPerMinute;
      return Math.max(0, Math.min(40, v));
    })(),
    strikePerMinute: (() => {
      const v =
        typeof saved.strikePerMinute === "number"
          ? saved.strikePerMinute
          : d.strikePerMinute;
      return Math.max(0, Math.min(40, v));
    })(),
    spritesPerMinute: (() => {
      const v =
        typeof saved.spritesPerMinute === "number"
          ? saved.spritesPerMinute
          : d.spritesPerMinute;
      return Math.max(0, Math.min(40, v));
    })(),
    keyframes: (() => {
      const intensityRange = asPairFromScalar(
        "intensityRange",
        "intensity",
        d.intensityRange,
      );
      const rootAnim = animParamsFromRoot({
        intensityRange,
        strikesPerMinute:
          typeof saved.strikesPerMinute === "number"
            ? saved.strikesPerMinute
            : d.strikesPerMinute,
        strikePerMinute:
          typeof saved.strikePerMinute === "number"
            ? saved.strikePerMinute
            : d.strikePerMinute,
        spritesPerMinute:
          typeof saved.spritesPerMinute === "number"
            ? saved.spritesPerMinute
            : d.spritesPerMinute,
        spriteStrobeDutyRange: [
          typeof saved.spriteStrobeDuty === "number"
            ? Math.max(0.05, Math.min(0.95, saved.spriteStrobeDuty))
            : d.spriteStrobeDuty,
          typeof saved.spriteStrobeDuty === "number"
            ? Math.max(0.05, Math.min(0.95, saved.spriteStrobeDuty))
            : d.spriteStrobeDuty,
        ],
        subFlashes: migrateSubFlashes(
          typeof saved.subFlashes === "number" ? saved.subFlashes : d.subFlashes,
        ),
        spanScale:
          typeof saved.spanScale === "number" ? saved.spanScale : d.spanScale,
        minSpanScale:
          typeof saved.minSpanScale === "number"
            ? saved.minSpanScale
            : d.minSpanScale,
        boltGain: typeof saved.boltGain === "number" ? saved.boltGain : d.boltGain,
        spriteGain:
          typeof saved.spriteGain === "number" ? saved.spriteGain : d.spriteGain,
        backgroundGain:
          typeof saved.backgroundGain === "number"
            ? saved.backgroundGain
            : d.backgroundGain,
        thunderDelayMs:
          typeof saved.thunderDelayMs === "number"
            ? saved.thunderDelayMs
            : d.thunderDelayMs,
        pan: typeof saved.pan === "number" ? saved.pan : d.pan,
      });
      return resolveLightningKeyframes(
        (saved as Record<string, unknown>).keyframes,
        (saved as Record<string, unknown>).intensityEnvelope,
        d.keyframes,
        rootAnim,
      );
    })(),
    falloffDistance: (() => {
      const rec = saved as Record<string, unknown>;
      const clamp = (v: number) => Math.max(0, Math.min(0.2, v));
      const explicit = rec.falloffDistance;
      if (typeof explicit === "number" && Number.isFinite(explicit)) {
        return clamp(explicit);
      }
      // Migration from the old fixed-radius model.
      const legacy = rec.boltRadius;
      if (typeof legacy === "number" && Number.isFinite(legacy)) {
        return clamp(legacy);
      }
      const range = rec.boltRadiusRange;
      if (
        Array.isArray(range) &&
        typeof range[0] === "number" &&
        typeof range[1] === "number"
      ) {
        return clamp((range[0] + range[1]) / 2);
      }
      return d.falloffDistance;
    })(),
    boltJitterRange: asPairFromScalar(
      "boltJitterRange",
      "boltJitter",
      d.boltJitterRange,
    ),
    travelSpeedRange: asPairFromScalar(
      "travelSpeedRange",
      "travelSpeed",
      d.travelSpeedRange,
    ),
    subFlashes: migrateSubFlashes(
      typeof saved.subFlashes === "number" ? saved.subFlashes : d.subFlashes,
    ),
    thunderDelayMs: (() => {
      const v = (saved as Record<string, unknown>).thunderDelayMs;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.thunderDelayMs;
      return Math.max(0, Math.min(2000, v));
    })(),
    pan: (() => {
      const v = (saved as Record<string, unknown>).pan;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.pan;
      return Math.max(-1, Math.min(1, v));
    })(),
    boltSamples: resolveLightningSamples(
      (saved as Record<string, unknown>).boltSamples,
    ),
    strikeSample: (() => {
      const raw = (saved as Record<string, unknown>).strikeSample;
      if (!raw || typeof raw !== "object") return null;
      return resolveLightningSample(raw as Record<string, unknown>);
    })(),
    backgroundSample: (() => {
      const raw = (saved as Record<string, unknown>).backgroundSample;
      if (!raw || typeof raw !== "object") return null;
      return resolveLightningSample(raw as Record<string, unknown>);
    })(),
    spriteAudioSamples: (() => {
      const modern = resolveLightningSamples(
        (saved as Record<string, unknown>).spriteAudioSamples,
      );
      if (modern.length > 0) return modern;
      const legacy = (saved as Record<string, unknown>).spriteSample;
      if (!legacy || typeof legacy !== "object") return [];
      const migrated = resolveLightningSample(
        legacy as Record<string, unknown>,
      );
      return migrated ? [migrated] : [];
    })(),
    spriteSamples: resolveLightningSpriteSamples(
      (saved as Record<string, unknown>).spriteSamples,
    ),
    spriteDurationMs: (() => {
      const v = (saved as Record<string, unknown>).spriteDurationMs;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteDurationMs;
      return Math.max(20, Math.min(3000, v));
    })(),
    spriteStrobeHz: (() => {
      const v = (saved as Record<string, unknown>).spriteStrobeHz;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteStrobeHz;
      return Math.max(1, Math.min(60, v));
    })(),
    spriteStrobeDuty: (() => {
      const v = (saved as Record<string, unknown>).spriteStrobeDuty;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteStrobeDuty;
      return Math.max(0.05, Math.min(0.95, v));
    })(),
    spriteGain: (() => {
      const v = (saved as Record<string, unknown>).spriteGain;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteGain;
      return Math.max(0, Math.min(3, v));
    })(),
    spriteAudioGain: (() => {
      const rec = saved as Record<string, unknown>;
      const v =
        typeof rec.spriteAudioGain === "number"
          ? rec.spriteAudioGain
          : rec.spriteGain;
      if (typeof v !== "number" || !Number.isFinite(v)) return d.spriteAudioGain;
      return Math.max(0, Math.min(3, v));
    })(),
    spriteAudioReactiveBrightness:
      typeof (saved as Record<string, unknown>).spriteAudioReactiveBrightness ===
      "boolean"
        ? ((saved as Record<string, unknown>)
            .spriteAudioReactiveBrightness as boolean)
        : d.spriteAudioReactiveBrightness,
    boltPitchJitterCents: (() => {
      const v = (saved as Record<string, unknown>).boltPitchJitterCents;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return d.boltPitchJitterCents;
      }
      return Math.max(0, Math.min(1200, v));
    })(),
  };
}

function resolveBreathFilterKeyframes(
  input: unknown,
  fallbackThreshold: number,
  defaults: BreathFilterKeyframe[],
): BreathFilterKeyframe[] {
  if (Array.isArray(input) && input.length >= 2) {
    const out: BreathFilterKeyframe[] = [];
    for (let i = 0; i < input.length; i++) {
      const raw = input[i];
      if (!raw || typeof raw !== "object") continue;
      const rec = raw as Record<string, unknown>;
      const t = typeof rec.t === "number" && Number.isFinite(rec.t) ? rec.t : NaN;
      if (!Number.isFinite(t)) continue;
      const threshold =
        typeof rec.threshold === "number" && Number.isFinite(rec.threshold)
          ? Math.max(0, Math.min(1, rec.threshold))
          : fallbackThreshold;
      const id =
        typeof rec.id === "string" && rec.id.length > 0
          ? rec.id
          : `bf-kf-${i}-${Math.random().toString(36).slice(2, 6)}`;
      out.push({ id, t: Math.max(0, Math.min(1, t)), threshold });
    }
    if (out.length >= 2) {
      out.sort((a, b) => a.t - b.t);
      return out;
    }
  }
  // Migrate scalar-only snapshots → flat envelope at the saved threshold.
  const th = Math.max(0, Math.min(1, fallbackThreshold));
  return [
    { id: defaults[0]?.id ?? "bf-kf-0", t: 0, threshold: th },
    { id: defaults[1]?.id ?? "bf-kf-1", t: 1, threshold: th },
  ];
}

function resolveBreathFilter(input: unknown): BreathFilterParams {
  const d = DEFAULTS.breathFilter;
  if (!input || typeof input !== "object") return d;
  const saved = input as Record<string, unknown>;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const threshold = Math.max(0, Math.min(1, num(saved.threshold, d.threshold)));
  const keyframes = resolveBreathFilterKeyframes(
    saved.keyframes,
    threshold,
    d.keyframes,
  );
  return {
    enabled: typeof saved.enabled === "boolean" ? saved.enabled : d.enabled,
    threshold,
    keyframes,
    decayMaxSeconds: Math.max(
      0.1,
      Math.min(30, num(saved.decayMaxSeconds, d.decayMaxSeconds)),
    ),
    cooldownScale: Math.max(
      0.1,
      Math.min(20, num(saved.cooldownScale, d.cooldownScale)),
    ),
    cooldownContrast: Math.max(
      0.1,
      Math.min(5, num(saved.cooldownContrast, d.cooldownContrast)),
    ),
    seed: Math.max(0, Math.floor(num(saved.seed, d.seed))) | 0,
    showNoise: typeof saved.showNoise === "boolean" ? saved.showNoise : d.showNoise,
  };
}

/** Clamp / normalise a saved mapping slice (tool, per-LED offsets). */
function resolveMapping(input: unknown): MappingParams {
  const d = DEFAULTS.mapping;
  if (!input || typeof input !== "object") return d;
  const saved = input as Partial<MappingParams> & Record<string, unknown>;
  const tool: MappingTool =
    saved.tool === "offset" ||
    saved.tool === "place" ||
    saved.tool === "gaussian"
      ? saved.tool
      : d.tool;
  const rawLeds = Array.isArray(saved.leds) ? saved.leds : d.leds;
  const leds: MappedLed[] = rawLeds.map((led) => {
    const l = (led ?? {}) as MappedLed;
    const offset =
      typeof l.offset === "number" && Number.isFinite(l.offset)
        ? Math.max(0, Math.min(0.5, l.offset))
        : 0;
    return { ...l, offset };
  });
  const rawGauss = Array.isArray(saved.gaussians) ? saved.gaussians : d.gaussians;
  const gaussians: MappingGaussian[] = [];
  for (let i = 0; i < rawGauss.length; i++) {
    const g = (rawGauss[i] ?? {}) as Partial<MappingGaussian>;
    const pos = Array.isArray(g.pos) && g.pos.length === 3
      ? ([g.pos[0], g.pos[1], g.pos[2]] as Vec3)
      : null;
    const normal = Array.isArray(g.normal) && g.normal.length === 3
      ? ([g.normal[0], g.normal[1], g.normal[2]] as Vec3)
      : null;
    if (!pos || !normal) continue;
    const amplitude =
      typeof g.amplitude === "number" && Number.isFinite(g.amplitude)
        ? Math.max(0, Math.min(0.5, g.amplitude))
        : 0.05;
    const legacySigma =
      typeof (g as { sigma?: number }).sigma === "number" &&
      Number.isFinite((g as { sigma?: number }).sigma)
        ? Math.max(0.005, Math.min(0.5, (g as { sigma: number }).sigma))
        : 0.08;
    const width =
      typeof g.width === "number" && Number.isFinite(g.width)
        ? Math.max(0.005, Math.min(0.5, g.width))
        : legacySigma;
    const height =
      typeof g.height === "number" && Number.isFinite(g.height)
        ? Math.max(0.005, Math.min(0.5, g.height))
        : legacySigma;
    let rotationDeg =
      typeof g.rotationDeg === "number" && Number.isFinite(g.rotationDeg)
        ? g.rotationDeg
        : 0;
    rotationDeg = ((rotationDeg % 360) + 360) % 360;
    gaussians.push({
      id:
        typeof g.id === "string" && g.id
          ? g.id
          : `gaussian-${i}-${Date.now().toString(36)}`,
      pos,
      normal,
      amplitude,
      width,
      height,
      rotationDeg,
    });
  }
  return {
    ...d,
    ...saved,
    tool,
    leds,
    gaussians,
    ledSize:
      typeof saved.ledSize === "number" && Number.isFinite(saved.ledSize)
        ? saved.ledSize
        : d.ledSize,
    maxSegmentLength:
      typeof saved.maxSegmentLength === "number" &&
      Number.isFinite(saved.maxSegmentLength)
        ? saved.maxSegmentLength
        : d.maxSegmentLength,
    showOffsetsAndDomes:
      typeof saved.showOffsetsAndDomes === "boolean"
        ? saved.showOffsetsAndDomes
        : d.showOffsetsAndDomes,
    showBumpSurfaces:
      typeof saved.showBumpSurfaces === "boolean"
        ? saved.showBumpSurfaces
        : d.showBumpSurfaces,
    showBallSensors:
      typeof saved.showBallSensors === "boolean"
        ? saved.showBallSensors
        : d.showBallSensors,
    bumpLightOpacity:
      typeof saved.bumpLightOpacity === "number" &&
      Number.isFinite(saved.bumpLightOpacity)
        ? Math.max(0, Math.min(1, saved.bumpLightOpacity))
        : d.bumpLightOpacity,
    pyramidLightOpacity:
      typeof saved.pyramidLightOpacity === "number" &&
      Number.isFinite(saved.pyramidLightOpacity)
        ? Math.max(0, Math.min(1, saved.pyramidLightOpacity))
        : d.pyramidLightOpacity,
    bumpAdditivity:
      typeof saved.bumpAdditivity === "number" &&
      Number.isFinite(saved.bumpAdditivity)
        ? Math.max(0, Math.min(1, saved.bumpAdditivity))
        : d.bumpAdditivity,
    meshSurfaceOpacity:
      typeof saved.meshSurfaceOpacity === "number" &&
      Number.isFinite(saved.meshSurfaceOpacity)
        ? Math.max(0, Math.min(1, saved.meshSurfaceOpacity))
        : d.meshSurfaceOpacity,
    bumpSurfaceOpacity:
      typeof saved.bumpSurfaceOpacity === "number" &&
      Number.isFinite(saved.bumpSurfaceOpacity)
        ? Math.max(0, Math.min(1, saved.bumpSurfaceOpacity))
        : d.bumpSurfaceOpacity,
    showBakedSurface:
      typeof saved.showBakedSurface === "boolean"
        ? saved.showBakedSurface
        : d.showBakedSurface,
    useBakedSurface:
      typeof saved.useBakedSurface === "boolean"
        ? saved.useBakedSurface
        : d.useBakedSurface,
    bakedSurfaceSignature:
      typeof saved.bakedSurfaceSignature === "string"
        ? saved.bakedSurfaceSignature
        : null,
    bakeSurfaceRequestNonce: 0,
    mappingLightAngleDeg:
      typeof saved.mappingLightAngleDeg === "number"
        ? saved.mappingLightAngleDeg
        : d.mappingLightAngleDeg,
    mappingLightElevationDeg:
      typeof saved.mappingLightElevationDeg === "number"
        ? ((saved.mappingLightElevationDeg % 360) + 360) % 360
        : typeof (saved as Record<string, unknown>).mappingLightHeight === "number"
          ? Math.asin(
              Math.max(
                -1,
                Math.min(
                  1,
                  ((saved as Record<string, number>).mappingLightHeight ?? 0) / 5,
                ),
              ),
            ) *
            (180 / Math.PI)
          : d.mappingLightElevationDeg,
    mappingLightRadius:
      typeof saved.mappingLightRadius === "number" &&
      Number.isFinite(saved.mappingLightRadius)
        ? Math.max(0.25, Math.min(20, saved.mappingLightRadius))
        : d.mappingLightRadius,
    mappingLightIntensity:
      typeof saved.mappingLightIntensity === "number"
        ? saved.mappingLightIntensity
        : d.mappingLightIntensity,
    mappingLightSpread:
      typeof saved.mappingLightSpread === "number"
        ? Math.max(0, Math.min(1, saved.mappingLightSpread))
        : d.mappingLightSpread,
    mappingLightFocus:
      typeof saved.mappingLightFocus === "number"
        ? Math.max(0, Math.min(1, saved.mappingLightFocus))
        : d.mappingLightFocus,
    mappingLightDecay:
      typeof saved.mappingLightDecay === "number"
        ? Math.max(0, Math.min(2, saved.mappingLightDecay))
        : d.mappingLightDecay,
    mappingLightColor:
      typeof saved.mappingLightColor === "string" &&
      /^#[0-9a-f]{6}$/i.test(saved.mappingLightColor)
        ? saved.mappingLightColor
        : d.mappingLightColor,
    flipUpDown: typeof saved.flipUpDown === "boolean" ? saved.flipUpDown : d.flipUpDown,
    flipLeftRight:
      typeof saved.flipLeftRight === "boolean" ? saved.flipLeftRight : d.flipLeftRight,
    reversed: typeof saved.reversed === "boolean" ? saved.reversed : d.reversed,
    mode: saved.mode === "mesh" || saved.mode === "ellipsoid" ? saved.mode : d.mode,
  };
}

/** Clamp a saved breath-modulation map into [-1, 1] per key. */
function resolveBreathModMap(input: unknown): Record<string, number> {
  if (!input || typeof input !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = Math.max(-1, Math.min(1, v));
    }
  }
  return out;
}

/** Seed the store from a localStorage snapshot if one exists. */
function initialState() {
  const saved = loadSnapshot();
  if (!saved) return DEFAULTS;
  const savedSky = (saved.sky ?? {}) as Partial<SkyParams> & {
    stops?: LegacyTriStop[];
    palette?: Record<string, unknown>;
  };
  const channels = resolveChannelStops(savedSky);
  return {
    ellipsoid: { ...DEFAULTS.ellipsoid, ...saved.ellipsoid },
    cloud: { ...DEFAULTS.cloud, ...saved.cloud },
    cloudTop: { ...DEFAULTS.cloudTop, ...(saved.cloudTop ?? {}) },
    strand: {
      ...DEFAULTS.strand,
      ...saved.strand,
      colorProfile: resolveLedColorProfile(saved.strand?.colorProfile),
    },
    ambient: { ...DEFAULTS.ambient, ...saved.ambient },
    directional: { ...DEFAULTS.directional, ...saved.directional },
    sky: {
      ...DEFAULTS.sky,
      ...savedSky,
      ...channels,
      cycleLocked: true,
    },
    // Don't auto-resume streaming on page load: if the user reopens the app
    // they probably don't want it immediately blasting UDP to the strip.
    wled: { ...DEFAULTS.wled, ...saved.wled, enabled: false },
    breath: resolveBreath(saved.breath),
    lightning: resolveLightning(saved.lightning),
    breathFilter: resolveBreathFilter(
      (saved as unknown as Record<string, unknown>).breathFilter,
    ),
    drone: resolveDroneParams(
      saved.drone as
        | (Partial<DroneParams> & Record<string, unknown>)
        | undefined,
    ),
    pad: resolvePadParams(
      saved.pad as
        | (Partial<PadParams> & Record<string, unknown>)
        | undefined,
    ),
    samples: resolveSamplesParams(
      saved.samples as
        | (Partial<SamplesParams> & Record<string, unknown>)
        | undefined,
    ),
    dayCycle: resolveDayCycle(saved.dayCycle),
    masterFx: resolveMasterFx(
      saved.masterFx as Partial<MasterFxParams> | undefined,
      saved.drone as Record<string, unknown> | undefined,
    ),
    breathMod: resolveBreathModMap(
      (saved as unknown as Record<string, unknown>).breathMod,
    ),
    breathModEnabled: (() => {
      const v = (saved as unknown as Record<string, unknown>).breathModEnabled;
      return typeof v === "boolean" ? v : DEFAULTS.breathModEnabled;
    })(),
    breathModRevealCeiling: (() => {
      const v = (saved as unknown as Record<string, unknown>)
        .breathModRevealCeiling;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return DEFAULTS.breathModRevealCeiling;
      }
      return Math.max(0.05, Math.min(1, v));
    })(),
    ledViewMode: normalizeLedViewMode(saved.ledViewMode),
    ledDisplayMode:
      saved.ledDisplayMode === "leds" || saved.ledDisplayMode === "sensors"
        ? saved.ledDisplayMode
        : DEFAULTS.ledDisplayMode,
    breathTimeCombineMode:
      saved.breathTimeCombineMode === "linearMix" ||
      saved.breathTimeCombineMode === "revealOnInhale"
        ? saved.breathTimeCombineMode
        : DEFAULTS.breathTimeCombineMode,
    ledStreamPipeline: {
      ...DEFAULTS.ledStreamPipeline,
      ...saved.ledStreamPipeline,
    },
    ledLocator: { ...DEFAULTS.ledLocator, ...saved.ledLocator },
    mapping: resolveMapping(saved.mapping),
    mesh: { ...DEFAULTS.mesh, ...(saved.mesh ?? {}) },
    ui: { ...DEFAULTS.ui, ...(saved.ui ?? {}) },
    audioSolo: null,
    audioMuted: { ...DEFAULTS.audioMuted },
  };
}

export const useSimStore = create<SimState>((set) => ({
  ...initialState(),
  setEllipsoid: (e) => set((s) => ({ ellipsoid: { ...s.ellipsoid, ...e } })),
  setCloud: (c) => set((s) => ({ cloud: { ...s.cloud, ...c } })),
  setCloudTop: (c) =>
    set((s) => ({ cloudTop: { ...s.cloudTop, ...c } })),
  setStrand: (st) => set((s) => ({ strand: { ...s.strand, ...st } })),
  setAmbient: (a) => set((s) => ({ ambient: { ...s.ambient, ...a } })),
  setDirectional: (d) =>
    set((s) => ({ directional: { ...s.directional, ...d } })),
  setSky: (sk) =>
    set((s) => {
      const { cycleLocked: _ignored, ...patch } = sk;
      if (s.sky.cycleLocked) delete patch.cycleSeconds;
      return { sky: { ...s.sky, ...patch } };
    }),
  setCycleLocked: (locked) =>
    set((s) => ({ sky: { ...s.sky, cycleLocked: locked } })),
  setWled: (w) => set((s) => ({ wled: { ...s.wled, ...w } })),
  setBreath: (b) =>
    set((s) => ({
      breath: resolveBreath({
        ...s.breath,
        ...b,
        participants: b.participants ?? s.breath.participants,
      }),
    })),
  setLightning: (l) => set((s) => ({ lightning: { ...s.lightning, ...l } })),
  setBreathFilter: (b) =>
    set((s) => ({
      breathFilter: resolveBreathFilter({ ...s.breathFilter, ...b }),
    })),
  setDrone: (d) => set((s) => ({ drone: { ...s.drone, ...d } })),
  addDroneNote: (note) =>
    set((s) => ({ drone: { ...s.drone, notes: [...s.drone.notes, note] } })),
  updateDroneNote: (id, patch) =>
    set((s) => ({
      drone: {
        ...s.drone,
        notes: s.drone.notes.map((n) =>
          n.id === id ? { ...n, ...patch } : n,
        ),
      },
    })),
  removeDroneNote: (id) =>
    set((s) => ({
      drone: { ...s.drone, notes: s.drone.notes.filter((n) => n.id !== id) },
    })),
  clearDroneNotes: () =>
    set((s) => ({ drone: { ...s.drone, notes: [] } })),
  setPad: (p) => set((s) => ({ pad: { ...s.pad, ...p } })),
  addPadNote: (note) =>
    set((s) => ({ pad: { ...s.pad, notes: [...s.pad.notes, note] } })),
  updatePadNote: (id, patch) =>
    set((s) => ({
      pad: {
        ...s.pad,
        notes: s.pad.notes.map((n) => (n.id === id ? { ...n, ...patch } : n)),
      },
    })),
  removePadNote: (id) =>
    set((s) => ({
      pad: { ...s.pad, notes: s.pad.notes.filter((n) => n.id !== id) },
    })),
  clearPadNotes: () => set((s) => ({ pad: { ...s.pad, notes: [] } })),
  setSamples: (p) => set((s) => ({ samples: { ...s.samples, ...p } })),
  addSample: (sample) =>
    set((s) => ({
      samples: { ...s.samples, library: [...s.samples.library, sample] },
    })),
  removeSample: (id) =>
    set((s) => ({
      samples: {
        ...s.samples,
        library: s.samples.library.filter((x) => x.id !== id),
        // Any clips referencing this sample become orphaned; drop them.
        clips: s.samples.clips.filter((c) => c.sampleId !== id),
      },
    })),
  updateSample: (id, patch) =>
    set((s) => ({
      samples: {
        ...s.samples,
        library: s.samples.library.map((x) => {
          if (x.id !== id) return x;
          const next = {
            ...x,
            filterHz: x.filterHz ?? DEFAULT_SAMPLE_TRACK.filterHz,
            automation: x.automation ?? {},
            ...patch,
          };
          const dur = Math.max(0, next.durationSec);
          const start = Math.max(
            0,
            Math.min(dur, next.trimStartSec ?? 0),
          );
          const end = Math.max(
            start,
            Math.min(dur, next.trimEndSec ?? dur),
          );
          return { ...next, trimStartSec: start, trimEndSec: end };
        }),
      },
    })),
  addSampleClip: (clip) =>
    set((s) => ({
      samples: { ...s.samples, clips: [...s.samples.clips, clip] },
    })),
  updateSampleClip: (id, patch) =>
    set((s) => ({
      samples: {
        ...s.samples,
        clips: s.samples.clips.map((c) =>
          c.id === id ? { ...c, ...patch } : c,
        ),
      },
    })),
  removeSampleClip: (id) =>
    set((s) => ({
      samples: {
        ...s.samples,
        clips: s.samples.clips.filter((c) => c.id !== id),
      },
    })),
  clearSampleClips: () =>
    set((s) => ({ samples: { ...s.samples, clips: [] } })),
  setDayCycle: (patch) =>
    set((s) => ({ dayCycle: { ...s.dayCycle, ...patch } })),
  setMasterFx: (patch) =>
    set((s) => ({ masterFx: { ...s.masterFx, ...patch } })),
  setBreathMod: (key, value) =>
    set((s) => {
      const next = { ...s.breathMod };
      const clamped = Math.max(-1, Math.min(1, value));
      if (Math.abs(clamped) < 1e-4) delete next[key];
      else next[key] = clamped;
      return { breathMod: next };
    }),
  setBreathModEnabled: (v) => set({ breathModEnabled: v }),
  setBreathModRevealCeiling: (v) =>
    set({
      breathModRevealCeiling: Math.max(
        0.05,
        Math.min(1, Number.isFinite(v) ? v : 1),
      ),
    }),
  updateDayPeriod: (id, patch) =>
    set((s) => ({
      dayCycle: {
        ...s.dayCycle,
        periods: s.dayCycle.periods.map((p) =>
          p.id === id ? { ...p, ...patch } : p,
        ),
      },
    })),
  setActivePeriod: (id) =>
    set((s) => {
      const target = s.dayCycle.periods.find((p) => p.id === id);
      if (!target) return {};
      // Snap the clock to the period's start so the loop begins there.
      return {
        dayCycle: { ...s.dayCycle, activePeriodId: id },
        sky: { ...s.sky, timeHours: target.startHour },
      };
    }),
  advancePeriod: () =>
    set((s) => {
      const idx = s.dayCycle.periods.findIndex(
        (p) => p.id === s.dayCycle.activePeriodId,
      );
      const next = s.dayCycle.periods[(idx + 1) % s.dayCycle.periods.length];
      if (!next) return {};
      return {
        dayCycle: { ...s.dayCycle, activePeriodId: next.id },
        sky: { ...s.sky, timeHours: next.startHour },
      };
    }),
  previousPeriod: () =>
    set((s) => {
      const n = s.dayCycle.periods.length;
      const idx = s.dayCycle.periods.findIndex(
        (p) => p.id === s.dayCycle.activePeriodId,
      );
      const prev = s.dayCycle.periods[(idx - 1 + n) % n];
      if (!prev) return {};
      return {
        dayCycle: { ...s.dayCycle, activePeriodId: prev.id },
        sky: { ...s.sky, timeHours: prev.startHour },
      };
    }),
  setLedViewMode: (mode) => set({ ledViewMode: mode }),
  setLedDisplayMode: (mode) => set({ ledDisplayMode: mode }),
  setBreathTimeCombineMode: (mode) => set({ breathTimeCombineMode: mode }),
  setLedStreamPipeline: (patch) =>
    set((s) => ({
      ledStreamPipeline: { ...s.ledStreamPipeline, ...patch },
    })),
  setLedLocator: (patch) =>
    set((s) => ({ ledLocator: { ...s.ledLocator, ...patch } })),
  toggleLocatedLed: (index) =>
    set((s) => {
      const i = Math.max(0, Math.floor(index));
      const exists = s.ledLocator.highlighted.includes(i);
      return {
        ledLocator: {
          ...s.ledLocator,
          highlighted: exists
            ? s.ledLocator.highlighted.filter((x) => x !== i)
            : [...s.ledLocator.highlighted, i],
        },
      };
    }),
  clearLocatedLeds: () =>
    set((s) => ({ ledLocator: { ...s.ledLocator, highlighted: [] } })),
  setMapping: (m) => set((s) => ({ mapping: { ...s.mapping, ...m } })),
  setMesh: (m) => set((s) => ({ mesh: { ...s.mesh, ...m } })),
  setUi: (u) => set((s) => ({ ui: { ...s.ui, ...u } })),
  setAudioSolo: (audioSolo) => set({ audioSolo }),
  setAudioMuted: (instrument, muted) =>
    set((s) => ({
      audioMuted: { ...s.audioMuted, [instrument]: muted },
    })),
  addMappedLed: (dir, pos, normal) =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        leds: [...s.mapping.leds, { dir, pos, normal, offset: 0 }],
      },
    })),
  moveMappedLed: (index, dir, pos, normal) =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        leds: s.mapping.leds.map((l, i) =>
          i === index ? { ...l, dir, pos, normal } : l,
        ),
      },
    })),
  updateMappedLed: (index, patch) =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        leds: s.mapping.leds.map((l, i) =>
          i === index ? { ...l, ...patch } : l,
        ),
      },
    })),
  removeLastMappedLed: () =>
    set((s) => ({
      mapping: { ...s.mapping, leds: s.mapping.leds.slice(0, -1) },
    })),
  clearMappedLeds: () =>
    set((s) => ({ mapping: { ...s.mapping, leds: [] } })),
  addMappingGaussian: (g) =>
    set((s) => {
      const id =
        g.id && typeof g.id === "string"
          ? g.id
          : `gaussian-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
      const next: MappingGaussian = {
        id,
        pos: g.pos,
        normal: g.normal,
        amplitude: Math.max(0, Math.min(0.5, g.amplitude)),
        width: Math.max(0.005, Math.min(0.5, g.width)),
        height: Math.max(0.005, Math.min(0.5, g.height)),
        rotationDeg: ((g.rotationDeg % 360) + 360) % 360,
      };
      return {
        mapping: {
          ...s.mapping,
          gaussians: [...(s.mapping.gaussians ?? []), next],
        },
      };
    }),
  updateMappingGaussian: (id, patch) =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        gaussians: (s.mapping.gaussians ?? []).map((g) => {
          if (g.id !== id) return g;
          const next = { ...g, ...patch, id: g.id };
          if (typeof next.amplitude === "number") {
            next.amplitude = Math.max(0, Math.min(0.5, next.amplitude));
          }
          if (typeof next.width === "number") {
            next.width = Math.max(0.005, Math.min(0.5, next.width));
          }
          if (typeof next.height === "number") {
            next.height = Math.max(0.005, Math.min(0.5, next.height));
          }
          if (typeof next.rotationDeg === "number") {
            next.rotationDeg = ((next.rotationDeg % 360) + 360) % 360;
          }
          return next;
        }),
      },
    })),
  removeMappingGaussian: (id) =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        gaussians: (s.mapping.gaussians ?? []).filter((g) => g.id !== id),
      },
    })),
  clearMappingBumps: () =>
    set((s) => ({
      mapping: {
        ...s.mapping,
        gaussians: [],
        leds: s.mapping.leds.map((l) => ({ ...l, offset: 0 })),
      },
    })),
}));

/**
 * Apply a previously-saved snapshot to the live store. Returns the values
 * we wrote so the leva controls (which keep their own state) can be
 * imperatively synced.
 */
export function applySnapshot(snap: Snapshot): Snapshot {
  const s = useSimStore.getState();
  s.setEllipsoid(snap.ellipsoid);
  s.setCloud(snap.cloud);
  s.setStrand({
    ...snap.strand,
    colorProfile: resolveLedColorProfile(snap.strand?.colorProfile),
  });
  s.setAmbient(snap.ambient);
  s.setDirectional(snap.directional);
  const snapSky = (snap.sky ?? {}) as Partial<SkyParams> & {
    stops?: LegacyTriStop[];
    palette?: Record<string, unknown>;
  };
  const channels = resolveChannelStops(snapSky);
  s.setCycleLocked(false);
  s.setSky({
    ...DEFAULTS.sky,
    ...snapSky,
    ...channels,
  });
  s.setCycleLocked(true);
  // Same caveat as initialState — never re-enable streaming via a load.
  s.setWled({ ...snap.wled, enabled: false });
  s.setBreath(resolveBreath(snap.breath));
  s.setLightning(resolveLightning(snap.lightning));
  s.setBreathFilter(resolveBreathFilter(snap.breathFilter));
  s.setDrone(
    resolveDroneParams(
      snap.drone as
        | (Partial<DroneParams> & Record<string, unknown>)
        | undefined,
    ),
  );
  s.setPad(
    resolvePadParams(
      snap.pad as
        | (Partial<PadParams> & Record<string, unknown>)
        | undefined,
    ),
  );
  s.setSamples(
    resolveSamplesParams(
      snap.samples as
        | (Partial<SamplesParams> & Record<string, unknown>)
        | undefined,
    ),
  );
  s.setDayCycle(resolveDayCycle(snap.dayCycle));
  s.setMasterFx(
    resolveMasterFx(
      snap.masterFx as Partial<MasterFxParams> | undefined,
      snap.drone as Record<string, unknown> | undefined,
    ),
  );
  // Full replace — setBreathMod is per-key and would leave stale entries.
  useSimStore.setState({
    breathMod: resolveBreathModMap(snap.breathMod),
    breathModEnabled:
      typeof snap.breathModEnabled === "boolean"
        ? snap.breathModEnabled
        : DEFAULTS.breathModEnabled,
    breathModRevealCeiling: (() => {
      const v = (snap as unknown as Record<string, unknown>)
        .breathModRevealCeiling;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return DEFAULTS.breathModRevealCeiling;
      }
      return Math.max(0.05, Math.min(1, v));
    })(),
  });
  s.setLedViewMode(normalizeLedViewMode(snap.ledViewMode));
  if (snap.ledDisplayMode === "leds" || snap.ledDisplayMode === "sensors") {
    s.setLedDisplayMode(snap.ledDisplayMode);
  } else {
    s.setLedDisplayMode(DEFAULTS.ledDisplayMode);
  }
  if (
    snap.breathTimeCombineMode === "linearMix" ||
    snap.breathTimeCombineMode === "revealOnInhale"
  ) {
    s.setBreathTimeCombineMode(snap.breathTimeCombineMode);
  } else {
    s.setBreathTimeCombineMode(DEFAULTS.breathTimeCombineMode);
  }
  s.setLedStreamPipeline({
    ...DEFAULTS.ledStreamPipeline,
    ...snap.ledStreamPipeline,
  });
  s.setLedLocator({ ...DEFAULTS.ledLocator, ...snap.ledLocator });
  s.setMapping(resolveMapping(snap.mapping));
  s.setMesh({ ...DEFAULTS.mesh, ...(snap.mesh ?? {}) });
  s.setCloudTop({ ...DEFAULTS.cloudTop, ...(snap.cloudTop ?? {}) });
  s.setUi({ ...DEFAULTS.ui, ...(snap.ui ?? {}) });
  return snap;
}

/** Snapshot of the persisted slice of the store. */
export function currentSnapshot(): Omit<Snapshot, "version"> {
  const s = useSimStore.getState();
  const {
    stops: _legacyStops,
    palette: _legacyPalette,
    ...sky
  } = s.sky as SkyParams & {
    stops?: LegacyTriStop[];
    palette?: Record<string, unknown>;
  };
  return {
    ellipsoid: s.ellipsoid,
    cloud: s.cloud,
    cloudTop: s.cloudTop,
    strand: s.strand,
    ambient: s.ambient,
    directional: s.directional,
    sky,
    wled: s.wled,
    breath: resolveBreath(s.breath),
    lightning: s.lightning,
    breathFilter: resolveBreathFilter(s.breathFilter),
    drone: s.drone,
    pad: s.pad,
    samples: s.samples,
    dayCycle: s.dayCycle,
    masterFx: s.masterFx,
    breathMod: s.breathMod,
    breathModEnabled: s.breathModEnabled,
    breathModRevealCeiling: s.breathModRevealCeiling,
    ledViewMode: s.ledViewMode,
    ledDisplayMode: s.ledDisplayMode,
    breathTimeCombineMode: s.breathTimeCombineMode,
    ledStreamPipeline: s.ledStreamPipeline,
    ledLocator: s.ledLocator,
    mapping: s.mapping,
    mesh: s.mesh,
    ui: s.ui,
  };
}

/**
 * Distance-based intensity multiplier for the directional light.
 *
 * A true three.js directional light is parallel rays from infinity, so
 * its `position` only controls the direction — moving it closer or
 * farther has no effect on brightness. We instead apply a softened
 * inverse-square falloff based on the light's distance to the origin so
 * the panel's `distance` slider does something visible.
 *
 *   atten(d) = REF² / (REF² + d²)        with REF = 5
 *
 * At the default light position (≈ 5.4 from origin) this is ≈ 0.46, so
 * sliding the distance lower brightens up to ≈ 1.0, and sliding higher
 * dims toward 0. Both the custom LED shading and the three.js light
 * that shades the (translucent) ellipsoid mesh use this same multiplier
 * so the two views stay consistent.
 */
const DIR_FALLOFF_REF_SQ = 25;
export function directionalDistanceFalloff(distance: number): number {
  return DIR_FALLOFF_REF_SQ / (DIR_FALLOFF_REF_SQ + distance * distance);
}
