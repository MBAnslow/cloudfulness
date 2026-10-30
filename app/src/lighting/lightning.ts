import type {
  EllipsoidParams,
  LightningAnimParams,
  LightningColorStop,
  LightningColorTracks,
  LightningKeyframe,
  LightningPalette,
  LightningParams,
} from "../state";
import {
  applyCloudTransform,
  inverseCloudTransform,
  type CloudTransform,
} from "../scene/cloudTransform";
import { hexToVec3 } from "./shade";
import { srgbChannelToLinear } from "./ledColor";
import {
  ensureSpriteImage,
  getCachedSpriteImage,
  sampleSpriteRgb,
} from "./spriteImageCache";

export interface BoltBranch {
  /** Flat [x,y,z,...] world-space branch polyline starting at the fork. */
  path: Float32Array;
  /** Relative brightness vs the main bolt, typically ~0.45–0.65. */
  strength: number;
  /**
   * Main-path vertex index where this branch forks. Used so the branch
   * only ignites once the main tip reaches that junction.
   */
  forkVertex: number;
}

/** In-cloud flash vs cloud-to-ground power strike. */
export type BoltKind = "cloud" | "strike";

export interface BoltStrike {
  bornMs: number;
  durationMs: number;
  kind: BoltKind;
  /** Flat [x0,y0,z0, x1,y1,z1, ...] world-space bolt polyline. */
  path: Float32Array;
  /** Weaker side branches spawned from interior main-path vertices. */
  branches: BoltBranch[];
  /**
   * Three RGB stops baked at spawn from a palette track
   * (main → highlight1 → highlight2). Interpolated across the flash.
   */
  colorStops: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ];
  /** Mean of the three palette colours, baked at spawn for tint blend. */
  paletteTint: [number, number, number];
  /**
   * Frozen [0,1] draw mapped through the birth intensityRange each frame
   * so the strike keeps a stable character as the storm timeline moves.
   */
  intensity01: number;
  /** Intensity range frozen at spawn from the storm timeline sample. */
  intensityRange: [number, number];
  /**
   * Peak intensity at birth (from birth intensityRange). Used for audio.
   */
  intensity: number;
  /** Per-strike bolt sample gain baked at spawn from timeline sample. */
  boltGain: number;
  /** Thunder delay (ms) baked at spawn from timeline sample. */
  thunderDelayMs: number;
  /** Stereo pan (−1…+1) baked at spawn from timeline sample. */
  pan: number;
}

/** Orthographic projection axis through the cloud AABB (sign = view direction). */
export type SpriteAxis = "x+" | "x-" | "y+" | "y-" | "z+" | "z-";

const SPRITE_AXES: SpriteAxis[] = ["x+", "x-", "y+", "y-", "z+", "z-"];

export interface SpriteFlash {
  bornMs: number;
  durationMs: number;
  sampleId: string;
  axis: SpriteAxis;
  gain: number;
  /** Live source-audio loudness, independent of the playback volume. */
  audioDynamics: number;
  strobeHz: number;
  strobeDuty: number;
}

function sampleRange(range: [number, number]): number {
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  if (hi <= lo) return lo;
  return lo + Math.random() * (hi - lo);
}

function rand(): number {
  return Math.random();
}

