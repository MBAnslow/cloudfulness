export interface LedColorProfile {
  brightnessGamma: number;
}

/**
 * Hue-preserving output brightness curve. Values above 1 pull the low
 * end down so a small intensity is actually dim on PWM LEDs. 2.2 matches
 * typical perceived brightness.
 */
export const DEFAULT_LED_COLOR_PROFILE: LedColorProfile = {
  brightnessGamma: 2.2,
};

/**
 * Older saves stored 1, which sent linear PWM. That leaves low mapping
 * intensities looking bright, so treat that exact default as unset.
 */
export function resolveLedColorProfile(
  saved?: Partial<LedColorProfile> | null,
): LedColorProfile {
  const gamma = saved?.brightnessGamma;
  if (typeof gamma !== "number" || !Number.isFinite(gamma) || gamma === 1) {
    return { ...DEFAULT_LED_COLOR_PROFILE };
  }
  return {
    brightnessGamma: Math.max(0.25, Math.min(3, gamma)),
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** sRGB code value in [0,1] to linear light. LED PWM follows linear light. */
export function srgbChannelToLinear(value: number): number {
  const v = clamp01(value);
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/**
 * Linear-light RGB in [0,1] to LED PWM bytes. The brightness curve scales
 * all channels together so the hue stays put. WS2812 PWM is linear, so
 * these bytes are linear light, not sRGB codes.
 */
export function encodeLedRgb(
  red: number,
  green: number,
  blue: number,
  profile: LedColorProfile,
): [number, number, number] {
  const r = clamp01(red);
  const g = clamp01(green);
  const b = clamp01(blue);
  const brightness = Math.max(r, g, b);
  if (brightness <= 1e-8) return [0, 0, 0];
  const correctedBrightness = Math.pow(
    brightness,
    resolveLedColorProfile(profile).brightnessGamma,
  );
  const scale = correctedBrightness / brightness;
  return [
    Math.round(clamp01(r * scale) * 255),
    Math.round(clamp01(g * scale) * 255),
    Math.round(clamp01(b * scale) * 255),
  ];
}

export function srgbByteToLinear(byte: number): number {
  return srgbChannelToLinear(byte / 255);
}

