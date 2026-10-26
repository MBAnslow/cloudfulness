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

function saturateHex(hex: string, amount: number): string {
  const [r8, g8, b8] = hexToRgb(hex);
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const sr = clamp01(l + (r - l) * amount);
  const sg = clamp01(l + (g - l) * amount);
  const sb = clamp01(l + (b - l) * amount);
  return rgbToHex(sr * 255, sg * 255, sb * 255);
}

function directionFromAzAlt(azimuthRad: number, altitudeRad: number): Vec3 {
  const c = Math.cos(altitudeRad);
  return [
    c * Math.cos(azimuthRad),
    Math.sin(altitudeRad),
    c * Math.sin(azimuthRad),
  ];
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

  // Use one continuous orbital angle for both horizontal + vertical motion.
  // The previous formulation derived altitude from `sin(phase)` and azimuth
  // from the same phase, which folds `cos(altitude)` into `|cos(phase)|` and
  // makes the trajectory appear to reverse around horizon crossings.
  const orbital = ((hour - 6) / 24) * TAU;
  const sunDirection: Vec3 = [Math.cos(orbital), Math.sin(orbital), 0];
  const solar = sunDirection[1];
  const altitudeDeg = (Math.asin(solar) * 180) / Math.PI;
  const moonDirection: Vec3 = [
    -sunDirection[0],
    -sunDirection[1],
    -sunDirection[2],
  ];

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

  // Clamp the altitude envelope, then scale: clamping after scaling made
  // Sun/Moon scale above ~0.9 / ~1.05 do nothing.
  const ambientIntensity = ambientBase * sky.ambientScale * vis;
  const sunIntensity = clamp01(sunBase) * Math.max(0, sky.sunScale) * 1.6 * vis;
  const moonIntensity = clamp01(moonBase) * Math.max(0, sky.moonScale) * 0.95 * vis;

  const ambientColorFinal = saturateHex(rawAmbientColor, 1.08 + twilight * 0.25);
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
  };
}
