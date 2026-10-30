import { useEffect, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import {
  BufferGeometry,
  Color,
  Euler,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  Raycaster,
  Vector3,
} from "three";
import { applyMappingOrientationPoint } from "../mapping/geometry";
import {
  displaceLed,
  gaussianRayTransmission,
  orientGaussians,
} from "../mapping/gaussians";
import {
  getMeshHalfExtents,
  loadMeshGeometry,
  sampleMeshSurfacePoint,
} from "../mapping/meshAsset";
import {
  alignMarkerNormal,
  applyMarkerInstanceEmissive,
  MARKER_MATERIAL_DEFAULTS,
  markerRadius,
  markerSphereArgs,
} from "../mapping/markerVisual";
import {
  breathFilterGate,
  buildCooldownRates,
  sampleBreathFilterThreshold,
  updateBreathFilterMemory,
} from "../lighting/breathFilter";
import { setBreathEffectDrive } from "../lighting/breathEffectDrive";
import {
  breathSampleAt,
  cloudCenterWorld,
  localBreathSampleAt,
  liveWaveExtents,
  sharedBreathWaveController,
} from "../lighting/breathWaves";
import { tickBreathClock } from "../lighting/breath";
import {
  hexToVec3,
  shadeLeds,
  spreadToSpotAngle,
  type ShadeLight,
} from "../lighting/shade";
import { activeWindowProgress, hourInRange, isBreathActive, useSimStore } from "../state";
import { computeSkyLighting } from "../lighting/skyCycle";
import { sharedLightningController } from "../lighting/lightning";
import { WledStreamClient } from "../wled/client";
import { publishFrame, publishLedPositions } from "../stream/frameBuffer";
import { encodeLedRgb, srgbChannelToLinear } from "../lighting/ledColor";

function linearHex(hex: string): [number, number, number] {
  const [r, g, b] = hexToVec3(hex);
  return [srgbChannelToLinear(r), srgbChannelToLinear(g), srgbChannelToLinear(b)];
}

function clamp01(v: number): number {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
}

function smoothstep01(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}
const STREAM_BYTE_DEADBAND = 1;

function rotateY(v: [number, number, number], radians: number): [number, number, number] {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c];
}

function rotateX(v: [number, number, number], radians: number): [number, number, number] {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [v[0], v[1] * c - v[2] * s, v[1] * s + v[2] * c];
}

function rotateCloud(
  v: [number, number, number],
  tiltRad: number,
  yawRad: number,
): [number, number, number] {
  // Match three.js default Euler order "XYZ" used by the Ellipsoid mesh
  // (composed matrix Rx * Ry * Rz → yaw applied first, then tilt).
  return rotateX(rotateY(v, yawRad), tiltRad);
}

function offsetXZ(v: [number, number, number], x: number, z: number): [number, number, number] {
  return [v[0] + x, v[1], v[2] + z];
}