function vec3ToHex(v: [number, number, number]): string {
  const c = (x: number) =>
    Math.max(0, Math.min(255, Math.round(x * 255)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(v[0])}${c(v[1])}${c(v[2])}`;
}

function lerpHex(a: string, b: string, t: number): string {
  const A = hexToVec3(a);
  const B = hexToVec3(b);
  return vec3ToHex([
    A[0] + (B[0] - A[0]) * t,
    A[1] + (B[1] - A[1]) * t,
    A[2] + (B[2] - A[2]) * t,
  ]);
}

const DEFAULT_PALETTE: LightningPalette = ["#cfe7ff", "#a8c8ff", "#fff2c9"];

/**
 * Interpolate a lightning colour-stop timeline at storm progress `u`∈[0,1].
 * Non-wrapping: clamps to first/last stop outside the stop range.
 */
export function interpolateLightningColorStops(
  stops: LightningColorStop[],
  u: number,
  fallback = "#cfe7ff",
): string {
  if (!stops || stops.length === 0) return fallback;
  if (stops.length === 1) return stops[0].color;
  const sorted = [...stops].sort((a, b) => a.t - b.t);
  const uu = u < 0 ? 0 : u > 1 ? 1 : u;
  if (uu <= sorted[0].t) return sorted[0].color;
  const last = sorted[sorted.length - 1];
  if (uu >= last.t) return last.color;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (uu < a.t || uu > b.t) continue;
    const span = b.t - a.t;
    const t = span <= 1e-9 ? 0 : (uu - a.t) / span;
    return lerpHex(a.color, b.color, t);
  }
  return last.color;
}

/** Sample main + highlight colours for the default bolt at `u`. */
export function sampleLightningColorTracks(
  tracks: LightningColorTracks,
  u: number,
): LightningPalette {
  return [
    interpolateLightningColorStops(tracks.main, u, DEFAULT_PALETTE[0]),
    interpolateLightningColorStops(tracks.highlight1, u, DEFAULT_PALETTE[1]),
    interpolateLightningColorStops(tracks.highlight2, u, DEFAULT_PALETTE[2]),
  ];
}

/**
 * Bake main → hl1 → hl2 into RGB flash stops (order preserved so main
 * leads the strike and highlights carry mid/end motion).
 */
function paletteColorStops(
  palette: LightningPalette,
): [
  [number, number, number],
  [number, number, number],
  [number, number, number],
] {
  return [linearHex(palette[0]), linearHex(palette[1]), linearHex(palette[2])];
}

function linearHex(hex: string): [number, number, number] {
  const [r, g, b] = hexToVec3(hex);
  return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
}

function paletteTintRgb(
  palette: LightningPalette,
): [number, number, number] {
  const c0 = linearHex(palette[0]);
  const c1 = linearHex(palette[1]);
  const c2 = linearHex(palette[2]);
  return [
    (c0[0] + c1[0] + c2[0]) / 3,
    (c0[1] + c1[1] + c2[1]) / 3,
    (c0[2] + c1[2] + c2[2]) / 3,
  ];
}

/**
 * Interpolate through a 3-stop color ramp at u in [0,1]. u=0 -> stop0,
 * u=0.5 -> stop1, u=1 -> stop2. Linear between adjacent stops.
 */
function sampleColorRamp(
  stops: [
    [number, number, number],
    [number, number, number],
    [number, number, number],
  ],
  u: number,
): [number, number, number] {
  const uu = u < 0 ? 0 : u > 1 ? 1 : u;
  if (uu <= 0.5) {
    const t = uu * 2;
    const a = stops[0];
    const b = stops[1];
    return [
      a[0] + (b[0] - a[0]) * t,
      a[1] + (b[1] - a[1]) * t,
      a[2] + (b[2] - a[2]) * t,
    ];
  }
  const t = (uu - 0.5) * 2;
  const a = stops[1];
  const b = stops[2];
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

/**
 * Sample a random point within the ellipsoid while distributing samples
 * evenly by height. A uniform-volume sphere strongly favours its wide middle,
 * making flashes near the narrow cloud base/apex needlessly rare.
 */
function samplePointInEllipsoid(
  ellipsoid: EllipsoidParams,
  spanScale: number,
): [number, number, number] {
  const y = rand() * 2 - 1;
  const sliceRadius = Math.sqrt(Math.max(0, 1 - y * y));
  const radial = Math.sqrt(rand()) * sliceRadius;
  const angle = rand() * Math.PI * 2;
  return [
    Math.cos(angle) * radial * ellipsoid.rx * spanScale,
    y * ellipsoid.ry * spanScale,
    Math.sin(angle) * radial * ellipsoid.rz * spanScale,
  ];
}

/**
 * Generate a jagged 3D polyline between two random endpoints. Midpoints
 * are perturbed laterally (perpendicular to the endpoint-endpoint axis)
 * for a lightning-like silhouette.
 */
function sampleBoltPath(
  ellipsoid: EllipsoidParams,
  transform: CloudTransform,
  segments: number,
  jitter: number,
  spanScale: number,
  minSpanScale: number,
  sampleSurfacePoint?: () => [number, number, number] | null,
): Float32Array {
  const meanR = (ellipsoid.rx + ellipsoid.ry + ellipsoid.rz) / 3;
  const minLen = Math.max(0, minSpanScale) * meanR;
  const samplePoint = () =>
    sampleSurfacePoint?.() ?? samplePointInEllipsoid(ellipsoid, spanScale);
  let a = samplePoint();
  let b = samplePoint();
  // Resample until the endpoints are at least `minLen` apart so bolts
  // don't degenerate into a tiny spark. Bounded retries so a degenerate
  // ellipsoid or overly-strict minimum can't spin forever.
  for (let tries = 0; tries < 12; tries++) {
    const ddx = b[0] - a[0];
    const ddy = b[1] - a[1];
    const ddz = b[2] - a[2];
    if (ddx * ddx + ddy * ddy + ddz * ddz >= minLen * minLen) break;
    a = samplePoint();
    b = samplePoint();
  }
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  // Pick an arbitrary vector not parallel to d, then build two lateral basis
  // vectors u, v orthogonal to d for perpendicular jitter.
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  const helper: [number, number, number] =
    Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const ux = ny * helper[2] - nz * helper[1];
  const uy = nz * helper[0] - nx * helper[2];
  const uz = nx * helper[1] - ny * helper[0];
  const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  const ux2 = ux / uLen;
  const uy2 = uy / uLen;
  const uz2 = uz / uLen;
  const vx = ny * uz2 - nz * uy2;
  const vy = nz * ux2 - nx * uz2;
  const vz = nx * uy2 - ny * ux2;

  const count = Math.max(2, Math.floor(segments) + 1);
  const path = new Float32Array(count * 3);
  // High-frequency jaggedness (per-vertex noise).
  const lateral = jitter * len * 0.35;
  // Low-frequency wander so the bolt curves left/right/up/down along
  // its length rather than just zig-zagging along a straight axis.
  // Random amplitude, phase and 1..3 half-waves per bolt in each of
  // the two lateral basis directions.
  const waveAmpU = (rand() * 2 - 1) * jitter * len * 0.6;
  const waveAmpV = (rand() * 2 - 1) * jitter * len * 0.6;
  const waveFreqU = 1 + Math.floor(rand() * 3);
  const waveFreqV = 1 + Math.floor(rand() * 3);
  const wavePhaseU = rand() * Math.PI * 2;
  const wavePhaseV = rand() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    // Weight everything with sin(pi t) so endpoints stay anchored.
    const anchor = Math.sin(t * Math.PI);
    const w = anchor * lateral;
    const jitU = (rand() * 2 - 1) * w;
    const jitV = (rand() * 2 - 1) * w;
    const waveU = Math.sin(t * Math.PI * waveFreqU + wavePhaseU) * waveAmpU * anchor;
    const waveV = Math.sin(t * Math.PI * waveFreqV + wavePhaseV) * waveAmpV * anchor;
    const ru = jitU + waveU;
    const rv = jitV + waveV;
    const px = ax + dx * t + ux2 * ru + vx * rv;
    const py = ay + dy * t + uy2 * ru + vy * rv;
    const pz = az + dz * t + uz2 * ru + vz * rv;
    const world = applyCloudTransform([px, py, pz], transform);
    const idx = i * 3;
    path[idx] = world[0];
    path[idx + 1] = world[1];
    path[idx + 2] = world[2];
  }
  return path;
}

/**
 * Cloud-to-ground bolt: starts near the cloud apex and drives down to
 * ground below the cloud volume. Built in cloud-local space then
 * transformed so it tracks tilt/yaw/offset with the mesh.
 */
function sampleGroundStrikePath(
  ellipsoid: EllipsoidParams,
  transform: CloudTransform,
  segments: number,
  jitter: number,
): Float32Array {
  const rx = Math.max(1e-3, ellipsoid.rx);
  const ry = Math.max(1e-3, ellipsoid.ry);
  const rz = Math.max(1e-3, ellipsoid.rz);

  // Apex: near the top of the ellipsoid, slight lateral scatter.
  const topX = (rand() * 2 - 1) * rx * 0.35;
  const topY = ry * (0.82 + rand() * 0.16);
  const topZ = (rand() * 2 - 1) * rz * 0.35;

  // Ground: well below the cloud underside, offset laterally so the
  // bolt doesn't always drop straight down the axis.
  const groundX = topX + (rand() * 2 - 1) * rx * 0.55;
  const groundY = -ry * (1.35 + rand() * 0.55);
  const groundZ = topZ + (rand() * 2 - 1) * rz * 0.55;

  const ax = topX;
  const ay = topY;
  const az = topZ;
  const bx = groundX;
  const by = groundY;
  const bz = groundZ;
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
  const nx = dx / len;
  const ny = dy / len;
  const nz = dz / len;
  const helper: [number, number, number] =
    Math.abs(ny) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const ux = ny * helper[2] - nz * helper[1];
  const uy = nz * helper[0] - nx * helper[2];
  const uz = nx * helper[1] - ny * helper[0];
  const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  const ux2 = ux / uLen;
  const uy2 = uy / uLen;
  const uz2 = uz / uLen;
  const vx = ny * uz2 - nz * uy2;
  const vy = nz * ux2 - nx * uz2;
  const vz = nx * uy2 - ny * ux2;

  const count = Math.max(3, Math.floor(segments) + 1);
  const path = new Float32Array(count * 3);
  const lateral = jitter * len * 0.28;
  const waveAmpU = (rand() * 2 - 1) * jitter * len * 0.45;
  const waveAmpV = (rand() * 2 - 1) * jitter * len * 0.45;
  const waveFreqU = 1 + Math.floor(rand() * 3);
  const waveFreqV = 1 + Math.floor(rand() * 3);
  const wavePhaseU = rand() * Math.PI * 2;
  const wavePhaseV = rand() * Math.PI * 2;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const anchor = Math.sin(t * Math.PI);
    const w = anchor * lateral;
    const jitU = (rand() * 2 - 1) * w;
    const jitV = (rand() * 2 - 1) * w;
    const waveU =
      Math.sin(t * Math.PI * waveFreqU + wavePhaseU) * waveAmpU * anchor;
    const waveV =
      Math.sin(t * Math.PI * waveFreqV + wavePhaseV) * waveAmpV * anchor;
    const ru = jitU + waveU;
    const rv = jitV + waveV;
    const px = ax + dx * t + ux2 * ru + vx * rv;
    const py = ay + dy * t + uy2 * ru + vy * rv;
    const pz = az + dz * t + uz2 * ru + vz * rv;
    const world = applyCloudTransform([px, py, pz], transform);
    const idx = i * 3;
    path[idx] = world[0];
    path[idx + 1] = world[1];
    path[idx + 2] = world[2];
  }
  return path;
}

/**
 * Spawn weaker side branches off interior vertices of a main bolt path.
 * Each interior vertex forks independently with probability `branchProb`.
 */
function sampleBranches(
  mainPath: Float32Array,
  branchProb: number,
  jitter: number,
): BoltBranch[] {
  const p = Math.max(0, Math.min(1, branchProb));
  if (p <= 0) return [];
  const verts = mainPath.length / 3;
  if (verts < 3) return [];

  const remainingLenFrom = (startVert: number): number => {
    let total = 0;
    for (let i = startVert + 1; i < verts; i++) {
      const j = i * 3;
      const dx = mainPath[j] - mainPath[j - 3];
      const dy = mainPath[j + 1] - mainPath[j - 2];
      const dz = mainPath[j + 2] - mainPath[j - 1];
      total += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return total;
  };

  const branches: BoltBranch[] = [];
  // Skip endpoints so forks sit on "branching segments" of the stroke.
  for (let vi = 1; vi < verts - 1; vi++) {
    if (rand() >= p) continue;

    const i3 = vi * 3;
    const ox = mainPath[i3];
    const oy = mainPath[i3 + 1];
    const oz = mainPath[i3 + 2];

    // Local tangent along the main bolt at this vertex.
    const prev3 = (vi - 1) * 3;
    const next3 = (vi + 1) * 3;
    let tx = mainPath[next3] - mainPath[prev3];
    let ty = mainPath[next3 + 1] - mainPath[prev3 + 1];
    let tz = mainPath[next3 + 2] - mainPath[prev3 + 2];
    const tLen = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
    tx /= tLen;
    ty /= tLen;
    tz /= tLen;

    // Orthonormal lateral basis perpendicular to the tangent.
    const helper: [number, number, number] =
      Math.abs(ty) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let ux = ty * helper[2] - tz * helper[1];
    let uy = tz * helper[0] - tx * helper[2];
    let uz = tx * helper[1] - ty * helper[0];
    const uLen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= uLen;
    uy /= uLen;
    uz /= uLen;
    const vx = ty * uz - tz * uy;
    const vy = tz * ux - tx * uz;
    const vz = tx * uy - ty * ux;

    // Prefer a mostly lateral direction so the branch peels off the main.
    const sideU = rand() * 2 - 1;
    const sideV = rand() * 2 - 1;
    const sideN = Math.sqrt(sideU * sideU + sideV * sideV) || 1;
    const latU = sideU / sideN;
    const latV = sideV / sideN;
    // Mix a little forward so branches aren't perfectly perpendicular.
    const forward = 0.25 + rand() * 0.35;
    let dx = tx * forward + ux * latU * (1 - forward) + vx * latV * (1 - forward);
    let dy = ty * forward + uy * latU * (1 - forward) + vy * latV * (1 - forward);
    let dz = tz * forward + uz * latU * (1 - forward) + vz * latV * (1 - forward);
    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
    dx /= dLen;
    dy /= dLen;
    dz /= dLen;

    const remain = remainingLenFrom(vi);
    const branchLen = Math.max(0.05, remain * (0.25 + rand() * 0.2));
    const segs = 2 + Math.floor(rand() * 3); // 2..4
    const count = segs + 1;
    const path = new Float32Array(count * 3);
    const lateral = jitter * branchLen * 0.4;
    path[0] = ox;
    path[1] = oy;
    path[2] = oz;
    for (let k = 1; k < count; k++) {
      const t = k / (count - 1);
      const anchor = Math.sin(t * Math.PI);
      const w = anchor * lateral;
      const jitU = (rand() * 2 - 1) * w;
      const jitV = (rand() * 2 - 1) * w;
      path[k * 3] = ox + dx * branchLen * t + ux * jitU + vx * jitV;
      path[k * 3 + 1] = oy + dy * branchLen * t + uy * jitU + vy * jitV;
      path[k * 3 + 2] = oz + dz * branchLen * t + uz * jitU + vz * jitV;
    }

    branches.push({
      path,
      strength: 0.45 + rand() * 0.2,
      forkVertex: vi,
    });
  }
  return branches;
}

/**
 * Sum of segment lengths of a packed `[x, y, z, x, y, z, ...]` polyline
 * in world units. Returns 0 for a degenerate (0 or 1 vertex) path.
 */
function polylineLength(path: Float32Array): number {
  const verts = path.length / 3;
  if (verts < 2) return 0;
  let total = 0;
  for (let i = 1; i < verts; i++) {
    const j = i * 3;
    const dx = path[j] - path[j - 3];
    const dy = path[j + 1] - path[j - 2];
    const dz = path[j + 2] - path[j - 1];
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return total;
}

/**
 * Squared distance from point p to segment (a, b). Returns 0 if a == b.
 */
function pointSegmentDistSq(
  px: number,
  py: number,
  pz: number,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  const t = ab2 > 1e-9 ? (apx * abx + apy * aby + apz * abz) / ab2 : 0;
  const tc = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + abx * tc - px;
  const cy = ay + aby * tc - py;
  const cz = az + abz * tc - pz;
  return cx * cx + cy * cy + cz * cz;
}

/**
 * Fraction of the bolt polyline that is "lit" at `age` ms into the
 * flash. The tip races from the origin to the destination during the
 * first ~25% of the flash window, then stays fully deployed for the
 * remainder. Returns a value in [0, 1].
 */
export function boltTravelHead(age: number, durationMs: number): number {
  if (age < 0) return 0;
  const travelMs = Math.max(30, durationMs * 0.25);
  return Math.min(1, age / travelMs);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPair(
  a: [number, number],
  b: [number, number],
  t: number,
): [number, number] {
  const lo = lerp(a[0], b[0], t);
  const hi = lerp(a[1], b[1], t);
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

function cloneAnim(v: LightningAnimParams): LightningAnimParams {
  return {
    intensityRange: [v.intensityRange[0], v.intensityRange[1]],
    strikesPerMinute: v.strikesPerMinute,
    strikePerMinute: v.strikePerMinute,
    spritesPerMinute: v.spritesPerMinute ?? 0,
    spriteStrobeDutyRange: [
      v.spriteStrobeDutyRange?.[0] ?? 0.45,
      v.spriteStrobeDutyRange?.[1] ?? 0.45,
    ],
    subFlashes: v.subFlashes,
    spanScale: v.spanScale,
    minSpanScale: v.minSpanScale,
    boltGain: v.boltGain,
    spriteGain: v.spriteGain ?? 1,
    backgroundGain: v.backgroundGain,
    thunderDelayMs: v.thunderDelayMs,
    pan: v.pan,
  };
}

function lerpAnim(
  a: LightningAnimParams,
  b: LightningAnimParams,
  t: number,
): LightningAnimParams {
  const spanScale = lerp(a.spanScale, b.spanScale, t);
  const minSpanScale = Math.min(
    spanScale,
    lerp(a.minSpanScale, b.minSpanScale, t),
  );
  const spritesA = a.spritesPerMinute ?? 0;
  const spritesB = b.spritesPerMinute ?? 0;
  const spriteGainA = a.spriteGain ?? 1;
  const spriteGainB = b.spriteGain ?? 1;
  const dutyA = a.spriteStrobeDutyRange ?? [0.45, 0.45];
  const dutyB = b.spriteStrobeDutyRange ?? [0.45, 0.45];
  return {
    intensityRange: lerpPair(a.intensityRange, b.intensityRange, t),
    strikesPerMinute: lerp(a.strikesPerMinute, b.strikesPerMinute, t),
    strikePerMinute: lerp(a.strikePerMinute, b.strikePerMinute, t),
    spritesPerMinute: lerp(spritesA, spritesB, t),
    spriteStrobeDutyRange: lerpPair(dutyA, dutyB, t),
    subFlashes: Math.max(0, Math.min(1, lerp(a.subFlashes, b.subFlashes, t))),
    spanScale,
    minSpanScale,
    boltGain: lerp(a.boltGain, b.boltGain, t),
    spriteGain: lerp(spriteGainA, spriteGainB, t),
    backgroundGain: lerp(a.backgroundGain, b.backgroundGain, t),
    thunderDelayMs: lerp(a.thunderDelayMs, b.thunderDelayMs, t),
    pan: lerp(a.pan, b.pan, t),
  };
}

/**
 * Linearly interpolate animatable lightning snapshots at normalized
 * active-window progress `u` in [0, 1].
 */
export function sampleLightningKeyframe(
  keyframes: LightningKeyframe[],
  u: number,
): LightningAnimParams {
  if (!keyframes || keyframes.length === 0) {
    return {
      intensityRange: [0.9, 1.5],
      strikesPerMinute: 12,
      strikePerMinute: 1,
      spritesPerMinute: 1,
      spriteStrobeDutyRange: [0.3, 0.6],
      subFlashes: 0.4,
      spanScale: 0.85,
      minSpanScale: 0.5,
      boltGain: 0.8,
      spriteGain: 1.4,
      backgroundGain: 0.35,
      thunderDelayMs: 800,
      pan: 0,
    };
  }
  const uu = u < 0 ? 0 : u > 1 ? 1 : u;
  const sorted = [...keyframes].sort((a, b) => a.t - b.t);
  if (uu <= sorted[0].t) return cloneAnim(sorted[0].values);
  const last = sorted[sorted.length - 1];
  if (uu >= last.t) return cloneAnim(last.values);
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (uu < a.t || uu > b.t) continue;
    const span = b.t - a.t;
    const t = span <= 1e-9 ? 0 : (uu - a.t) / span;
    return lerpAnim(a.values, b.values, t);
  }
  return cloneAnim(last.values);
}

export function mapIntensity01(
  range: [number, number],
  intensity01: number,
): number {
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  const t = intensity01 < 0 ? 0 : intensity01 > 1 ? 1 : intensity01;
  return lo + (hi - lo) * t;
}

/**
 * Scalar channel extractor for the keyframe plot (normalized roughly to
 * a sensible display range per channel).
 */
export type LightningPlotChannel =
  | "intensity"
  | "strikesPerMinute"
  | "strikePerMinute"
  | "spritesPerMinute"
  | "subFlashes"
  | "span"
  | "boltGain"
  | "spriteGain"
  | "backgroundGain"
  | "thunderDelay"
  | "pan";

export function samplePlotChannel(
  keyframes: LightningKeyframe[],
  u: number,
  channel: LightningPlotChannel,
): number {
  const live = sampleLightningKeyframe(keyframes, u);
  switch (channel) {
    case "intensity":
      return (live.intensityRange[0] + live.intensityRange[1]) * 0.5;
    case "strikesPerMinute":
      return live.strikesPerMinute;
    case "strikePerMinute":
      return live.strikePerMinute;
    case "spritesPerMinute":
      return live.spritesPerMinute;
    case "subFlashes":
      return live.subFlashes;
    case "span":
      return (live.minSpanScale + live.spanScale) * 0.5;
    case "boltGain":
      return live.boltGain;
    case "spriteGain":
      return live.spriteGain;
    case "backgroundGain":
      return live.backgroundGain;
    case "thunderDelay":
      return live.thunderDelayMs / 1000;
    case "pan":
      // Map −1…+1 → 0…1 for the plot.
      return (live.pan + 1) * 0.5;
    default:
      return 0;
  }
}

/** For range channels, returns lo/hi; otherwise null (use scalar sample). */
export function samplePlotChannelRange(
  keyframes: LightningKeyframe[],
  u: number,
  channel: LightningPlotChannel,
): { lo: number; hi: number } | null {
  if (channel !== "intensity" && channel !== "span") return null;
  const live = sampleLightningKeyframe(keyframes, u);
  if (channel === "intensity") {
    const lo = Math.min(live.intensityRange[0], live.intensityRange[1]);
    const hi = Math.max(live.intensityRange[0], live.intensityRange[1]);
    return { lo, hi };
  }
  const lo = Math.min(live.minSpanScale, live.spanScale);
  const hi = Math.max(live.minSpanScale, live.spanScale);
  return { lo, hi };
}

export function isRangePlotChannel(channel: LightningPlotChannel): boolean {
  return channel === "intensity" || channel === "span";
}

/**
 * Intensity range at storm timeline progress `u` (defaults to peak stop
 * when `u` omitted — used for opacity normalisation).
 */
export function peakIntensityRange(
  keyframes: LightningKeyframe[],
  u?: number,
): [number, number] {
  if (typeof u === "number") {
    return sampleLightningKeyframe(keyframes, u).intensityRange;
  }
  // Fallback: brightest stop on the curve.
  if (!keyframes || keyframes.length === 0) return [0.9, 1.5];
  let best: [number, number] = [
    keyframes[0].values.intensityRange[0],
    keyframes[0].values.intensityRange[1],
  ];
  let bestMid =
    (Math.min(best[0], best[1]) + Math.max(best[0], best[1])) * 0.5;
  for (let i = 1; i < keyframes.length; i++) {
    const r = keyframes[i].values.intensityRange;
    const lo = Math.min(r[0], r[1]);
    const hi = Math.max(r[0], r[1]);
    const mid = (lo + hi) * 0.5;
    if (mid > bestMid) {
      bestMid = mid;
      best = [lo, hi];
    }
  }
  return [Math.min(best[0], best[1]), Math.max(best[0], best[1])];
}

/**
 * Per-flash brightness shape (independent of storm keyframes): fast
 * attack then exponential decay over the strike lifetime.
 */
function flashBrightness(u: number): number {
  const uu = u < 0 ? 0 : u > 1 ? 1 : u;
  const attack = 0.1;
  return uu < attack
    ? uu / attack
    : Math.exp((-4 * (uu - attack)) / (1 - attack));
}

export function plotChannelMax(channel: LightningPlotChannel): number {
  switch (channel) {
    case "intensity":
      return 3;
    case "strikesPerMinute":
    case "strikePerMinute":
    case "spritesPerMinute":
      return 40;
    case "subFlashes":
      return 1;
    case "span":
      return 1;
    case "boltGain":
    case "spriteGain":
    case "backgroundGain":
      return 3;
    case "thunderDelay":
      return 2;
    case "pan":
      return 1;
    default:
      return 1;
  }
}

/**
 * Light LEDs near a polyline path. `ageOffsetMs` delays ignition (used so
 * side branches only start once the main tip reaches their fork).
 * `strength` scales the RGB write relative to the main bolt.
 */
function accumulatePathContribution(
  positions: Float32Array,
  n: number,
  out: Float32Array,
  path: Float32Array,
  age: number,
  durationMs: number,
  ageOffsetMs: number,
  segTravel: number,
  strength: number,
  cr: number,
  cg: number,
  cb: number,
  invFalloff: number,
  cutoffSq: number,
): void {
  const localAge0 = age - ageOffsetMs;
  if (localAge0 < 0 || strength <= 0) return;
  const totalSegs = path.length / 3 - 1;
  if (totalSegs <= 0) return;
  const litSegs = Math.min(
    totalSegs,
    Math.ceil(localAge0 / Math.max(1e-3, segTravel)),
  );
  if (litSegs <= 0) return;

  const segEnv = new Float32Array(litSegs);
  const attack = 0.06;
  for (let seg = 0; seg < litSegs; seg++) {
    const arrival = ageOffsetMs + seg * segTravel;
    const localAge = age - arrival;
    const localLife = Math.max(1, durationMs - arrival);
    const lu = localAge / localLife;
    if (lu < 0 || lu > 1) {
      segEnv[seg] = 0;
      continue;
    }
    segEnv[seg] =
      lu < attack
        ? lu / attack
        : Math.exp((-3.5 * (lu - attack)) / (1 - attack));
  }

  const sr = cr * strength;
  const sg = cg * strength;
  const sb = cb * strength;

  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const px = positions[i3];
    const py = positions[i3 + 1];
    const pz = positions[i3 + 2];
    let acc = 0;
    for (let seg = 0; seg < litSegs; seg++) {
      const e = segEnv[seg];
      if (e <= 1e-3) continue;
      const a3 = seg * 3;
      const b3 = a3 + 3;
      const d2 = pointSegmentDistSq(
        px,
        py,
        pz,
        path[a3],
        path[a3 + 1],
        path[a3 + 2],
        path[b3],
        path[b3 + 1],
        path[b3 + 2],
      );
      if (d2 >= cutoffSq) continue;
      const prox = Math.exp(-Math.sqrt(d2) * invFalloff);
      acc += e * prox;
    }
    if (acc <= 0) continue;
    const k = acc > 1 ? 1 + Math.log(acc) * 0.35 : acc;
    out[i3] += sr * k;
    out[i3 + 1] += sg * k;
    out[i3 + 2] += sb * k;
  }
}

/**
 * Map a cloud-local point onto [0,1]×[0,1] UV for orthographic projection
 * along `axis` through the ellipsoid AABB.
 */
function spriteUv(
  local: [number, number, number],
  axis: SpriteAxis,
  rx: number,
  ry: number,
  rz: number,
): [number, number] {
  const nx = (local[0] / Math.max(1e-6, rx) + 1) * 0.5;
  const ny = (local[1] / Math.max(1e-6, ry) + 1) * 0.5;
  const nz = (local[2] / Math.max(1e-6, rz) + 1) * 0.5;
  switch (axis) {
    case "x+":
      return [nz, ny];
    case "x-":
      return [1 - nz, ny];
    case "y+":
      return [nx, 1 - nz];
    case "y-":
      return [nx, nz];
    case "z+":
      return [nx, ny];
    case "z-":
      return [1 - nx, ny];
  }
}

function spriteStrobeOn(
  ageMs: number,
  hz: number,
  duty: number,
): boolean {
  if (hz <= 0) return true;
  const phase = (ageMs / 1000) * hz;
  const frac = phase - Math.floor(phase);
  return frac < duty;
}

/** Shared visual/audio gain envelope for one sprite event. */
export function spriteFlashEnvelope(sprite: SpriteFlash, nowMs: number): number {
  const age = nowMs - sprite.bornMs;
  if (age < 0 || age > sprite.durationMs || sprite.durationMs <= 0) return 0;
  if (!spriteStrobeOn(age, sprite.strobeHz, sprite.strobeDuty)) return 0;
  return flashBrightness(age / sprite.durationMs);
}

/**
 * Stateful controller that maintains active strikes and produces a
 * per-LED additive RGB contribution each frame.
 */
export class LightningController {
  private strikes: BoltStrike[] = [];
  private sprites: SpriteFlash[] = [];
  private lastUpdateMs = 0;
  /** Fractional expected cloud-flash accumulator. */
  private spawnAcc = 0;
  /** Fractional expected cloud-to-ground strike accumulator. */
  private spawnAccStrike = 0;
  /** Fractional expected sprite-flash accumulator. */
  private spawnAccSprite = 0;
  private manualCloud = 0;
  private manualStrike = 0;
  private manualSprite = 0;

  requestManualTrigger(kind: "cloud" | "strike" | "sprite"): void {
    if (kind === "cloud") this.manualCloud += 1;
    else if (kind === "strike") this.manualStrike += 1;
    else this.manualSprite += 1;
  }

  hasManualTriggers(): boolean {
    return this.manualCloud > 0 || this.manualStrike > 0 || this.manualSprite > 0;
  }

  getStrikes(): BoltStrike[] {
    return this.strikes;
  }

  getSprites(): SpriteFlash[] {
    return this.sprites;
  }

  /** Timestamp of the last `update` tick; 0 before the first tick. */
  getLastUpdateMs(): number {
    return this.lastUpdateMs;
  }

  /**
   * Keep the spawn clock current without accruing strikes — call when
   * lightning is enabled but outside its active hour window (or when
   * the simulator is paused) so re-entry doesn't catch up a backlog.
   */
  pauseClock(nowMs: number): void {
    this.lastUpdateMs = nowMs;
    this.spawnAcc = 0;
    this.spawnAccStrike = 0;
    this.spawnAccSprite = 0;
  }

  update(
    nowMs: number,
    params: LightningParams,
    ellipsoid: EllipsoidParams,
    transform: CloudTransform,
    /** Progress through the active window, [0, 1]. */
    keyframeU: number,
    /** Optional area-uniform sampler for the actual uploaded mesh surface. */
    sampleSurfacePoint?: () => [number, number, number] | null,
  ): void {
    // Prune expired strikes / sprites.
    if (this.strikes.length > 0) {
      this.strikes = this.strikes.filter(
        (s) => nowMs - s.bornMs <= s.durationMs,
      );
    }
    if (this.sprites.length > 0) {
      this.sprites = this.sprites.filter(
        (s) => nowMs - s.bornMs <= s.durationMs,
      );
    }

    if (this.lastUpdateMs === 0) this.lastUpdateMs = nowMs;
    const dtMs = Math.max(0, nowMs - this.lastUpdateMs);
    this.lastUpdateMs = nowMs;

    const manualCloud = this.manualCloud;
    const manualStrike = this.manualStrike;
    const manualSprite = this.manualSprite;
    this.manualCloud = 0;
    this.manualStrike = 0;
    this.manualSprite = 0;
    const automaticEnabled = params.enabled;

    if (!automaticEnabled) {
      this.spawnAcc = 0;
      this.spawnAccStrike = 0;
      this.spawnAccSprite = 0;
    }

    // Warm sprite image cache for uploaded library entries.
    for (const s of params.spriteSamples ?? []) {
      void ensureSpriteImage(s.id);
    }

    // Storm keyframes track the sky timeline within the active window
    // (which value of SPM to use). Accrual itself is always real
    // wall-clock time via performance.now() — not sky/sim minutes.
    const live = sampleLightningKeyframe(params.keyframes, keyframeU);
    const cloudSpm = Number.isFinite(live.strikesPerMinute)
      ? Math.max(0, Math.min(40, live.strikesPerMinute))
      : Math.max(0, Math.min(40, Number(params.strikesPerMinute) || 0));
    const groundSpm = Number.isFinite(live.strikePerMinute)
      ? Math.max(0, Math.min(40, live.strikePerMinute))
      : Math.max(0, Math.min(40, Number(params.strikePerMinute) || 0));
    const spriteSpm = Number.isFinite(live.spritesPerMinute)
      ? Math.max(0, Math.min(40, live.spritesPerMinute))
      : Math.max(0, Math.min(40, Number(params.spritesPerMinute) || 0));

    const spawnCount = (acc: number, spm: number): { next: number; n: number } => {
      const ratePerMs = spm / 60_000;
      let next = Math.min(8, acc + ratePerMs * dtMs);
      let n = 0;
      while (next >= 1) {
        n += 1;
        next -= 1;
      }
      return { next, n };
    };

    const cloud = automaticEnabled
      ? spawnCount(this.spawnAcc, cloudSpm)
      : { next: 0, n: 0 };
    this.spawnAcc = cloud.next;
    const ground = automaticEnabled
      ? spawnCount(this.spawnAccStrike, groundSpm)
      : { next: 0, n: 0 };
    this.spawnAccStrike = ground.next;
    const spriteN =
      automaticEnabled && (params.spriteSamples?.length ?? 0) > 0
        ? spawnCount(this.spawnAccSprite, spriteSpm)
        : { next: 0, n: 0 };
    this.spawnAccSprite = spriteN.next;

    const segs = Math.max(2, Math.floor(params.boltSegments));
    for (let i = 0; i < cloud.n + manualCloud; i++) {
      this.pushStrike(
        nowMs,
        params,
        live,
        ellipsoid,
        transform,
        segs,
        "cloud",
        keyframeU,
        sampleSurfacePoint,
      );
    }
    for (let i = 0; i < ground.n + manualStrike; i++) {
      this.pushStrike(
        nowMs,
        params,
        live,
        ellipsoid,
        transform,
        segs,
        "strike",
        keyframeU,
        sampleSurfacePoint,
      );
    }
    for (let i = 0; i < spriteN.n + manualSprite; i++) {
      this.pushSprite(nowMs, params, live);
    }
  }

  private pushSprite(
    nowMs: number,
    params: LightningParams,
    live: LightningAnimParams,
  ): void {
    const library = params.spriteSamples ?? [];
    if (library.length === 0) return;
    const pick = library[Math.floor(rand() * library.length)]!;
    void ensureSpriteImage(pick.id);
    const axis = SPRITE_AXES[Math.floor(rand() * SPRITE_AXES.length)]!;
    const durationMs = Math.max(
      20,
      Math.min(3000, Number(params.spriteDurationMs) || 180),
    );
    const strobeHz = Math.max(
      1,
      Math.min(60, Number(params.spriteStrobeHz) || 18),
    );
    const dutyRange = live.spriteStrobeDutyRange ?? [
      params.spriteStrobeDuty,
      params.spriteStrobeDuty,
    ];
    const strobeDuty = Math.max(0.05, Math.min(0.95, sampleRange(dutyRange)));
    const gain = Math.max(0, live.spriteGain ?? params.spriteGain ?? 1);
    this.sprites.push({
      bornMs: nowMs,
      durationMs,
      sampleId: pick.id,
      axis,
      gain,
      audioDynamics: 1,
      strobeHz,
      strobeDuty,
    });
  }

  private pushStrike(
    nowMs: number,
    params: LightningParams,
    live: LightningAnimParams,
    ellipsoid: EllipsoidParams,
    transform: CloudTransform,
    segs: number,
    kind: BoltKind,
    keyframeU: number,
    sampleSurfacePoint?: () => [number, number, number] | null,
  ): void {
    const jitter = Math.max(0, sampleRange(params.boltJitterRange));
    const intensity01 = rand();
    // Ground strikes hit harder: boost the sampled intensity range.
    const force = kind === "strike" ? 1.85 : 1;
    const intensityRange: [number, number] = [
      live.intensityRange[0] * force,
      live.intensityRange[1] * force,
    ];
    const intensity = Math.max(0, mapIntensity01(intensityRange, intensity01));
    const spanHi = Math.max(0.05, Math.min(1, live.spanScale));
    const spanLo = Math.max(0, Math.min(spanHi, live.minSpanScale));
    const path =
      kind === "strike"
        ? sampleGroundStrikePath(ellipsoid, transform, segs + 4, jitter)
        : sampleBoltPath(
            ellipsoid,
            transform,
            segs,
            jitter,
            spanHi,
            spanLo,
            sampleSurfacePoint,
          );
    // Flash duration is derived from the actual polyline length and a
    // per-strike sampled travel speed. Longer bolts and slower speeds
    // → longer flashes. The `* 4` keeps the existing 25% travel /
    // 75% fade envelope split intact.
    // Ground strikes travel faster (more "force") but are much longer,
    // so the flash still reads as a powerful event.
    const speedBase = Math.max(0.05, sampleRange(params.travelSpeedRange));
    const speed = kind === "strike" ? speedBase * 2.2 : speedBase;
    const pathLen = polylineLength(path);
    const travelMsRaw = (pathLen / speed) * 1000;
    const duration = Math.max(30, travelMsRaw * 4);
    const branchProb = Math.max(0, Math.min(1, live.subFlashes));
    // Ground strikes branch a bit less often — force is in the trunk + flood.
    const branches = sampleBranches(
      path,
      kind === "strike" ? branchProb * 0.55 : branchProb,
      jitter,
    );
    const boltGain =
      Math.max(0, live.boltGain) * (kind === "strike" ? 1.6 : 1);
    const palette = sampleLightningColorTracks(params.colors, keyframeU);
    this.strikes.push({
      bornMs: nowMs,
      durationMs: duration,
      kind,
      path,
      branches,
      colorStops: paletteColorStops(palette),
      paletteTint: paletteTintRgb(palette),
      intensity01,
      intensityRange,
      intensity,
      boltGain,
      thunderDelayMs: Math.max(0, Math.min(2000, live.thunderDelayMs)),
      pan: Math.max(-1, Math.min(1, live.pan)),
    });
  }

  /**
   * Additively write per-LED RGB contribution into `out`.
   * Also zeroes `out` first so callers don't have to.
   */
  contribute(
    positions: Float32Array,
    n: number,
    out: Float32Array,
    nowMs: number,
    params: LightningParams,
    ellipsoid: EllipsoidParams,
    transform: CloudTransform,
  ): void {
    out.fill(0);
    const hasBolts = this.strikes.length > 0;
    const hasSprites = this.sprites.length > 0;
    if (!hasBolts && !hasSprites) return;

    if (hasBolts) {
      for (const s of this.strikes) {
        const age = nowMs - s.bornMs;
        if (age < 0 || age > s.durationMs) continue;
        const path = s.path;
        const totalSegs = path.length / 3 - 1;
        if (totalSegs <= 0) continue;

        const u = age / s.durationMs;
        // Ground strikes remain path-local. They get a modestly wider halo
        // than in-cloud flashes, but never a whole-cloud wash.
        const baseFall = Math.max(1e-4, Math.min(0.2, params.falloffDistance));
        const falloff =
          s.kind === "strike" ? Math.min(0.3, baseFall * 1.5) : baseFall;
        const invFalloff = 1 / falloff;
        const cutoff = 5.5 * falloff;
        const cutoffSq = cutoff * cutoff;

        // Progressive travel: the tip races along the polyline during the
        // first ~25% of the flash. Each segment "ignites" as the tip enters
        // it and then fades independently until the strike expires.
        const travelMs = Math.max(30, s.durationMs * 0.25);
        const segTravel = travelMs / totalSegs;

        const peak =
          mapIntensity01(s.intensityRange, s.intensity01) * flashBrightness(u);
        const strikeGain = Math.max(0, peak);
        const rampColor = sampleColorRamp(s.colorStops, u);
        const tint = s.paletteTint;
        const cr0 = rampColor[0] * 0.55 + tint[0] * 0.45;
        const cg0 = rampColor[1] * 0.55 + tint[1] * 0.45;
        const cb0 = rampColor[2] * 0.55 + tint[2] * 0.45;
        const cr = cr0 * strikeGain;
        const cg = cg0 * strikeGain;
        const cb = cb0 * strikeGain;

        accumulatePathContribution(
          positions,
          n,
          out,
          path,
          age,
          s.durationMs,
          0,
          segTravel,
          s.kind === "strike" ? 1.35 : 1,
          cr,
          cg,
          cb,
          invFalloff,
          cutoffSq,
        );

        for (const branch of s.branches) {
          const forkDelay = branch.forkVertex * segTravel;
          if (age < forkDelay) continue;
          const branchSegs = branch.path.length / 3 - 1;
          if (branchSegs <= 0) continue;
          const branchSegTravel = segTravel;
          accumulatePathContribution(
            positions,
            n,
            out,
            branch.path,
            age,
            s.durationMs,
            forkDelay,
            branchSegTravel,
            branch.strength,
            cr,
            cg,
            cb,
            invFalloff,
            cutoffSq,
          );
        }
      }
    }

    if (hasSprites) {
      const rx = Math.max(1e-6, ellipsoid.rx);
      const ry = Math.max(1e-6, ellipsoid.ry);
      const rz = Math.max(1e-6, ellipsoid.rz);
      for (const sp of this.sprites) {
        const age = nowMs - sp.bornMs;
        if (age < 0 || age > sp.durationMs) continue;
        const visualEnvelope =
          params.spriteAudioReactiveBrightness &&
          (params.spriteAudioSamples?.length ?? 0) > 0
          ? Math.max(0, Math.min(1, sp.audioDynamics))
          : spriteFlashEnvelope(sp, nowMs);
        if (visualEnvelope <= 1e-4) continue;
        const img = getCachedSpriteImage(sp.sampleId);
        if (!img) {
          void ensureSpriteImage(sp.sampleId);
          continue;
        }
        const env = visualEnvelope * sp.gain;
        if (env <= 1e-4) continue;
        for (let i = 0; i < n; i++) {
          const i3 = i * 3;
          const world: [number, number, number] = [
            positions[i3]!,
            positions[i3 + 1]!,
            positions[i3 + 2]!,
          ];
          const local = inverseCloudTransform(world, transform);
          const [uu, vv] = spriteUv(local, sp.axis, rx, ry, rz);
          const rgb = sampleSpriteRgb(
            img,
            Math.max(0, Math.min(1, uu)),
            Math.max(0, Math.min(1, vv)),
          );
          if (!rgb) continue;
          out[i3] += rgb[0] * env;
          out[i3 + 1] += rgb[1] * env;
          out[i3 + 2] += rgb[2] * env;
        }
      }
    }
  }

  /**
   * Envelope value at `nowMs` for a given strike, used for 3D visualisation
   * opacity so the drawn bolt fades along the same curve as the LEDs.
   */
  strikeEnvelope(
    strike: BoltStrike,
    nowMs: number,
  ): number {
    const age = nowMs - strike.bornMs;
    if (age < 0 || age > strike.durationMs || strike.durationMs <= 0) return 0;
    const u = age / strike.durationMs;
    const peak =
      mapIntensity01(strike.intensityRange, strike.intensity01) *
      flashBrightness(u);
    return Math.max(0, peak);
  }

  /**
   * Effective color for a strike at `nowMs`, matched to contribute.
   */
  strikeColor(
    strike: BoltStrike,
    nowMs: number,
  ): [number, number, number] {
    const age = nowMs - strike.bornMs;
    const u = strike.durationMs > 0 ? age / strike.durationMs : 0;
    const rampColor = sampleColorRamp(strike.colorStops, u);
    const tint = strike.paletteTint;
    return [
      rampColor[0] * 0.55 + tint[0] * 0.45,
      rampColor[1] * 0.55 + tint[1] * 0.45,
      rampColor[2] * 0.55 + tint[2] * 0.45,
    ];
  }
}

/**
 * Module-scoped controller shared between the LED shading pipeline and
 * the 3D bolt visualisation so both see the same active strikes.
 */
export const sharedLightningController = new LightningController();
