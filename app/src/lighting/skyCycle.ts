import type { SkyChannelStop, SkyParams, Vec3 } from "../state";

export interface SkyLighting {
  ambientColor: string;
  ambientIntensity: number;
  /** Upper-hemisphere tint for the hemispheric sky term. */
  skyColor: string;
  /** Lower-hemisphere tint (warm at twilight, neutral otherwise). */
  groundColor: string;
  /** Energy for the hemispheric term; matches `ambientIntensity`. */
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  sunDirection: Vec3;
  moonColor: string;
  moonIntensity: number;
  moonDirection: Vec3;
  /** Grazing colour for the current hour. Unused while rim is disabled. */
  rimColor: string;
  /** Rim brightness on the sun-facing edge. 0 when rim is off or the moon leads. */
  rimSunIntensity: number;
  /** Rim brightness on the moon-facing edge. */
  rimMoonIntensity: number;
}

const TAU = Math.PI * 2;

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function smoothstep(a: number, b: number, x: number): number {
  if (x <= a) return 0;
  if (x >= b) return 1;
  const t = (x - a) / (b - a);
  return t * t * (3 - 2 * t);
}

function altitudeVisibility(
  altitudeDeg: number,
  startDeg: number,
  fullDeg: number,
): number {
  if (fullDeg <= startDeg) return altitudeDeg >= startDeg ? 1 : 0;
  return smoothstep(startDeg, fullDeg, altitudeDeg);
}

function normalizeHour(hour: number): number {
  const h = hour % 24;
  return h < 0 ? h + 24 : h;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.startsWith("#") ? hex.slice(1) : hex;
  const full = h.length === 3 ? `${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const rr = Math.round(r).toString(16).padStart(2, "0");
  const gg = Math.round(g).toString(16).padStart(2, "0");
  const bb = Math.round(b).toString(16).padStart(2, "0");
  return `#${rr}${gg}${bb}`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  return rgbToHex(
    lerp(ca[0], cb[0], t),
    lerp(ca[1], cb[1], t),
    lerp(ca[2], cb[2], t),
  );
}

function directionFromAzAlt(azimuthRad: number, altitudeRad: number): Vec3 {
  const c = Math.cos(altitudeRad);
  return [
    c * Math.cos(azimuthRad),
    Math.sin(altitudeRad),
    c * Math.sin(azimuthRad),
  ];
}

/** Equinox at a mid latitude. Noon stays near 40°, so the path arches. */
const SKY_LATITUDE_RAD = (50 * Math.PI) / 180;

/**
 * Sun rises in the east, arches across the sky, and sets in the west.
 * The moon takes the opposite point, so it arches across at night.
 */
export function skyBodyDirections(hour: number): {
  sunDirection: Vec3;
  moonDirection: Vec3;
  sunAltitudeDeg: number;
} {
  const ha = ((normalizeHour(hour) - 12) / 24) * TAU;
  const altitude = Math.asin(
    Math.max(-1, Math.min(1, Math.cos(SKY_LATITUDE_RAD) * Math.cos(ha))),
  );
  // +X at sunrise, −Z at noon, −X at sunset.
  const sunDirection = directionFromAzAlt(-ha - Math.PI / 2, altitude);
  return {
    sunDirection,
    moonDirection: [-sunDirection[0], -sunDirection[1], -sunDirection[2]],
    sunAltitudeDeg: (altitude * 180) / Math.PI,
  };
}

/**
 * Interpolate a single color channel from its list of stops at the
 * given hour. Stops are sorted by `timeHours` and the last stop is
 * virtually wrapped around to `first + 24` so midnight transitions are
 * continuous. If the list is empty a neutral fallback color is used.
 */
export function interpolateChannel(
  stops: SkyChannelStop[],
  hour: number,
  fallback = "#101828",
): string {
  if (stops.length === 0) return fallback;
  if (stops.length === 1) return stops[0].color;
  const sorted = [...stops].sort((a, b) => a.timeHours - b.timeHours);
  const h = normalizeHour(hour);
  let a: SkyChannelStop = sorted[sorted.length - 1];
  let b: SkyChannelStop = sorted[0];
  let aHour = a.timeHours - 24;
  let bHour = b.timeHours;
  if (h < sorted[0].timeHours) {
    a = sorted[sorted.length - 1];
    b = sorted[0];
    aHour = a.timeHours - 24;
    bHour = b.timeHours;
  } else if (h > sorted[sorted.length - 1].timeHours) {
    a = sorted[sorted.length - 1];
    b = sorted[0];
    aHour = a.timeHours;
    bHour = b.timeHours + 24;
  } else {
    for (let i = 0; i < sorted.length - 1; i++) {
      if (h >= sorted[i].timeHours && h <= sorted[i + 1].timeHours) {
        a = sorted[i];
        b = sorted[i + 1];
        aHour = sorted[i].timeHours;
        bHour = sorted[i + 1].timeHours;
        break;
      }
    }
  }
  const span = Math.max(1e-6, bHour - aHour);
  const t = clamp01((h - aHour) / span);
  return lerpHex(a.color, b.color, t);
}

/**
 * Interpolate an optional per-stop intensity. Returns null when no stop
 * carries one, so older timelines keep the altitude envelope.
 * A stop without `intensity` counts as 1 beside stops that have it.
 */