export function Leds() {
  const ellipsoid = useSimStore((s) => s.ellipsoid);
  const cloud = useSimStore((s) => s.cloud);
  const cloudTop = useSimStore((s) => s.cloudTop);
  const strand = useSimStore((s) => s.strand);
  const mapping = useSimStore((s) => s.mapping);
  const meshTarget = useSimStore((s) => s.mesh);
  const ambient = useSimStore((s) => s.ambient);
  const sky = useSimStore((s) => s.sky);
  const breath = useSimStore((s) => s.breath);
  const breathFilter = useSimStore((s) => s.breathFilter);
  const lightning = useSimStore((s) => s.lightning);
  const ledViewMode = useSimStore((s) => s.ledViewMode);
  const ledDisplayMode = useSimStore((s) => s.ledDisplayMode);
  const breathTimeCombineMode = useSimStore((s) => s.breathTimeCombineMode);
  const ledStreamPipeline = useSimStore((s) => s.ledStreamPipeline);
  const ledLocator = useSimStore((s) => s.ledLocator);
  const toggleLocatedLed = useSimStore((s) => s.toggleLocatedLed);
  const wled = useSimStore((s) => s.wled);
  const cloudTiltRad = (cloud.rotationXDeg * Math.PI) / 180;
  const cloudYawRad = (cloud.rotationYDeg * Math.PI) / 180;
  const MANUAL_BLEND_WHEN_SKY = 0.2;

  const meshRef = useRef<InstancedMesh>(null);
  const dummy = useMemo(() => new Object3D(), []);
  const tmpColor = useMemo(() => new Color(), []);
  const boltSurfacePoint = useMemo(() => new Vector3(), []);
  const stableBytesRef = useRef<Uint8Array | null>(null);
  const locatedSet = useMemo(
    () => new Set(ledLocator.highlighted),
    [ledLocator.highlighted],
  );

  // LED positions come exclusively from the mapping app.
  const ledCount = mapping.leds.length;

  // Per-LED buffers. Reallocated when the LED count changes.
  const buffers = useMemo(() => {
    const n = ledCount;
    return {
      n,
      positions: new Float32Array(n * 3),
      normals: new Float32Array(n * 3),
      localPositions: new Float32Array(n * 3),
      localNormals: new Float32Array(n * 3),
      sunTransmission: new Float32Array(n),
      moonTransmission: new Float32Array(n),
      skyExposure: new Float32Array(n),
      validPositions: new Uint8Array(n),
      colorFloats: new Float32Array(n * 3),
      timeColorFloats: new Float32Array(n * 3),
      breathColorFloats: new Float32Array(n * 3),
      /** Per-LED rim shell weight [0,1] before rimAmount. */
      breathRimWeights: new Float32Array(n),
      /** Participant colour for the winning rim contribution. */
      breathRimColors: new Float32Array(n * 3),
      lightningColorFloats: new Float32Array(n * 3),
      colorBytes: new Uint8Array(n * 3),
      /** Persistent TOD gate memory [0,1] per LED. */
      breathFilterMemory: new Float32Array(n),
      /** Seconds since breath mask went inactive, per LED. */
      breathFilterReleaseAge: new Float32Array(n),
      /** Procedural cooldown rates [0,1] per LED. */
      breathCooldownRates: new Float32Array(n),
    };
  }, [ledCount]);

  const breathFilterClockRef = useRef({ lastMs: 0 });
  const breathCooldownKeyRef = useRef("");
  const positionsVersionRef = useRef(0);
  // Mesh transform used to convert stored mesh-local LED coords into
  // world coords. Kept identical to the mapping app's mesh transform.
  const meshMatrix = useMemo(() => {
    const q = new Quaternion().setFromEuler(
      new Euler(
        (meshTarget.tiltDeg * Math.PI) / 180,
        (meshTarget.yawDeg * Math.PI) / 180,
        0,
        "XYZ",
      ),
    );
    return new Matrix4().compose(
      new Vector3(0, meshTarget.offsetY, 0),
      q,
      new Vector3(meshTarget.scale, meshTarget.scale, meshTarget.scale),
    );
  }, [meshTarget.scale, meshTarget.offsetY, meshTarget.yawDeg, meshTarget.tiltDeg]);
  const meshNormalMat = useMemo(
    () => new Matrix3().getNormalMatrix(meshMatrix),
    [meshMatrix],
  );
  const orientedGaussians = useMemo(
    () =>
      orientGaussians(
        mapping.gaussians ?? [],
        mapping.flipUpDown,
        mapping.flipLeftRight,
        applyMappingOrientationPoint,
      ),
    [
      mapping.gaussians,
      mapping.flipUpDown,
      mapping.flipLeftRight,
    ],
  );
  const worldToBumpLocal = useMemo(() => {
    const cloudQ = new Quaternion().setFromEuler(
      new Euler(cloudTiltRad, cloudYawRad, 0, "XYZ"),
    );
    const cloudMatrix = new Matrix4().compose(
      new Vector3(cloud.offsetX, cloud.offsetY, cloud.offsetZ),
      cloudQ,
      new Vector3(1, 1, 1),
    );
    return cloudMatrix.multiply(meshMatrix.clone()).invert();
  }, [
    cloudTiltRad,
    cloudYawRad,
    cloud.offsetX,
    cloud.offsetY,
    cloud.offsetZ,
    meshMatrix,
  ]);

  useEffect(() => {
    for (let i = 0; i < buffers.n; i++) {
      // `i` is the logical strand index; map it to the placement index so
      // the reverse toggle flips which physical end is LED #0.
      const physical = mapping.reversed ? buffers.n - 1 - i : i;
      const led = mapping.leds[physical];
      const hasPosition = !!led.pos;
      buffers.validPositions[i] = hasPosition ? 1 : 0;
      // LEDs without a mesh-mode record contribute an origin dummy (0,0,0)
      // so they still count in the strand but have no visible position.
      const rawPos: [number, number, number] = led.pos
        ? [led.pos[0], led.pos[1], led.pos[2]]
        : [0, 0, 0];
      const rawNrm: [number, number, number] = led.normal
        ? [led.normal[0], led.normal[1], led.normal[2]]
        : [0, 1, 0];
      let lp = applyMappingOrientationPoint(
        rawPos,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      const baseLn = applyMappingOrientationPoint(
        rawNrm,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      // Match LED Mapping: orientation first, then dome/per-LED displacement.
      const displaced = displaceLed(
        lp,
        baseLn,
        orientedGaussians,
        led.offset ?? 0,
        mapping.bumpAdditivity,
      );
      lp = displaced.pos;
      let ln = displaced.normal;
      // Keep displaced normals on the same hemisphere as the mapped surface
      // normal rather than inferring "outward" from world origin.
      ln = alignMarkerNormal(ln, baseLn);
      // Transform the stored mesh-local point + normal by the current
      // mesh transform so LEDs stay attached to the surface as the
      // scale/rotation/offset sliders change.
      const wpV = new Vector3(lp[0], lp[1], lp[2]).applyMatrix4(meshMatrix);
      const wnV = new Vector3(ln[0], ln[1], ln[2])
        .applyMatrix3(meshNormalMat)
        .normalize();
      const pos: [number, number, number] = [wpV.x, wpV.y, wpV.z];
      const nrm = [wnV.x, wnV.y, wnV.z] as [number, number, number];
      const rPos = offsetXZ(
        rotateCloud(pos, cloudTiltRad, cloudYawRad),
        cloud.offsetX,
        cloud.offsetZ,
      );
      const rNrm = rotateCloud(nrm, cloudTiltRad, cloudYawRad);
      const i3 = i * 3;
      buffers.localPositions[i3] = lp[0];
      buffers.localPositions[i3 + 1] = lp[1];
      buffers.localPositions[i3 + 2] = lp[2];
      buffers.localNormals[i3] = ln[0];
      buffers.localNormals[i3 + 1] = ln[1];
      buffers.localNormals[i3 + 2] = ln[2];
      buffers.positions[i3] = rPos[0];
      buffers.positions[i3 + 1] = rPos[1] + cloud.offsetY;
      buffers.positions[i3 + 2] = rPos[2];
      buffers.normals[i3] = rNrm[0];
      buffers.normals[i3 + 1] = rNrm[1];
      buffers.normals[i3 + 2] = rNrm[2];
    }

    const mesh = meshRef.current;
    if (mesh) {
      const markerKind = ledDisplayMode === "sensors" ? "sensor" : "led";
      const radius = markerRadius(
        markerKind,
        mapping.ledSize,
        strand.ledSize,
      );
      const yAxis = new Vector3(0, 1, 0);
      const normalVec = new Vector3();
      for (let i = 0; i < buffers.n; i++) {
        const i3 = i * 3;
        if (!buffers.validPositions[i]) {
          dummy.position.set(0, 0, 0);
          dummy.quaternion.identity();
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          continue;
        }
        const nx = buffers.normals[i3];
        const ny = buffers.normals[i3 + 1];
        const nz = buffers.normals[i3 + 2];
        dummy.position.set(
          buffers.positions[i3],
          buffers.positions[i3 + 1],
          buffers.positions[i3 + 2],
        );
        {
          normalVec.set(nx, ny, nz);
          dummy.quaternion.setFromUnitVectors(yAxis, normalVec);
        }
        dummy.scale.setScalar(radius);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.count = buffers.n;
    }
    positionsVersionRef.current += 1;
    publishLedPositions(
      buffers.positions,
      buffers.normals,
      buffers.n,
      buffers.validPositions,
    );
  }, [
    ellipsoid.rx,
    ellipsoid.ry,
    ellipsoid.rz,
    strand.ledSize,
    mapping.ledSize,
    mapping.leds,
    mapping.gaussians,
    mapping.bumpAdditivity,
    mapping.flipUpDown,
    mapping.flipLeftRight,
    mapping.reversed,
    orientedGaussians,
    cloudTiltRad,
    cloudYawRad,
    cloud.offsetX,
    cloud.offsetY,
    cloud.offsetZ,
    ledDisplayMode,
    meshMatrix,
    meshNormalMat,
    buffers,
    dummy,
  ]);

  // Cached mesh half-extents (bounding-box), used to constrain lightning
  // bolt endpoints to the actual cloud mesh volume rather than the legacy
  // ellipsoid params (which no longer describe the visible cloud once a
  // user mesh is loaded).
  const meshHalfExtentsRef = useRef<{ hx: number; hy: number; hz: number } | null>(null);
  const [meshGeom, setMeshGeom] = useState<BufferGeometry | null>(null);
  useEffect(() => {
    const id = meshTarget.id;
    if (!id) {
      meshHalfExtentsRef.current = null;
      setMeshGeom(null);
      return;
    }
    const cached = getMeshHalfExtents(id);
    if (cached) {
      meshHalfExtentsRef.current = cached;
    }
    let cancelled = false;
    loadMeshGeometry(id).then((g) => {
      if (cancelled) return;
      setMeshGeom(g);
      meshHalfExtentsRef.current = getMeshHalfExtents(id);
    });
    return () => {
      cancelled = true;
    };
  }, [meshTarget.id]);
  const meshOccluder = useMemo(() => (meshGeom ? new Mesh(meshGeom) : null), [meshGeom]);
  const pyramidRaycaster = useMemo(() => new Raycaster(), []);
  const pyramidRayOrigin = useMemo(() => new Vector3(), []);
  const pyramidRayDir = useMemo(() => new Vector3(), []);
  const pyramidHitsRef = useRef<any[]>([]);
  const transmissionSmoothRef = useRef<{
    t: number;
    hour: number;
    sun: Float32Array | null;
    moon: Float32Array | null;
  }>({ t: 0, hour: 0, sun: null, moon: null });

  // Long-lived WLED streaming client. Lightning uses a shared controller
  // so the 3D bolt visualisation sees the same active strikes.
  const lightningCtrl = sharedLightningController;
  const lightningRenderRef = useRef(0);
  const wledClient = useMemo(() => new WledStreamClient(), []);
  useEffect(() => {
    if (wled.enabled) wledClient.start();
    else wledClient.stop();
    return () => wledClient.stop();
  }, [wled.enabled, wledClient]);
  useEffect(() => {
    wledClient.setTarget(wled.host, 4048);
  }, [wled.host, wledClient]);

  // Ensure the instance color attribute exists before the first frame.
  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    if (!mesh.instanceColor || mesh.instanceColor.count !== buffers.n) {
      const init = new Float32Array(buffers.n * 3);
      const attr = new InstancedBufferAttribute(init, 3);
      attr.setUsage(DynamicDrawUsage);
      mesh.instanceColor = attr;
    }
  }, [buffers.n]);

  // Per-frame: shade and push colors to GPU + WLED.
  const lastSendRef = useRef(0);
  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;

    const skyLighting = computeSkyLighting(sky);
    if (
      (mapping.bumpLightOpacity > 0 && orientedGaussians.length > 0) ||
      mapping.pyramidLightOpacity > 0
    ) {
      const orbitRadiusX = Math.max(0, sky.orbitRadiusX ?? sky.orbitRadius ?? 12);
      const orbitRadiusY = Math.max(0, sky.orbitRadiusY ?? sky.orbitRadius ?? 12);
      const orbitRadiusZ = Math.max(0, sky.orbitRadiusZ ?? sky.orbitRadius ?? 12);
      const cloudCenterWorld: [number, number, number] = [
        cloud.offsetX,
        cloud.offsetY + meshTarget.offsetY,
        cloud.offsetZ,
      ];
      const sunWorld: [number, number, number] = [
        cloudCenterWorld[0] + skyLighting.sunDirection[0] * orbitRadiusX,
        cloudCenterWorld[1] + skyLighting.sunDirection[1] * orbitRadiusY,
        cloudCenterWorld[2] + skyLighting.sunDirection[2] * orbitRadiusZ,
      ];
      const moonWorld: [number, number, number] = [
        cloudCenterWorld[0] + skyLighting.moonDirection[0] * orbitRadiusX,
        cloudCenterWorld[1] + skyLighting.moonDirection[1] * orbitRadiusY,
        cloudCenterWorld[2] + skyLighting.moonDirection[2] * orbitRadiusZ,
      ];
      const sunLocalPointV = new Vector3(...sunWorld).applyMatrix4(worldToBumpLocal);
      const moonLocalPointV = new Vector3(...moonWorld).applyMatrix4(worldToBumpLocal);
      const sunLocalPoint: [number, number, number] = [
        sunLocalPointV.x,
        sunLocalPointV.y,
        sunLocalPointV.z,
      ];
      const moonLocalPoint: [number, number, number] = [
        moonLocalPointV.x,
        moonLocalPointV.y,
        moonLocalPointV.z,
      ];
      const pyramidBlocked =
        1 - Math.max(0, Math.min(1, mapping.pyramidLightOpacity));
      for (let i = 0; i < buffers.n; i++) {
        if (!buffers.validPositions[i]) {
          buffers.sunTransmission[i] = 1;
          buffers.moonTransmission[i] = 1;
          continue;
        }
        const i3 = i * 3;
        const origin: [number, number, number] = [
          buffers.localPositions[i3],
          buffers.localPositions[i3 + 1],
          buffers.localPositions[i3 + 2],
        ];
        const originNormal: [number, number, number] = [
          buffers.localNormals[i3],
          buffers.localNormals[i3 + 1],
          buffers.localNormals[i3 + 2],
        ];
        const sunToLight: [number, number, number] = [
          sunLocalPoint[0] - origin[0],
          sunLocalPoint[1] - origin[1],
          sunLocalPoint[2] - origin[2],
        ];
        const moonToLight: [number, number, number] = [
          moonLocalPoint[0] - origin[0],
          moonLocalPoint[1] - origin[1],
          moonLocalPoint[2] - origin[2],
        ];
        let sunPyramidTransmission = 1;
        let moonPyramidTransmission = 1;
        const sunLen = Math.hypot(sunToLight[0], sunToLight[1], sunToLight[2]) || 1;
        const moonLen = Math.hypot(moonToLight[0], moonToLight[1], moonToLight[2]) || 1;
        const sunCos =
          (originNormal[0] * sunToLight[0] +
            originNormal[1] * sunToLight[1] +
            originNormal[2] * sunToLight[2]) /
          sunLen;
        const moonCos =
          (originNormal[0] * moonToLight[0] +
            originNormal[1] * moonToLight[1] +
            originNormal[2] * moonToLight[2]) /
          moonLen;
        // Open across a wide angle so the shadow edge slides instead of popping.
        const sunGate = smoothstep01((sunCos + 0.35) / 0.9);
        const moonGate = smoothstep01((moonCos + 0.35) / 0.9);
        sunPyramidTransmission = pyramidBlocked + (1 - pyramidBlocked) * sunGate;
        moonPyramidTransmission = pyramidBlocked + (1 - pyramidBlocked) * moonGate;
        if (mapping.pyramidLightOpacity > 0 && meshOccluder) {
          const localSensorRadius =
            strand.ledSize / Math.max(1e-6, Math.abs(meshTarget.scale));
          const rayOrigin = pyramidRayOrigin.set(
            origin[0] + originNormal[0] * localSensorRadius,
            origin[1] + originNormal[1] * localSensorRadius,
            origin[2] + originNormal[2] * localSensorRadius,
          );
          const hits = pyramidHitsRef.current;
          pyramidRaycaster.near = 0;
          pyramidRayDir.set(sunToLight[0], sunToLight[1], sunToLight[2]);
          const sunDistance = pyramidRayDir.length();
          pyramidRaycaster.far = Math.max(1e-4, sunDistance - 1e-4);
          pyramidRayDir.normalize();
          pyramidRaycaster.set(rayOrigin, pyramidRayDir);
          hits.length = 0;
          if (pyramidRaycaster.intersectObject(meshOccluder, false, hits).length > 0) {
            sunPyramidTransmission = Math.min(sunPyramidTransmission, pyramidBlocked);
          }
          pyramidRayDir.set(moonToLight[0], moonToLight[1], moonToLight[2]);
          const moonDistance = pyramidRayDir.length();
          pyramidRaycaster.far = Math.max(1e-4, moonDistance - 1e-4);
          pyramidRayDir.normalize();
          pyramidRaycaster.set(rayOrigin, pyramidRayDir);
          hits.length = 0;
          if (pyramidRaycaster.intersectObject(meshOccluder, false, hits).length > 0) {
            moonPyramidTransmission = Math.min(moonPyramidTransmission, pyramidBlocked);
          }
        }
        const sunDomeTransmission =
          mapping.bumpLightOpacity > 0 && orientedGaussians.length > 0
            ? gaussianRayTransmission(
                origin,
                sunToLight,
                Math.hypot(...sunToLight),
                orientedGaussians,
                mapping.bumpLightOpacity,
                originNormal,
              )
            : 1;
        const moonDomeTransmission =
          mapping.bumpLightOpacity > 0 && orientedGaussians.length > 0
            ? gaussianRayTransmission(
                origin,
                moonToLight,
                Math.hypot(...moonToLight),
                orientedGaussians,
                mapping.bumpLightOpacity,
                originNormal,
              )
            : 1;
        buffers.sunTransmission[i] = sunDomeTransmission * sunPyramidTransmission;
        buffers.moonTransmission[i] = moonDomeTransmission * moonPyramidTransmission;
      }
    } else {
      buffers.sunTransmission.fill(1);
      buffers.moonTransmission.fill(1);
    }
    // Mesh occlusion still crosses a ridge in one frame. Ease that step
    // while time is playing, and jump straight there when the clock is scrubbed.
    {
      const nowMs = performance.now();
      const smooth = transmissionSmoothRef.current;
      const dt = smooth.t > 0 ? Math.min(0.1, (nowMs - smooth.t) / 1000) : 0;
      let dh = sky.timeHours - smooth.hour;
      if (dh > 12) dh -= 24;
      if (dh < -12) dh += 24;
      const expected = sky.autoPlay
        ? (24 / Math.max(1, sky.cycleSeconds)) * dt
        : 0;
      const scrubbed = smooth.t > 0 && Math.abs(dh - expected) > 0.08;
      smooth.t = nowMs;
      smooth.hour = sky.timeHours;
      if (!smooth.sun || smooth.sun.length !== buffers.n || !smooth.moon) {
        smooth.sun = new Float32Array(buffers.sunTransmission);
        smooth.moon = new Float32Array(buffers.moonTransmission);
      } else if (!scrubbed && dt > 0) {
        const alpha = 1 - Math.exp(-dt / 0.9);
        for (let i = 0; i < buffers.n; i++) {
          smooth.sun[i] += (buffers.sunTransmission[i] - smooth.sun[i]) * alpha;
          smooth.moon[i] += (buffers.moonTransmission[i] - smooth.moon[i]) * alpha;
          buffers.sunTransmission[i] = smooth.sun[i];
          buffers.moonTransmission[i] = smooth.moon[i];
        }
      } else {
        smooth.sun.set(buffers.sunTransmission);
        smooth.moon.set(buffers.moonTransmission);
      }
    }
    const skyAmount = clamp01(sky.visualizationAmount ?? 1);
    const manualBlend = sky.enabled
      ? 1 - (1 - MANUAL_BLEND_WHEN_SKY) * skyAmount
      : 1;

    const useTimePipeline =
      ledStreamPipeline.timeOfDayStage && ledViewMode !== "breathIntensity";

    if (useTimePipeline) {
      // Pipeline A: time-of-day lighting.
      const timeLights: ShadeLight[] = [
        {
          type: "ambient",
          color: linearHex(ambient.color),
          intensity: ambient.intensity * manualBlend,
        },
      ];
      if (sky.enabled) {
        const orbitRadiusX = Math.max(0, sky.orbitRadiusX ?? sky.orbitRadius ?? 12);
        const orbitRadiusY = Math.max(0, sky.orbitRadiusY ?? sky.orbitRadius ?? 12);
        const orbitRadiusZ = Math.max(0, sky.orbitRadiusZ ?? sky.orbitRadius ?? 12);
        const cloudCenter: [number, number, number] = [
          cloud.offsetX,
          cloud.offsetY + meshTarget.offsetY,
          cloud.offsetZ,
        ];
        timeLights.push(
          {
            type: "hemisphere",
            skyColor: linearHex(skyLighting.skyColor),
            groundColor: linearHex(skyLighting.groundColor),
            intensity: skyLighting.hemiIntensity,
          },
          {
            type: "point",
            position: [
              cloudCenter[0] + skyLighting.sunDirection[0] * orbitRadiusX,
              cloudCenter[1] + skyLighting.sunDirection[1] * orbitRadiusY,
              cloudCenter[2] + skyLighting.sunDirection[2] * orbitRadiusZ,
            ],
            color: linearHex(skyLighting.sunColor),
            intensity: skyLighting.sunIntensity,
            decay: Math.max(0, sky.lightDecay ?? 1),
            distance: 0,
            spread: clamp01(sky.sunSpread ?? 0.9),
            target: cloudCenter,
            coneAngle: spreadToSpotAngle(sky.sunSpread ?? 0.9),
            penumbra: clamp01(sky.sunBeamFocus ?? 0.65),
            topHighlightBoost: Math.max(0, sky.sunTopHighlightBoost ?? 0),
            topHighlightFactor: clamp01(
              1 - Math.abs(skyLighting.sunDirection[1]) / 0.65,
            ),
            transmission: buffers.sunTransmission,
          },
          {
            type: "point",
            position: [
              cloudCenter[0] + skyLighting.moonDirection[0] * orbitRadiusX,
              cloudCenter[1] + skyLighting.moonDirection[1] * orbitRadiusY,
              cloudCenter[2] + skyLighting.moonDirection[2] * orbitRadiusZ,
            ],
            color: linearHex(skyLighting.moonColor),
            intensity: skyLighting.moonIntensity,
            decay: Math.max(0, sky.lightDecay ?? 1),
            distance: 0,
            spread: clamp01(sky.moonSpread ?? 0.9),
            target: cloudCenter,
            coneAngle: spreadToSpotAngle(sky.moonSpread ?? 0.9),
            penumbra: clamp01(sky.moonBeamFocus ?? 0.65),
            transmission: buffers.moonTransmission,
          },
        );
        const rimWidth = clamp01(sky.rimWidth ?? 0.4);
        if (sky.rimEnabled && skyLighting.rimSunIntensity > 0.001) {
          timeLights.push({
            type: "rim",
            direction: skyLighting.sunDirection,
            color: linearHex(skyLighting.rimColor),
            intensity: skyLighting.rimSunIntensity,
            width: rimWidth,
            transmission: buffers.sunTransmission,
          });
        }
        if (sky.rimEnabled && skyLighting.rimMoonIntensity > 0.001) {
          timeLights.push({
            type: "rim",
            direction: skyLighting.moonDirection,
            color: linearHex(skyLighting.rimColor),
            intensity: skyLighting.rimMoonIntensity,
            width: rimWidth,
            transmission: buffers.moonTransmission,
          });
        }
      }
      const occlusion = clamp01(sky.ambientOcclusion ?? 0);
      if (occlusion > 0) {
        for (let i = 0; i < buffers.n; i++) {
          const open = Math.max(
            buffers.sunTransmission[i] ?? 1,
            buffers.moonTransmission[i] ?? 1,
          );
          buffers.skyExposure[i] = open;
        }
      }
      shadeLeds(
        buffers.positions,
        buffers.normals,
        buffers.n,
        timeLights,
        cloud.opacity,
        buffers.colorBytes,
        buffers.timeColorFloats,
        {
          hemisphereAverage: true,
          hemisphereFocusExponent: Math.max(0, strand.sensorHemisphereFocus),
          ambientDucking: ambient.ducking ?? 0.75,
          ambientOcclusion: occlusion,
          ambientShadowFloor: clamp01(sky.ambientShadowFloor ?? 0),
          skyExposure: occlusion > 0 ? buffers.skyExposure : undefined,
        },
      );
    } else {
      buffers.timeColorFloats.fill(0);
    }

    // Travelling waves use wall clock (decoupled from breath pause/scrub).
    // Internal oscillator phase still uses the shared breath clock.
    // Outside the breath active window, treat as disabled (no new waves /
    // mask) — same pattern as lightning's active hour gate.
    const wallNow = performance.now();
    const nowBreath = tickBreathClock(wallNow, breath.paused);
    const breathLive = isBreathActive(breath, sky.timeHours);
    const breathForWaves = breathLive ? breath : { ...breath, enabled: false };
    const cloudXformBreath = {
      tiltRad: cloudTiltRad,
      yawRad: cloudYawRad,
      offsetX: cloud.offsetX,
      offsetY: cloud.offsetY,
      offsetZ: cloud.offsetZ,
    };
    sharedBreathWaveController.update(
      wallNow,
      breathForWaves,
      cloudXformBreath,
      nowBreath,
    );
    if (breath.effectMode === "localInflation") {
      sharedBreathWaveController.syncLocalInflations(
        breathForWaves,
        cloudXformBreath,
        buffers.positions,
        buffers.n,
      );
    } else {
      const { width, height, depth } = liveWaveExtents(breath);
      sharedBreathWaveController.syncLedContact(
        wallNow,
        buffers.positions,
        buffers.n,
        width,
        height,
        depth,
      );
    }

    const useBreathMask =
      breathLive &&
      (ledViewMode === "breathIntensity" ||
        (ledStreamPipeline.breathStage && ledViewMode === "breathPlusTimeOfDay"));

    // Always sample the live wave mask while breath is active so filter
    // memory and the cloud-effect audio drive keep updating even when the
    // current LED view isn't showing breath (e.g. time-of-day only).
    const sampleBreathMask = breathLive;

    if (sampleBreathMask) {
      const falloffExp = Math.max(0, breath.falloffExponent);
      const { width, height, depth } = liveWaveExtents(breath);
      const fog = {
        scale: breath.noiseScale,
        amount: breath.noiseAmount,
        contrast: breath.noiseContrast,
        edgeNoise: breath.edgeNoise,
      };
      const fogCenter = cloudCenterWorld(cloudXformBreath);
      for (let i = 0; i < buffers.n; i++) {
        const i3 = i * 3;
        const sample =
          breath.effectMode === "localInflation"
            ? localBreathSampleAt(
                buffers.positions[i3],
                buffers.positions[i3 + 1],
                buffers.positions[i3 + 2],
                sharedBreathWaveController,
                wallNow,
                falloffExp,
                useBreathMask ? breath.rimThickness : 0,
                fog,
                fogCenter,
              )
            : breathSampleAt(
                buffers.positions[i3],
                buffers.positions[i3 + 1],
                buffers.positions[i3 + 2],
                sharedBreathWaveController,
                wallNow,
                falloffExp,
                width,
                height,
                depth,
                useBreathMask ? breath.rimThickness : 0,
                useBreathMask ? breath.rimArcDegrees : 0,
                fog,
                fogCenter,
              );
        buffers.breathColorFloats[i3] = sample.mask;
        buffers.breathColorFloats[i3 + 1] = sample.mask;
        buffers.breathColorFloats[i3 + 2] = sample.mask;
        if (useBreathMask) {
          buffers.breathRimWeights[i] = sample.rim;
          buffers.breathRimColors[i3] = sample.rimR;
          buffers.breathRimColors[i3 + 1] = sample.rimG;
          buffers.breathRimColors[i3 + 2] = sample.rimB;
        } else {
          buffers.breathRimWeights[i] = 0;
          buffers.breathRimColors[i3] = 0;
          buffers.breathRimColors[i3 + 1] = 0;
          buffers.breathRimColors[i3 + 2] = 0;
        }
      }
    } else {
      buffers.breathColorFloats.fill(0);
      buffers.breathRimWeights.fill(0);
      buffers.breathRimColors.fill(0);
    }

    // Persistent breath-filter memory (TOD gate). Rebuild cooldown field
    // when layout or procedural params change; update memory whenever
    // the filter is enabled and breath is sampling.
    const needCooldownField = breathFilter.enabled || breathFilter.showNoise;
    if (needCooldownField) {
      const coolKey = `v8|${positionsVersionRef.current}|${buffers.n}|${breathFilter.seed}|${breathFilter.cooldownScale}|${breathFilter.cooldownContrast}`;
      if (coolKey !== breathCooldownKeyRef.current) {
        buildCooldownRates(
          buffers.positions,
          buffers.n,
          breathFilter,
          buffers.breathCooldownRates,
        );
        breathCooldownKeyRef.current = coolKey;
      }
    }
    // Threshold rides the breath active-window timeline (same u axis as
    // breath Start→End). Sample once per frame for memory + compositing.
    const filterU = activeWindowProgress(
      sky.timeHours,
      breath.activeStartHour,
      breath.activeEndHour,
    );
    const liveFilterThreshold = sampleBreathFilterThreshold(
      breathFilter.keyframes,
      filterU,
      breathFilter.threshold,
    );

    if (breathFilter.enabled) {
      const nowMs = performance.now();
      const prevMs = breathFilterClockRef.current.lastMs;
      const dtSec = prevMs > 0 ? (nowMs - prevMs) / 1000 : 0;
      breathFilterClockRef.current.lastMs = nowMs;
      if (sampleBreathMask) {
        updateBreathFilterMemory(
          buffers.breathFilterMemory,
          buffers.breathFilterReleaseAge,
          buffers.breathColorFloats,
          buffers.breathCooldownRates,
          buffers.n,
          liveFilterThreshold,
          breathFilter.decayMaxSeconds,
          dtSec,
        );
      } else {
        // Still enforce the floor when breath isn't sampling this frame.
        const floor = clamp01(liveFilterThreshold);
        for (let i = 0; i < buffers.n; i++) {
          const v = buffers.breathFilterMemory[i];
          buffers.breathFilterMemory[i] =
            !(v >= 0) || !Number.isFinite(v) ? floor : Math.max(floor, v);
        }
      }
    }

    // Cloud breath-mod drive = mean per-LED TOD reveal gate (same
    // inhaleMask compositing uses). Threshold floors constantly; breath
    // path/linger raises memory temporarily. 1 = all LEDs fully revealed.
    if (breathLive && buffers.n > 0) {
      const useMemFilter = breathFilter.enabled;
      const thresh = clamp01(liveFilterThreshold);
      let sum = 0;
      for (let i = 0; i < buffers.n; i++) {
        const i3 = i * 3;
        const inhaleMask = useMemFilter
          ? breathFilterGate(buffers.breathFilterMemory[i], thresh)
          : clamp01(
              (buffers.breathColorFloats[i3] +
                buffers.breathColorFloats[i3 + 1] +
                buffers.breathColorFloats[i3 + 2]) /
                3,
            );
        sum += inhaleMask;
      }
      setBreathEffectDrive(sum / buffers.n);
    } else {
      setBreathEffectDrive(0);
    }

    // Strike scheduler runs whenever lightning is enabled and in its
    // active hour window — independent of view mode / pipeline stage —
    // so Strikes/min and the 3D bolt viz keep working even when LEDs
    // aren't taking the lightning contribution this frame.
    const lightningActive =
      lightning.enabled &&
      hourInRange(
        sky.timeHours,
        lightning.activeStartHour,
        lightning.activeEndHour,
      );
    const hasActiveLightning =
      lightningCtrl.getStrikes().length > 0 ||
      lightningCtrl.getSprites().length > 0;
    const lightningTick =
      lightningActive ||
      lightningCtrl.hasManualTriggers() ||
      hasActiveLightning;

    if (lightningTick) {
      // Strike spawn rate is always real wall-clock time (strikes per
      // real minute), independent of sky play speed and of simFps.
      // simFps only throttles the LED contribution / strobe look.
      const now = performance.now();
      const meshTiltRad = (meshTarget.tiltDeg * Math.PI) / 180;
      const meshYawRad = (meshTarget.yawDeg * Math.PI) / 180;
      const cloudXform = {
        tiltRad: cloudTiltRad + meshTiltRad,
        yawRad: cloudYawRad + meshYawRad,
        offsetX: cloud.offsetX,
        offsetY: cloud.offsetY + meshTarget.offsetY,
        offsetZ: cloud.offsetZ,
      };
      const half = meshHalfExtentsRef.current;
      const boltEllipsoid = half
        ? {
            rx: Math.max(1e-3, half.hx * meshTarget.scale * 0.9),
            ry: Math.max(1e-3, half.hy * meshTarget.scale * 0.9),
            rz: Math.max(1e-3, half.hz * meshTarget.scale * 0.9),
          }
        : ellipsoid;
      const keyframeU = activeWindowProgress(
        sky.timeHours,
        lightning.activeStartHour,
        lightning.activeEndHour,
      );
      const sampleBoltSurface = meshTarget.id
        ? (): [number, number, number] | null => {
            if (!sampleMeshSurfacePoint(meshTarget.id!, boltSurfacePoint)) {
              return null;
            }
            return [
              boltSurfacePoint.x * meshTarget.scale,
              boltSurfacePoint.y * meshTarget.scale,
              boltSurfacePoint.z * meshTarget.scale,
            ];
          }
        : undefined;
      lightningCtrl.update(
        now,
        lightning,
        boltEllipsoid,
        cloudXform,
        keyframeU,
        sampleBoltSurface,
      );
      const useLightning =
        (lightningActive ||
          lightningCtrl.getStrikes().length > 0 ||
          lightningCtrl.getSprites().length > 0) &&
        ledStreamPipeline.lightningStage &&
        ledViewMode !== "breathIntensity";

      const fps = Math.max(1, Math.min(60, Math.round(lightning.simFps || 60)));
      const frameMs = 1000 / fps;
      const lastRender = lightningRenderRef.current;
      if (now - lastRender >= frameMs) {
        lightningRenderRef.current = now;
        if (useLightning) {
          lightningCtrl.contribute(
            buffers.positions,
            buffers.n,
            buffers.lightningColorFloats,
            now,
            lightning,
            boltEllipsoid,
            cloudXform,
          );
        } else {
          buffers.lightningColorFloats.fill(0);
        }
      }
      // Between refreshes, keep the previous lightningColorFloats so the
      // last-rendered frame stays visible until the next sim tick.
      if (!useLightning) {
        buffers.lightningColorFloats.fill(0);
      }
    } else {
      buffers.lightningColorFloats.fill(0);
      lightningRenderRef.current = 0;
      // Don't accrue a strike backlog while disabled / outside hours.
      lightningCtrl.pauseClock(performance.now());
    }

    const rimAmount = clamp01(breath.rimAmount);

    // Select or blend pipelines per mode.
    if (ledViewMode === "breathIntensity") {
      // When the breath filter is on, show filter *memory* (not the live
      // wave mask) so per-LED decay variation is visible in this view.
      const showMemory = breathFilter.enabled;
      const thresh = clamp01(liveFilterThreshold);
      for (let i = 0; i < buffers.n; i++) {
        const i3 = i * 3;
        const v = showMemory
          ? breathFilterGate(buffers.breathFilterMemory[i], thresh)
          : buffers.breathColorFloats[i3];
        const w = clamp01(buffers.breathRimWeights[i] * rimAmount);
        const r = clamp01(v + (buffers.breathRimColors[i3] - v) * w);
        const g = clamp01(v + (buffers.breathRimColors[i3 + 1] - v) * w);
        const b = clamp01(v + (buffers.breathRimColors[i3 + 2] - v) * w);
        buffers.colorFloats[i3] = r;
        buffers.colorFloats[i3 + 1] = g;
        buffers.colorFloats[i3 + 2] = b;
        buffers.colorBytes[i3] = (r * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 1] = (g * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 2] = (b * 255 + 0.5) | 0;
      }
    } else if (ledViewMode === "timeOfDay") {
      for (let i = 0; i < buffers.n; i++) {
        const i3 = i * 3;
        const r = clamp01(buffers.timeColorFloats[i3] + buffers.lightningColorFloats[i3]);
        const g = clamp01(buffers.timeColorFloats[i3 + 1] + buffers.lightningColorFloats[i3 + 1]);
        const b = clamp01(buffers.timeColorFloats[i3 + 2] + buffers.lightningColorFloats[i3 + 2]);
        buffers.colorFloats[i3] = r;
        buffers.colorFloats[i3 + 1] = g;
        buffers.colorFloats[i3 + 2] = b;
        buffers.colorBytes[i3] = (r * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 1] = (g * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 2] = (b * 255 + 0.5) | 0;
      }
    } else {
      const mix = ledStreamPipeline.breathStage ? clamp01(breath.breathVsTimeMix) : 0;
      const useMemFilter = breathFilter.enabled;
      const thresh = clamp01(liveFilterThreshold);
      for (let i = 0; i < buffers.n; i++) {
        const i3 = i * 3;
        const tr = buffers.timeColorFloats[i3];
        const tg = buffers.timeColorFloats[i3 + 1];
        const tb = buffers.timeColorFloats[i3 + 2];
        const br = buffers.breathColorFloats[i3];
        const bg = buffers.breathColorFloats[i3 + 1];
        const bb = buffers.breathColorFloats[i3 + 2];
        let r = tr;
        let g = tg;
        let b = tb;
        const inhaleMask = useMemFilter
          ? breathFilterGate(buffers.breathFilterMemory[i], thresh)
          : clamp01((br + bg + bb) / 3);
        if (breathLive && ledStreamPipeline.breathStage) {
          if (breathTimeCombineMode === "revealOnInhale") {
            // During the breath period, reveal time-of-day where inhale is active.
            r = tr * inhaleMask;
            g = tg * inhaleMask;
            b = tb * inhaleMask;
          } else {
            // Linear filter depth: 0 = unfiltered time-of-day, 1 = fully masked.
            const filter = 1 - mix + mix * inhaleMask;
            r = tr * filter;
            g = tg * filter;
            b = tb * filter;
          }
          // Participant-colour rim shell around the active wave surface.
          const w = clamp01(buffers.breathRimWeights[i] * rimAmount);
          if (w > 0) {
            r = r + (buffers.breathRimColors[i3] - r) * w;
            g = g + (buffers.breathRimColors[i3 + 1] - g) * w;
            b = b + (buffers.breathRimColors[i3 + 2] - b) * w;
          }
        }
        r = clamp01(r + buffers.lightningColorFloats[i3]);
        g = clamp01(g + buffers.lightningColorFloats[i3 + 1]);
        b = clamp01(b + buffers.lightningColorFloats[i3 + 2]);
        buffers.colorFloats[i3] = r;
        buffers.colorFloats[i3 + 1] = g;
        buffers.colorFloats[i3 + 2] = b;
        buffers.colorBytes[i3] = (r * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 1] = (g * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 2] = (b * 255 + 0.5) | 0;
      }
    }

    // Final debug override: cooldown noise wins over view mode + locator.
    const showNoise = breathFilter.showNoise;
    if (showNoise) {
      for (let i = 0; i < buffers.n; i++) {
        const i3 = i * 3;
        const v = clamp01(buffers.breathCooldownRates[i] ?? 0);
        buffers.colorFloats[i3] = v;
        buffers.colorFloats[i3 + 1] = v;
        buffers.colorFloats[i3 + 2] = v;
        buffers.colorBytes[i3] = (v * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 1] = (v * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 2] = (v * 255 + 0.5) | 0;
      }
    }

    const locatorColor = linearHex(ledLocator.color);
    for (let i = 0; i < buffers.n; i++) {
      const i3 = i * 3;
      if (
        !showNoise &&
        ledStreamPipeline.locatorOverrideStage &&
        ledLocator.enabled &&
        locatedSet.has(i)
      ) {
        // Hard output override: bypass all prior processing and force this LED
        // to locator yellow both in the 3D view and in streamed byte output.
        buffers.colorFloats[i3] = locatorColor[0];
        buffers.colorFloats[i3 + 1] = locatorColor[1];
        buffers.colorFloats[i3 + 2] = locatorColor[2];
        buffers.colorBytes[i3] = (locatorColor[0] * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 1] = (locatorColor[1] * 255 + 0.5) | 0;
        buffers.colorBytes[i3 + 2] = (locatorColor[2] * 255 + 0.5) | 0;
      }
      const [red, green, blue] = encodeLedRgb(
        buffers.colorFloats[i3],
        buffers.colorFloats[i3 + 1],
        buffers.colorFloats[i3 + 2],
        strand.colorProfile,
      );
      tmpColor.setRGB(red / 255, green / 255, blue / 255);
      mesh.setColorAt(i, tmpColor);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // Unmapped strand slots retain their physical indices but must not emit
    // from the origin or contribute to the cloud-top diffuser.
    for (let i = 0; i < buffers.n; i++) {
      if (buffers.validPositions[i]) continue;
      const i3 = i * 3;
      buffers.colorFloats[i3] = 0;
      buffers.colorFloats[i3 + 1] = 0;
      buffers.colorFloats[i3 + 2] = 0;
      buffers.colorBytes[i3] = 0;
      buffers.colorBytes[i3 + 1] = 0;
      buffers.colorBytes[i3 + 2] = 0;
    }

    // Apply one hue-preserving brightness curve to the final LED signal.
    for (let i = 0; i < buffers.n; i++) {
      const i3 = i * 3;
      const [red, green, blue] = encodeLedRgb(
        buffers.colorFloats[i3],
        buffers.colorFloats[i3 + 1],
        buffers.colorFloats[i3 + 2],
        strand.colorProfile,
      );
      buffers.colorBytes[i3] = red;
      buffers.colorBytes[i3 + 1] = green;
      buffers.colorBytes[i3 + 2] = blue;
    }

    // Suppress 1-LSB chatter in streamed bytes. This removes tiny histogram
    // flicker from floating-point noise while preserving meaningful motion.
    const byteCount = buffers.n * 3;
    if (!stableBytesRef.current || stableBytesRef.current.length !== byteCount) {
      stableBytesRef.current = new Uint8Array(buffers.colorBytes);
    } else {
      const stable = stableBytesRef.current;
      for (let i = 0; i < byteCount; i++) {
        const next = buffers.colorBytes[i];
        const prev = stable[i];
        if (Math.abs(next - prev) <= STREAM_BYTE_DEADBAND) {
          buffers.colorBytes[i] = prev;
        } else {
          stable[i] = next;
        }
      }
    }
    for (let i = 0; i < buffers.n; i++) {
      if (buffers.validPositions[i]) continue;
      const i3 = i * 3;
      buffers.colorBytes[i3] = 0;
      buffers.colorBytes[i3 + 1] = 0;
      buffers.colorBytes[i3 + 2] = 0;
      stableBytesRef.current![i3] = 0;
      stableBytesRef.current![i3 + 1] = 0;
      stableBytesRef.current![i3 + 2] = 0;
    }

    publishFrame(buffers.colorBytes, buffers.n);

    if (wled.enabled) {
      const now = performance.now();
      const minDelta = 1000 / Math.max(1, wled.fps);
      if (now - lastSendRef.current >= minDelta) {
        if (wledClient.send(buffers.colorBytes)) {
          lastSendRef.current = now;
        }
      }
    }
  });

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!ledLocator.enabled) return;
    if (e.instanceId === undefined || e.instanceId === null) return;
    e.stopPropagation();
    toggleLocatedLed(e.instanceId);
  };

  // Keep the instanced mesh mounted while the diffuser is shown. Unmounting
  // it loses the mapped instance matrices; remounting would briefly place
  // every default instance at the origin as one large overlapping cap.
  const showDirectLeds = !(cloudTop.id && cloudTop.visible);

  const markerKind = ledDisplayMode === "sensors" ? "sensor" : "led";
  return (
    <instancedMesh
      key={`led-markers-${markerKind}`}
      ref={meshRef}
      args={[undefined, undefined, buffers.n]}
      frustumCulled={false}
      visible={showDirectLeds}
      onPointerDown={onPointerDown}
      renderOrder={5}
    >
      <sphereGeometry args={markerSphereArgs(1, markerKind)} />
      <meshStandardMaterial
        {...MARKER_MATERIAL_DEFAULTS}
        color="#ffffff"
        emissive="#ffffff"
        emissiveIntensity={1}
        opacity={1}
        onBeforeCompile={applyMarkerInstanceEmissive}
        customProgramCacheKey={() => "marker-instance-emissive-v1"}
      />
    </instancedMesh>
  );
}
