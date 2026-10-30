import type { Vec3 } from "../state";

export interface ShadeLightAmbient {
  type: "ambient";
  color: Vec3;
  intensity: number;
}

export interface ShadeLightDirectional {
  type: "directional";
  /** Unit-length direction *from the LED to the light*. */
  direction: Vec3;
  color: Vec3;
  intensity: number;
  /**
   * Angular spread of the light in [0, 1]. See `DirectionalLightParams.spread`
   * for semantics. 0 = narrow / flat Lambert, 1 = broad / half-Lambert wrap.
   */
  spread: number;
  /** Optional per-LED direct-light transmission, indexed by LED. */
  transmission?: Float32Array;
}

export interface ShadeLightPoint {
  type: "point";
  position: Vec3;
  color: Vec3;
  intensity: number;
  /**
   * Distance decay exponent, matching three.js `<pointLight>.decay`:
   * attenuation ~ 1 / max(d^decay, eps). Use `2` for physical inverse
   * square.
   */
  decay: number;
  /**
   * Cutoff distance (like three.js `<pointLight>.distance`). When > 0
   * the attenuation is multiplied by a smooth window that reaches 0 at
   * this distance. Set to 0 for unbounded.
   */
  distance: number;
  /** Same semantics as the directional light's `spread`. */
  spread: number;
  /** Optional spotlight target. Omit for an omnidirectional point source. */
  target?: Vec3;
  /** Spotlight outer half-angle in radians. */
  coneAngle?: number;
  /** Fraction of the cone edge used for smooth falloff, in [0, 1]. */
  penumbra?: number;
  /** Optional multiplier for LEDs near the top of the mapped cloud. */
  topHighlightBoost?: number;
  /** Strength of that multiplier for the current light angle. */
  topHighlightFactor?: number;
  /** Optional per-LED direct-light transmission, indexed by LED. */
  transmission?: Float32Array;
}

export interface ShadeLightHemisphere {
  type: "hemisphere";
  /** Upper-hemisphere tint (contributes as `normal.y → +1`). */
  skyColor: Vec3;
  /** Lower-hemisphere tint (contributes as `normal.y → −1`). */
  groundColor: Vec3;
  intensity: number;
}

/**
 * Backlight on the cloud outline when this light is behind it.
 * Direction is the sun or moon, not the camera. Width is how thick
 * the silhouette band is; it does not fill the body of the cloud.
 */
export interface ShadeLightRim {
  type: "rim";
  /** Unit direction from the LED toward the sun or moon. */
  direction: Vec3;
  color: Vec3;
  intensity: number;
  width: number;
  /** Optional per-LED occlusion. Buried LEDs keep their shadow. */
  transmission?: Float32Array;
}

export type ShadeLight =
  | ShadeLightAmbient
  | ShadeLightDirectional
  | ShadeLightPoint
  | ShadeLightHemisphere
  | ShadeLightRim;

/**
 * Cosine exponent at `spread = 0` — the tightest the spot beam can get.
 * Mapped exponentially with `N(β) = NARROW_EXPONENT^(1 − β)` so the
 * middle of the slider feels like a moderate spot rather than already
 * extreme. Half-angles (where direct = 0.5):
 *   N =  1 (β = 1) → 60°  (linear Lambert, broad)
 *   N = ~2.4 (β = 0.5) → wide, gradual
 *   N =  6 (β = 0) → a soft directional lobe, not a few-degree spike
 */
const NARROW_EXPONENT = 6;

