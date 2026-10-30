import { CUSTOM_SWATCH_ID } from "./swatches";
import type { SkyChannel, SkyChannelStop } from "../state";

/**
 * Artistic reference colours for one pass through the day.
 * Dawn and dusk are different stops, not a reversed copy of each other.
 * Direct intensity is 1 for both the sun and the moon. Ambient and rim
 * intensities are separate and interpolate between these hours.
 */
export const ATMOSPHERIC_PERIODS = [
  {
    id: "dawn",
    hour: 5,
    direct: "#FFCA91",
    ambient: "#817FBE",
    rim: "#FFE3B4",
    directIntensity: 1,
    ambientIntensity: 0.7,
    rimIntensity: 0.45,
  },
  {
    id: "sunrise",
    hour: 6.75,
    direct: "#FFAA66",
    ambient: "#A09BCB",
    rim: "#FFE4AC",
    directIntensity: 1,
    ambientIntensity: 0.55,
    rimIntensity: 0.4,
  },
  {
    id: "daylight",
    hour: 12,
    direct: "#FFF2D8",
    ambient: "#9FBBD4",
    rim: "#FFFFFF",
    directIntensity: 1,
    ambientIntensity: 0.4,
    rimIntensity: 0.12,
  },
  {
    id: "goldenHour",
    hour: 17.25,
    direct: "#FFB35C",
    ambient: "#8275A9",
    rim: "#FFE1A0",
    directIntensity: 1,
    ambientIntensity: 0.6,
    rimIntensity: 0.5,
  },
  {
    id: "dusk",
    hour: 19.75,
    direct: "#FF795F",
    ambient: "#A16B9F",
    rim: "#FFB17F",
    directIntensity: 1,
    ambientIntensity: 0.75,
    rimIntensity: 0.42,
  },
  {
    id: "moonlight",
    hour: 0,
    direct: "#A6BCD9",
    ambient: "#485A85",
    rim: "#D6E4F4",
    directIntensity: 1,
    ambientIntensity: 0.28,
    rimIntensity: 0.25,
  },
] as const;

function stop(
  channel: SkyChannel,
  id: string,
  hour: number,
  color: string,
  intensity: number,
): SkyChannelStop {
  return {
    id: `${channel}-atmosphere-${id}`,
    timeHours: hour,
    swatchId: CUSTOM_SWATCH_ID,
    color,
    intensity,
  };
}

/** Stops for one channel of the atmospheric palette. */
export function buildAtmosphericChannelStops(channel: SkyChannel): SkyChannelStop[] {
  if (channel === "moon") {
    const night = ATMOSPHERIC_PERIODS.find((period) => period.id === "moonlight");
    return [
      stop(
        "moon",
        "moonlight",
        night?.hour ?? 0,
        night?.direct ?? "#A6BCD9",
        night?.directIntensity ?? 1,
      ),
    ];
  }
  const periods =
    channel === "sun"
      ? ATMOSPHERIC_PERIODS.filter((period) => period.id !== "moonlight")
      : ATMOSPHERIC_PERIODS;
  return periods.map((period) => {
    if (channel === "sun") {
      return stop("sun", period.id, period.hour, period.direct, period.directIntensity);
    }
    if (channel === "rim") {
      return stop("rim", period.id, period.hour, period.rim, period.rimIntensity);
    }
    return stop(
      "ambient",
      period.id,
      period.hour,
      period.ambient,
      period.ambientIntensity,
    );
  });
}