export function interpolateChannelIntensity(
  stops: SkyChannelStop[],
  hour: number,
): number | null {
  if (stops.length === 0) return null;
  if (!stops.some((stop) => typeof stop.intensity === "number")) return null;
  if (stops.length === 1) return Math.max(0, stops[0].intensity ?? 1);
  const sorted = [...stops].sort((a, b) => a.timeHours - b.timeHours);
  const h = normalizeHour(hour);
  let a: SkyChannelStop = sorted[sorted.length - 1];
  let b: SkyChannelStop = sorted[0];
  let aHour = a.timeHours - 24;
  let bHour = b.timeHours;
  if (h < sorted[0].timeHours) {
    a = sorted[sorted.length - 1];
    b = sorted[0];
    aHour = a.timeHours - 24;
    bHour = b.timeHours;
  } else if (h > sorted[sorted.length - 1].timeHours) {
    a = sorted[sorted.length - 1];
    b = sorted[0];
    aHour = a.timeHours;
    bHour = b.timeHours + 24;
  } else {
    for (let i = 0; i < sorted.length - 1; i++) {
      if (h >= sorted[i].timeHours && h <= sorted[i + 1].timeHours) {
        a = sorted[i];
        b = sorted[i + 1];
        aHour = sorted[i].timeHours;
        bHour = sorted[i + 1].timeHours;
        break;
      }
    }
  }
  const span = Math.max(1e-6, bHour - aHour);
  const t = clamp01((h - aHour) / span);
  return Math.max(0, lerp(a.intensity ?? 1, b.intensity ?? 1, t));
}

/**
 * Returns physically plausible sun/moon vectors, plus the three colors
 * from the current position along each channel's timeline. Sun and moon
 * are placed opposite each other on the sky dome; their intensity
 * envelopes are driven by solar altitude, not by the stops.
 */
export function computeSkyLighting(sky: SkyParams): SkyLighting {
  const hour = normalizeHour(sky.timeHours);
  const vis = clamp01(sky.visualizationAmount ?? 1);

  const rawSunColor = interpolateChannel(sky.sunStops, hour, "#05070d");
  const rawMoonColor = interpolateChannel(sky.moonStops, hour, "#b7c8ff");
  const rawAmbientColor = interpolateChannel(sky.ambientStops, hour, "#0c1734");
  const rawRimColor = interpolateChannel(sky.rimStops ?? [], hour, "#ffffff");
  const sunStopIntensity = interpolateChannelIntensity(sky.sunStops, hour);
  const moonStopIntensity = interpolateChannelIntensity(sky.moonStops, hour);
  const ambientStopIntensity = interpolateChannelIntensity(sky.ambientStops, hour);
  const rimStopIntensity = interpolateChannelIntensity(sky.rimStops ?? [], hour);

  const { sunDirection, moonDirection, sunAltitudeDeg } = skyBodyDirections(hour);
  const solar = sunDirection[1];
  const altitudeDeg = sunAltitudeDeg;

  const legacyStart = sky.horizonCutoffDeg ?? -7;
  const legacyFull = legacyStart + Math.max(0, sky.horizonSoftnessDeg ?? 0);
  const sunVisible = altitudeVisibility(
    altitudeDeg,
    sky.sunHorizonStartDeg ?? legacyStart,
    sky.sunHorizonFullDeg ?? legacyFull,
  );
  const moonVisible = altitudeVisibility(
    -altitudeDeg,
    sky.moonHorizonStartDeg ?? legacyStart,
    sky.moonHorizonFullDeg ?? legacyFull,
  );
  const twilight = Math.exp(-Math.pow(solar / 0.22, 2));
  const twilightSun = twilight * sunVisible;
  const twilightMoon = twilight * moonVisible;

  const ambientBase = 0.08 + 0.22 * clamp01((solar + 0.2) / 1.2);
  const sunBase = 1.1 * sunVisible + 0.35 * twilightSun;
  const moonBase = 0.75 * moonVisible + 0.2 * twilightMoon;

  // Stop intensity replaces the legacy 1.6 / 0.95 gains when a timeline
  // carries one. Older stops omit it, so those clouds stay as they were.
  // A palette direct intensity of 1 is therefore the full altitude envelope.
  const ambientIntensity =
    (ambientStopIntensity ?? ambientBase) * sky.ambientScale * vis;
  const sunIntensity =
    clamp01(sunBase) *
    Math.max(0, sky.sunScale) *
    (sunStopIntensity ?? 1.6) *
    vis;
  const moonIntensity =
    clamp01(moonBase) *
    Math.max(0, sky.moonScale) *
    (moonStopIntensity ?? 0.95) *
    vis;
  const rimLevel = sky.rimEnabled
    ? Math.max(0, rimStopIntensity ?? 1) * Math.max(0, sky.rimScale ?? 1) * vis
    : 0;
  // Follow whichever body is up. A hard split would pop at the horizon,
  // so the two rims crossfade only while sun and moon are both near it.
  const sunMix = smoothstep(-0.2, 0.2, sunVisible - moonVisible);

  const ambientColorFinal = rawAmbientColor;
  // Preserve user-selected sun/moon hue in LED output; intensity already
  // handles day/night dynamics so extra color boosting causes drift.
  const sunColorFinal = rawSunColor;
  // Ground tint: neutral cool at midday/night, biases toward the warm
  // sun color as the sun approaches the horizon. `twilight` already
  // peaks near sunrise/sunset, so it drives the mix directly.
  const groundColor = lerpHex("#0b0e14", sunColorFinal, clamp01(twilight * 0.9));

  return {
    ambientColor: ambientColorFinal,
    ambientIntensity,
    skyColor: ambientColorFinal,
    groundColor,
    hemiIntensity: ambientIntensity,
    sunColor: sunColorFinal,
    sunIntensity,
    sunDirection,
    moonColor: rawMoonColor,
    moonIntensity,
    moonDirection,
    rimColor: rawRimColor,
    rimSunIntensity: rimLevel * sunMix,
    rimMoonIntensity: rimLevel * (1 - sunMix),
  };
}