/**
 * Per-LED irradiance from a single light, parameterised by the light's
 * angular spread (β) and the cloud's opacity (α).
 *
 *   N(β)      = NARROW_EXPONENT^(1 − β)                   // 1 … N_max, exponential
 *   direct(c) = max(0, c)^N(β)                            // Phong-style direct lobe
 *   wrap(c)   = (1 + c) / 2 − max(0, c)                   // ≥ 0, peaks at c = 0
 *   shade(c, β, α) = direct(c) + β · (1 − α) · wrap(c)
 *
 * Where c = n · ℓ̂ is the cosine of the angle between the LED's outward
 * normal and the direction to the light.
 *
 * Interpretation:
 *   - `direct` is the focused part of the light: a broad source spreads
 *     it over the whole front hemisphere with a smooth Lambert falloff,
 *     while a narrow source concentrates it into a tight forward cone.
 *     The cosine exponent N(β) controls how concentrated. Exponential
 *     mapping makes the slider feel uniform: each step roughly halves
 *     the lit half-angle.
 *   - `wrap` is the *extra* light a broad source contributes by wrapping
 *     around the LED's outward hemisphere (sky-like illumination reaching
 *     side and back LEDs). It scales with both broadness (β) and cloud
 *     transparency (1 − α): a sharp light has no wrap, and an opaque
 *     cloud blocks the wrap that would otherwise reach the back.
 *
 * Corners:
 *   shade(c, 0, α)  = max(0, c)^N_max               // narrow spot, any cloud
 *   shade(c, 1, 0)  = (1 + c) / 2                   // broad, transparent (half-Lambert)
 *   shade(c, 1, 1)  = max(0, c)                     // broad, opaque (flat Lambert)
 *   shade(c, 1, α)  = α · max(0, c) + (1 − α) · (1 + c) / 2   // = old (β = 1) formula
 *
 * So setting `β = 1` recovers the previous model exactly — existing
 * presets are visually unchanged.
 */
export function sensorAngularResponse(
  c: number,
  spread: number,
  alpha: number,
): number {
  const cPos = c > 0 ? c : 0;
  const n = spread >= 1 ? 1 : Math.pow(NARROW_EXPONENT, 1 - spread);
  // No energy boost: boosting then clamping flattens the lobe into a
  // full-bright cap, so a few degrees of sun motion snaps an LED on.
  const direct = n === 1 ? cPos : Math.pow(cPos, n);
  // Roll off through the terminator instead of ending on a hard edge.
  const toe = c <= -0.35 ? 0 : c >= 0.45 ? 1 : (c + 0.35) / 0.8;
  const toeSmooth = toe * toe * (3 - 2 * toe);
  const wrap = (1 + c) * 0.5 - cPos;
  const v = direct * toeSmooth + spread * (1 - alpha) * wrap;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function spreadToSpotAngle(spread: number): number {
  const s = Math.max(0, Math.min(1, spread));
  return 0.08 + s * (Math.PI / 2 - 0.08);
}

export function pointLightDistanceAttenuation(
  distance: number,
  decay: number,
  cutoffDistance = 0,
): number {
  const dist = Math.max(1e-6, distance);
  const distFall = 1 / Math.max(Math.pow(dist, Math.max(0, decay)), 0.01);
  if (cutoffDistance <= 0) return distFall;
  const t = dist / cutoffDistance;
  const s = 1 - Math.min(1, t * t * t * t);
  return distFall * s * s;
}

export function spotConeAttenuation(
  source: Vec3,
  target: Vec3,
  sample: Vec3,
  angle: number,
  penumbra: number,
): number {
  const ax = target[0] - source[0];
  const ay = target[1] - source[1];
  const az = target[2] - source[2];
  const al = Math.hypot(ax, ay, az) || 1;
  const sx = sample[0] - source[0];
  const sy = sample[1] - source[1];
  const sz = sample[2] - source[2];
  const sl = Math.hypot(sx, sy, sz) || 1;
  const cosine = (ax * sx + ay * sy + az * sz) / (al * sl);
  const outer = Math.cos(Math.max(0, Math.min(Math.PI / 2, angle)));
  const inner = Math.cos(
    Math.max(0, Math.min(Math.PI / 2, angle)) *
      (1 - Math.max(0, Math.min(1, penumbra))),
  );
  if (cosine <= outer) return 0;
  const focus = Math.max(0, Math.min(1, penumbra));
  const edge =
    cosine >= inner || inner <= outer
      ? 1
      : (() => {
          const t = (cosine - outer) / (inner - outer);
          return t * t * (3 - 2 * t);
        })();
  // At maximum focus, create a genuinely tight central hotspot while
  // retaining the configured outer spread as the beam boundary.
  const radial = Math.max(
    0,
    Math.min(1, (cosine - outer) / Math.max(1e-6, 1 - outer)),
  );
  const hotspot = Math.pow(radial, 1 + focus * 3);
  return edge * ((1 - focus) + focus * hotspot);
}

/**
 * Backlight around the cloud's outline, including the crown.
 * `edge` is 0 at the centre of the cloud (as seen from the light) and 1
 * on the silhouette. Width thickens that band. `ndl` only drops LEDs
 * that face the light directly, so the top still catches a low sun.
 */
export function rimSilhouette(edge: number, width: number, ndl: number): number {
  const w = width < 0 ? 0 : width > 1 ? 1 : width;
  const band = 0.1 + w * 0.45;
  const start = 1 - band;
  const t = edge <= start ? 0 : edge >= 1 ? 1 : (edge - start) / Math.max(1e-4, band);
  const silhouette = t * t * (3 - 2 * t);
  const facing = ndl <= 0.25 ? 1 : ndl >= 0.9 ? 0 : (0.9 - ndl) / 0.65;
  const keep = facing * facing * (3 - 2 * facing);
  const v = silhouette * keep;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Keep the shaded RGB ratio. A per-channel curve shifts a chosen swatch
 * (orange suns pick up green and blue). Scale every channel together,
 * and only when one of them would clip.
 */
function toneMapPreserveHue(
  r: number,
  g: number,
  b: number,
): [number, number, number] {
  const peak = Math.max(r, g, b);
  if (peak <= 0) return [0, 0, 0];
  if (peak <= 1) return [clamp01(r), clamp01(g), clamp01(b)];
  const scale = 1 / peak;
  return [r * scale, g * scale, b * scale];
}

/**
 * Shade `n` LEDs from a flat positions/normals buffer.
 *
 * - `positions` and `normals` are tightly-packed Float32Arrays of length n*3.
 * - `outBytes` is a Uint8Array of length n*3 receiving 0-255 RGB values
 *   (this is what we forward to WLED).
 * - `outFloats` is an optional Float32Array of length n*3 that, if provided,
 *   receives linear [0,1] RGB used to drive the on-screen InstancedMesh
 *   colors so what you see matches what's sent.
 */
export function shadeLeds(
  positions: Float32Array,
  normals: Float32Array,
  n: number,
  lights: ShadeLight[],
  cloudOpacity: number,
  outBytes: Uint8Array,
  outFloats?: Float32Array,
  options?: {
    hemisphereAverage?: boolean;
    hemisphereFocusExponent?: number;
    ambientDucking?: number;
    /**
     * 0 leaves ambient spatially flat (older configs). 1 darkens fill on
     * downward-facing and occluded LEDs so folds stay darker than open shade.
     */
    ambientOcclusion?: number;
    /** Lowest fraction of ambient fill kept in a fully occluded LED. */
    ambientShadowFloor?: number;
    /** Per-LED sky openness, typically max(sun, moon) transmission. */
    skyExposure?: Float32Array;
  },
): void {
  const hemisphereAverage = options?.hemisphereAverage ?? false;
  const focusExp = Math.max(0, options?.hemisphereFocusExponent ?? 0);
  // High focus values used to collapse the average onto one ray, so an
  // LED flipped as soon as that ray left the sun. Keep a real patch.
  const sampleFocus = focusExp <= 0 ? 0 : focusExp / (1 + focusExp / 3);
  const ambientDucking = clamp01(options?.ambientDucking ?? 0);
  const ambientOcclusion = clamp01(options?.ambientOcclusion ?? 0);
  const ambientShadowFloor = clamp01(options?.ambientShadowFloor ?? 0);
  const skyExposure = options?.skyExposure;
  let rimCx = 0;
  let rimCy = 0;
  let rimCz = 0;
  let rimCount = 0;
  const rimMaxU = new Float32Array(lights.length);
  const rimMaxV = new Float32Array(lights.length);
  const rimLx = new Float32Array(lights.length);
  const rimLy = new Float32Array(lights.length);
  const rimLz = new Float32Array(lights.length);
  const rimTx = new Float32Array(lights.length);
  const rimTy = new Float32Array(lights.length);
  const rimTz = new Float32Array(lights.length);
  const rimBx = new Float32Array(lights.length);
  const rimBy = new Float32Array(lights.length);
  const rimBz = new Float32Array(lights.length);
  let anyRim = false;
  for (let li = 0; li < lights.length; li++) {
    const L = lights[li];
    if (L.type !== "rim") continue;
    anyRim = true;
    const len = Math.hypot(L.direction[0], L.direction[1], L.direction[2]) || 1;
    const lx = L.direction[0] / len;
    const ly = L.direction[1] / len;
    const lz = L.direction[2] / len;
    rimLx[li] = lx;
    rimLy[li] = ly;
    rimLz[li] = lz;
    // Axes across the cloud as the light sees it. One of them follows
    // height, so the crown is part of the outline and not just the sides.
    const ax = Math.abs(ly) > 0.85 ? 1 : 0;
    const ay = Math.abs(ly) > 0.85 ? 0 : 1;
    let tx = ay * lz;
    let ty = -ax * lz;
    let tz = ax * ly - ay * lx;
    const tl = Math.hypot(tx, ty, tz) || 1;
    tx /= tl;
    ty /= tl;
    tz /= tl;
    rimTx[li] = tx;
    rimTy[li] = ty;
    rimTz[li] = tz;
    rimBx[li] = ly * tz - lz * ty;
    rimBy[li] = lz * tx - lx * tz;
    rimBz[li] = lx * ty - ly * tx;
  }
  if (anyRim && n > 0) {
    for (let i = 0; i < n; i++) {
      const i3 = i * 3;
      rimCx += positions[i3];
      rimCy += positions[i3 + 1];
      rimCz += positions[i3 + 2];
      rimCount++;
    }
    if (rimCount > 0) {
      rimCx /= rimCount;
      rimCy /= rimCount;
      rimCz /= rimCount;
    }
    for (let li = 0; li < lights.length; li++) {
      if (lights[li].type !== "rim") continue;
      const tx = rimTx[li];
      const ty = rimTy[li];
      const tz = rimTz[li];
      const bx = rimBx[li];
      const by = rimBy[li];
      const bz = rimBz[li];
      let maxU = 1e-4;
      let maxV = 1e-4;
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        const dx = positions[i3] - rimCx;
        const dy = positions[i3 + 1] - rimCy;
        const dz = positions[i3 + 2] - rimCz;
        const u = Math.abs(dx * tx + dy * ty + dz * tz);
        const v = Math.abs(dx * bx + dy * by + dz * bz);
        if (u > maxU) maxU = u;
        if (v > maxV) maxV = v;
      }
      rimMaxU[li] = maxU;
      rimMaxV[li] = maxV;
    }
  }
  // Deterministic, near-uniform-area local +Z hemisphere samples
  // (camera-independent). This avoids pole-biased averages.
  const HEMI_SAMPLES = buildUniformHemisphereSamples(32);
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const y = positions[i * 3 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const heightRange = Math.max(1e-6, maxY - minY);

  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const px = positions[i3];
    const py = positions[i3 + 1];
    const pz = positions[i3 + 2];
    const nx = normals[i3];
    const ny = normals[i3 + 1];
    const nz = normals[i3 + 2];

    let r = 0;
    let g = 0;
    let b = 0;
    let fillR = 0;
    let fillG = 0;
    let fillB = 0;
    let directCoverage = 0;
    let rimR = 0;
    let rimG = 0;
    let rimB = 0;

    // Build an orthonormal basis around the sensor axis `n` when averaging.
    let tx = 1;
    let ty = 0;
    let tz = 0;
    if (hemisphereAverage) {
      // Pick a helper axis least aligned with n to avoid degeneracy.
      const ax = Math.abs(nx) < 0.7 ? 1 : 0;
      const ay = Math.abs(nx) < 0.7 ? 0 : 1;
      const az = 0;
      // t = normalize(a x n)
      tx = ay * nz - az * ny;
      ty = az * nx - ax * nz;
      tz = ax * ny - ay * nx;
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl;
      ty /= tl;
      tz /= tl;
    }
    // b = n x t
    const bx = ny * tz - nz * ty;
    const by = nz * tx - nx * tz;
    const bz = nx * ty - ny * tx;

    for (let li = 0; li < lights.length; li++) {
      const L = lights[li];
      if (L.type === "ambient") {
        fillR += L.color[0] * L.intensity;
        fillG += L.color[1] * L.intensity;
        fillB += L.color[2] * L.intensity;
      } else if (L.type === "hemisphere") {
        // three.js HemisphereLight: linear blend between sky and ground
        // tints based on the surface normal's Y component. `ny` here is
        // the LED's outward normal in world space, so upward-facing LEDs
        // pick up the sky tint and downward-facing ones pick up ground.
        const t = ny * 0.5 + 0.5;
        const one = 1 - t;
        fillR += (L.groundColor[0] * one + L.skyColor[0] * t) * L.intensity;
        fillG += (L.groundColor[1] * one + L.skyColor[1] * t) * L.intensity;
        fillB += (L.groundColor[2] * one + L.skyColor[2] * t) * L.intensity;
      } else if (L.type === "rim") {
        const dx = px - rimCx;
        const dy = py - rimCy;
        const dz = pz - rimCz;
        const u = (dx * rimTx[li] + dy * rimTy[li] + dz * rimTz[li]) / rimMaxU[li];
        const v = (dx * rimBx[li] + dy * rimBy[li] + dz * rimBz[li]) / rimMaxV[li];
        const edge = Math.min(1, Math.hypot(u, v));
        const ndl = nx * rimLx[li] + ny * rimLy[li] + nz * rimLz[li];
        const k = L.intensity * rimSilhouette(edge, L.width, ndl);
        rimR += L.color[0] * k;
        rimG += L.color[1] * k;
        rimB += L.color[2] * k;
      } else if (L.type === "directional") {
        let k: number;
        if (!hemisphereAverage) {
          const c =
            nx * L.direction[0] + ny * L.direction[1] + nz * L.direction[2];
          k = L.intensity * sensorAngularResponse(c, L.spread, cloudOpacity);
        } else {
          let accum = 0;
          let wsum = 0;
          for (let si = 0; si < HEMI_SAMPLES.length; si++) {
            const s = HEMI_SAMPLES[si];
            const w = sampleFocus > 0 ? Math.pow(s[2], sampleFocus) : 1;
            // local sample (x,y,z) mapped to world: x*t + y*b + z*n
            const sx = s[0] * tx + s[1] * bx + s[2] * nx;
            const sy = s[0] * ty + s[1] * by + s[2] * ny;
            const sz = s[0] * tz + s[1] * bz + s[2] * nz;
            const c = sx * L.direction[0] + sy * L.direction[1] + sz * L.direction[2];
            accum += sensorAngularResponse(c, L.spread, cloudOpacity) * w;
            wsum += w;
          }
          k = L.intensity * accum / Math.max(wsum, 1e-6);
        }
        if (L.transmission) k *= L.transmission[i] ?? 1;
        directCoverage = Math.max(directCoverage, clamp01(k));
        r += L.color[0] * k;
        g += L.color[1] * k;
        b += L.color[2] * k;
      } else {
        const dx = L.position[0] - px;
        const dy = L.position[1] - py;
        const dz = L.position[2] - pz;
        const dist = Math.hypot(dx, dy, dz) || 1e-6;
        const invDist = 1 / dist;
        const lx = dx * invDist;
        const ly = dy * invDist;
        const lz = dz * invDist;
        // Match three.js physically-correct point-light attenuation:
        //   distanceFalloff = 1 / max(d^decay, 0.01)
        //   if (cutoff > 0) *= pow2(saturate(1 - pow4(d / cutoff)))
        const atten = pointLightDistanceAttenuation(dist, L.decay, L.distance);
        const coneAtten =
          L.target && L.coneAngle !== undefined
            ? spotConeAttenuation(
                L.position,
                L.target,
                [px, py, pz],
                L.coneAngle,
                L.penumbra ?? 0,
              )
            : 1;
        let k: number;
        if (!hemisphereAverage) {
          const c = nx * lx + ny * ly + nz * lz;
          k =
            L.intensity *
            sensorAngularResponse(c, L.spread, cloudOpacity) *
            atten *
            coneAtten;
        } else {
          let accum = 0;
          let wsum = 0;
          for (let si = 0; si < HEMI_SAMPLES.length; si++) {
            const s = HEMI_SAMPLES[si];
            const w = sampleFocus > 0 ? Math.pow(s[2], sampleFocus) : 1;
            const sx = s[0] * tx + s[1] * bx + s[2] * nx;
            const sy = s[0] * ty + s[1] * by + s[2] * ny;
            const sz = s[0] * tz + s[1] * bz + s[2] * nz;
            const c = sx * lx + sy * ly + sz * lz;
            accum += sensorAngularResponse(c, L.spread, cloudOpacity) * w;
            wsum += w;
          }
          k =
            L.intensity *
            (accum / Math.max(wsum, 1e-6)) *
            atten *
            coneAtten;
        }
        const t = L.transmission?.[i] ?? 1;
        k *= t;
        if ((L.topHighlightBoost ?? 0) > 0) {
          const height = clamp01((py - minY) / heightRange);
          // Cover the upper region rather than only the highest tip. The
          // smooth ramp begins around the upper two-thirds and approaches a
          // broad full-strength crown near the top.
          const upper = clamp01((height - 0.35) / 0.65);
          const crownWeight = upper * upper * (3 - 2 * upper);
          k *=
            1 +
            Math.max(0, L.topHighlightBoost ?? 0) *
              clamp01(L.topHighlightFactor ?? 0) *
              crownWeight;
        }
        directCoverage = Math.max(directCoverage, clamp01(k));
        r += L.color[0] * k;
        g += L.color[1] * k;
        b += L.color[2] * k;
      }
    }

    // Treat ducking as a shadow-fill gate rather than a linear subtraction.
    // Direct light is often numerically modest after distance attenuation, so
    // a sensitive exponential response is needed to clear white fill from
    // visibly highlighted areas while leaving fully shaded LEDs untouched.
    const duckSignal = 1 - Math.exp(-8 * directCoverage);
    const fillAmount = 1 - ambientDucking * duckSignal;
    // Open shade keeps the ambient colour. Downward normals and low
    // transmission reduce it so a fold can go dark without a separate
    // shadow colour. Occlusion 0 leaves the previous uniform fill.
    let ambVis = 1;
    if (ambientOcclusion > 0) {
      const up = clamp01(ny * 0.5 + 0.5);
      const open = skyExposure?.[i] ?? 1;
      const cavity = (up * 0.35 + 0.65) * (0.2 + 0.8 * clamp01(open));
      ambVis =
        ambientShadowFloor +
        (1 - ambientShadowFloor) * (1 - ambientOcclusion * (1 - cavity));
    }
    r += fillR * fillAmount * ambVis;
    g += fillG * fillAmount * ambVis;
    b += fillB * fillAmount * ambVis;
    r += rimR;
    g += rimG;
    b += rimB;

    const [cr, cg, cb] = toneMapPreserveHue(r, g, b);

    if (outFloats) {
      outFloats[i3] = cr;
      outFloats[i3 + 1] = cg;
      outFloats[i3 + 2] = cb;
    }

    outBytes[i3] = (cr * 255 + 0.5) | 0;
    outBytes[i3 + 1] = (cg * 255 + 0.5) | 0;
    outBytes[i3 + 2] = (cb * 255 + 0.5) | 0;
  }
}

function buildUniformHemisphereSamples(count: number): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  const ga = Math.PI * (3 - Math.sqrt(5)); // golden angle
  for (let i = 0; i < count; i++) {
    // Uniform-in-area over hemisphere => z is uniform in [0,1].
    const z = (i + 0.5) / count;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const a = ga * i;
    out.push([Math.cos(a) * r, Math.sin(a) * r, z]);
  }
  return out;
}

/**
 * Parse a hex color string like "#rrggbb" or "#rgb" to a Vec3 in [0,1].
 */
export function hexToVec3(hex: string): Vec3 {
  const h = hex.replace("#", "");
  let r: number, g: number, b: number;
  if (h.length === 3) {
    r = parseInt(h[0] + h[0], 16);
    g = parseInt(h[1] + h[1], 16);
    b = parseInt(h[2] + h[2], 16);
  } else {
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  }
  return [r / 255, g / 255, b / 255];
}
