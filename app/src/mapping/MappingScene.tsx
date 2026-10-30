import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Billboard, Line, OrbitControls, Text } from "@react-three/drei";
import {
  BufferGeometry,
  Color,
  DoubleSide,
  Euler,
  Float32BufferAttribute,
  Matrix3,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  Raycaster,
  Vector2,
  Vector3,
} from "three";
import { useSimStore, type Vec3 } from "../state";
import { applyMappingOrientationPoint } from "./geometry";
import {
  buildBakedDomeSurface,
  DOME_FOOTPRINT_SCALE,
  displaceLed,
  gaussianRayTransmission,
  gaussianTangentFrame,
  orientGaussians,
} from "./gaussians";
import { loadMeshGeometry } from "./meshAsset";
import { WledStreamClient } from "../wled/client";
import {
  pointLightDistanceAttenuation,
  sensorAngularResponse,
  spotConeAttenuation,
  spreadToSpotAngle,
} from "../lighting/shade";
import { encodeLedRgb, srgbChannelToLinear } from "../lighting/ledColor";
import {
  clearBakedSurfaceGeometry,
  getBakedSurfaceGeometry,
  setBakedSurfaceGeometry,
} from "./bakedSurface";
import { mappingBakeSignature } from "./bakeSignature";
import {
  alignMarkerNormal,
  MARKER_MATERIAL_DEFAULTS,
  markerRadius,
  markerSphereArgs,
} from "./markerVisual";

interface Props {
  selected: number | null;
  setSelected: (index: number | null) => void;
  selectedGaussianId: string | null;
  setSelectedGaussianId: (id: string | null) => void;
}

const GAUSS_COLOR = "#7ec8ff";
const GAUSS_SELECTED = "#ffe14d";
const SENSOR_HEMISPHERE_SAMPLES = Array.from({ length: 32 }, (_, i) => {
  const z = (i + 0.5) / 32;
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return [Math.cos(phi) * r, Math.sin(phi) * r, z] as Vec3;
});

/** Allowed range for per-LED normal offset (metres). Outward only. */
const OFFSET_MIN = 0;
const OFFSET_MAX = 0.5;

export function MappingScene({
  selected,
  setSelected,
  selectedGaussianId,
  setSelectedGaussianId,
}: Props) {
  const mapping = useSimStore((s) => s.mapping);
  const setMapping = useSimStore((s) => s.setMapping);
  const strand = useSimStore((s) => s.strand);
  const cloud = useSimStore((s) => s.cloud);
  const wled = useSimStore((s) => s.wled);
  const mesh = useSimStore((s) => s.mesh);
  const addMappedLed = useSimStore((s) => s.addMappedLed);
  const moveMappedLed = useSimStore((s) => s.moveMappedLed);
  const updateMappedLed = useSimStore((s) => s.updateMappedLed);
  const addMappingGaussian = useSimStore((s) => s.addMappingGaussian);
  const updateMappingGaussian = useSimStore((s) => s.updateMappingGaussian);
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);

  const [meshGeom, setMeshGeom] = useState<BufferGeometry | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!mesh.id) {
      setMeshGeom(null);
      return;
    }
    loadMeshGeometry(mesh.id).then((g) => {
      if (!cancelled) setMeshGeom(g);
    });
    return () => {
      cancelled = true;
    };
  }, [mesh.id]);

  const draggingRef = useRef<number | null>(null);
  const downPosRef = useRef<{ x: number; y: number } | null>(null);
  const offsetDragRef = useRef<{
    index: number;
    baseWorld: Vector3;
    axis: Vector3;
    ledSize: number;
  } | null>(null);
  const gaussianDragIdRef = useRef<string | null>(null);
  const raycaster = useMemo(() => new Raycaster(), []);
  const pointerNdc = useMemo(() => new Vector2(), []);
  const [orbitEnabled, setOrbitEnabled] = useState(true);
  const [hover, setHover] = useState<{ pos: Vec3; normal: Vec3 } | null>(null);
  const mappingLightTarget = useMemo<Vec3>(
    () => [0, mesh.offsetY, 0],
    [mesh.offsetY],
  );
  const mappingLightPos = useMemo<Vec3>(() => {
    const azimuth = (mapping.mappingLightAngleDeg * Math.PI) / 180;
    // UI sweep 0..360 maps monotonically from +90° (above) to −90° (below).
    const elevation =
      (90 - mapping.mappingLightElevationDeg * 0.5) * (Math.PI / 180);
    const radius = mapping.mappingLightRadius;
    const horizontalRadius = Math.cos(elevation) * radius;
    return [
      mappingLightTarget[0] + Math.cos(azimuth) * horizontalRadius,
      mappingLightTarget[1] + Math.sin(elevation) * radius,
      mappingLightTarget[2] + Math.sin(azimuth) * horizontalRadius,
    ];
  }, [
    mapping.mappingLightAngleDeg,
    mapping.mappingLightElevationDeg,
    mapping.mappingLightRadius,
    mappingLightTarget,
  ]);
  const mappingSpotTarget = useMemo(() => new Object3D(), []);
  useLayoutEffect(() => {
    mappingSpotTarget.position.set(...mappingLightTarget);
    mappingSpotTarget.updateMatrixWorld();
  }, [mappingLightTarget, mappingSpotTarget]);

  const isOffsetTool = mapping.tool === "offset";
  const isGaussianTool = mapping.tool === "gaussian";
  const isPlaceTool = mapping.tool === "place";

  useEffect(() => {
    const up = () => {
      if (
        draggingRef.current !== null ||
        offsetDragRef.current !== null ||
        gaussianDragIdRef.current !== null
      ) {
        draggingRef.current = null;
        offsetDragRef.current = null;
        gaussianDragIdRef.current = null;
        setOrbitEnabled(true);
      }
    };
    window.addEventListener("pointerup", up);
    return () => window.removeEventListener("pointerup", up);
  }, []);

  // Offset mode: project the camera ray onto the LED's outward-normal
  // axis and write only `offset` (hand-placed pos/normal unchanged).
  useEffect(() => {
    if (!isOffsetTool) return;
    const onMove = (ev: PointerEvent) => {
      const drag = offsetDragRef.current;
      if (!drag) return;
      const rect = gl.domElement.getBoundingClientRect();
      pointerNdc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointerNdc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNdc, camera);
      const ray = raycaster.ray;
      const r0 = ray.origin;
      const rd = ray.direction;
      const p0 = drag.baseWorld;
      const d = drag.axis;
      const w0x = r0.x - p0.x;
      const w0y = r0.y - p0.y;
      const w0z = r0.z - p0.z;
      const a = d.dot(d);
      const b = d.dot(rd);
      const c = rd.dot(rd);
      const dW = d.x * w0x + d.y * w0y + d.z * w0z;
      const e = rd.x * w0x + rd.y * w0y + rd.z * w0z;
      const denom = a * c - b * b;
      let t: number;
      if (Math.abs(denom) < 1e-10) {
        t = dW / (a || 1);
      } else {
        t = (b * e - c * dW) / denom;
      }
      const next = Math.max(OFFSET_MIN, Math.min(OFFSET_MAX, t - drag.ledSize));
      updateMappedLed(drag.index, { offset: next });
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [isOffsetTool, camera, gl.domElement, raycaster, pointerNdc, updateMappedLed]);

  // World-space transform of the uploaded mesh — recomputed whenever
  // scale/offset/rotation change so LEDs (stored in mesh-local space)
  // stay glued to the surface as the mesh is repositioned.
  const meshMatrix = useMemo(() => {
    const q = new Quaternion().setFromEuler(
      new Euler(
        (mesh.tiltDeg * Math.PI) / 180,
        (mesh.yawDeg * Math.PI) / 180,
        0,
        "XYZ",
      ),
    );
    return new Matrix4().compose(
      new Vector3(0, mesh.offsetY, 0),
      q,
      new Vector3(mesh.scale, mesh.scale, mesh.scale),
    );
  }, [mesh.scale, mesh.offsetY, mesh.yawDeg, mesh.tiltDeg]);

  const meshNormalMat = useMemo(
    () => new Matrix3().getNormalMatrix(meshMatrix),
    [meshMatrix],
  );
  const meshInverse = useMemo(() => meshMatrix.clone().invert(), [meshMatrix]);
  const meshOccluder = useMemo(
    () =>
      meshGeom
        ? new Mesh(meshGeom, new MeshBasicMaterial({ side: DoubleSide }))
        : null,
    [meshGeom],
  );
  useEffect(
    () => () => {
      meshOccluder?.material.dispose();
    },
    [meshOccluder],
  );
  const meshOcclusionRaycaster = useMemo(() => new Raycaster(), []);
  const mappingLightLocal = useMemo<Vec3>(() => {
    const p = new Vector3(...mappingLightPos).applyMatrix4(meshInverse);
    return [p.x, p.y, p.z];
  }, [mappingLightPos, meshInverse]);

  const localToWorldPos = (local: Vec3): Vec3 => {
    const v = new Vector3(local[0], local[1], local[2]).applyMatrix4(meshMatrix);
    return [v.x, v.y, v.z];
  };
  const localToWorldNrm = (local: Vec3): Vec3 => {
    const v = new Vector3(local[0], local[1], local[2])
      .applyMatrix3(meshNormalMat)
      .normalize();
    return [v.x, v.y, v.z];
  };

  const orientedGaussians = useMemo(
    () =>
      orientGaussians(
        mapping.gaussians,
        mapping.flipUpDown,
        mapping.flipLeftRight,
        applyMappingOrientationPoint,
      ),
    [mapping.gaussians, mapping.flipUpDown, mapping.flipLeftRight],
  );
  const currentBakeSignature = useMemo(
    () => mappingBakeSignature(mapping),
    [mapping],
  );
  const bakedSurface = getBakedSurfaceGeometry();
  useEffect(() => {
    if (mapping.useBakedSurface) setMapping({ useBakedSurface: false });
  }, [mapping.useBakedSurface, setMapping]);
  useEffect(() => {
    if (mapping.bakeSurfaceRequestNonce <= 0) return;
    const bakedRender = buildBakedDomeSurface(
      orientedGaussians,
      mapping.bumpAdditivity,
      { radialSteps: 16, angularSteps: 48 },
    );
    const bakedOccluder = buildBakedDomeSurface(
      orientedGaussians,
      mapping.bumpAdditivity,
      { radialSteps: 8, angularSteps: 20 },
    );
    setBakedSurfaceGeometry(bakedRender, bakedOccluder);
    setMapping({
      bakedSurfaceSignature: currentBakeSignature,
      showBakedSurface: bakedRender !== null,
      bakeSurfaceRequestNonce: 0,
    });
  }, [
    mapping.bakeSurfaceRequestNonce,
    orientedGaussians,
    mapping.bumpAdditivity,
    currentBakeSignature,
    setMapping,
  ]);
  useEffect(() => {
    if ((mapping.gaussians?.length ?? 0) > 0) return;
    clearBakedSurfaceGeometry();
    if (
      mapping.bakedSurfaceSignature !== null ||
      mapping.showBakedSurface ||
      mapping.useBakedSurface
    ) {
      setMapping({
        bakedSurfaceSignature: null,
        showBakedSurface: false,
        useBakedSurface: false,
      });
    }
  }, [
    mapping.gaussians,
    mapping.bakedSurfaceSignature,
    mapping.showBakedSurface,
    mapping.useBakedSurface,
    setMapping,
  ]);

  const beads = useMemo(() => {
    // LEDs without a mesh-mode surface record (pos+normal) can't be
    // placed on an arbitrary mesh, so they're skipped here. Stored pos
    // and normal are in mesh-local space; Gaussians + per-LED offset
    // displace first, then we transform to world. Hemispheres sit flat
    // on that surface with the dome along the (tilted) normal.
    return mapping.leds
      .map((led, physicalIndex) => {
        if (!led.pos || !led.normal) return null;
        const lp = applyMappingOrientationPoint(
          led.pos,
          mapping.flipUpDown,
          mapping.flipLeftRight,
        );
        const ln = applyMappingOrientationPoint(
          led.normal,
          mapping.flipUpDown,
          mapping.flipLeftRight,
        );
        const showEdits = mapping.showOffsetsAndDomes !== false;
        const surfaceGaussians = showEdits ? orientedGaussians : [];
        const displaced = displaceLed(
          lp,
          ln,
          surfaceGaussians,
          showEdits ? (led.offset ?? 0) : 0,
          mapping.bumpAdditivity,
        );
        const displaced0 = displaceLed(
          lp,
          ln,
          surfaceGaussians,
          0,
          mapping.bumpAdditivity,
        );
        const displacedNormal = alignMarkerNormal(displaced.normal, ln);
        const displaced0Normal = alignMarkerNormal(displaced0.normal, ln);
        const wp = localToWorldPos(displaced.pos);
        const wn = localToWorldNrm(displacedNormal);
        const baseWorld = localToWorldPos(displaced0.pos);
        const baseNormal = localToWorldNrm(displaced0Normal);
        const quat = new Quaternion().setFromUnitVectors(
          new Vector3(0, 1, 0),
          new Vector3(wn[0], wn[1], wn[2]),
        );
        return {
          physicalIndex,
          pos: wp,
          normal: wn,
          localPos: displaced.pos,
          localNormal: displacedNormal,
          quat,
          baseWorld,
          baseNormal,
        };
      })
      .filter(
        (
          b,
        ): b is {
          physicalIndex: number;
          pos: Vec3;
          normal: Vec3;
          localPos: Vec3;
          localNormal: Vec3;
          quat: Quaternion;
          baseWorld: Vec3;
          baseNormal: Vec3;
        } => b !== null,
      );
  }, [
    mapping.leds,
    mapping.flipUpDown,
    mapping.flipLeftRight,
    mapping.showOffsetsAndDomes,
    orientedGaussians,
    mapping.bumpAdditivity,
    meshMatrix,
    meshNormalMat,
  ]);
  const beadByPhysicalIndex = useMemo(
    () => new Map(beads.map((bead) => [bead.physicalIndex, bead])),
    [beads],
  );
  const wledClient = useMemo(() => new WledStreamClient(), []);
  const lastMappingSendRef = useRef(0);
  const lastMappingPreviewRef = useRef(0);
  const outputMaterialRefs = useRef<Array<MeshStandardMaterial | null>>([]);
  const outputLevelsRef = useRef<Float32Array>(
    new Float32Array(mapping.leds.length),
  );
  useEffect(() => {
    if (wled.enabled) wledClient.start();
    else wledClient.stop();
    return () => wledClient.stop();
  }, [wled.enabled, wledClient]);
  useEffect(() => {
    wledClient.setTarget(wled.host, 4048);
  }, [wled.host, wledClient]);
  useFrame(() => {
    if (mapping.leds.length === 0) return;
    const now = performance.now();
    const previewDue = now - lastMappingPreviewRef.current >= 1000 / 30;
    const streamDue =
      wled.enabled &&
      now - lastMappingSendRef.current >= 1000 / Math.max(1, wled.fps);
    if (!previewDue && !streamDue) return;
    const packedColor = Number.parseInt(mapping.mappingLightColor.slice(1), 16);
    const outputR = srgbChannelToLinear(((packedColor >> 16) & 255) / 255);
    const outputG = srgbChannelToLinear(((packedColor >> 8) & 255) / 255);
    const outputB = srgbChannelToLinear((packedColor & 255) / 255);
    if (outputLevelsRef.current.length !== mapping.leds.length) {
      outputLevelsRef.current = new Float32Array(mapping.leds.length);
    }
    // Preserve one RGB triplet per configured strip index. Missing mapping
    // positions stay black instead of being removed and shifting later LEDs.
    const bytes = new Uint8Array(mapping.leds.length * 3);
    for (let outIndex = 0; outIndex < mapping.leds.length; outIndex++) {
      const physicalIndex = mapping.reversed
        ? mapping.leds.length - 1 - outIndex
        : outIndex;
      const bead = beadByPhysicalIndex.get(physicalIndex);
      if (!bead) continue;
      let meshTransmission = 1;
      const pyramidBlocked = 1 - Math.max(0, Math.min(1, mapping.pyramidLightOpacity));
      const lightFromPosLocal: Vec3 = [
        mappingLightLocal[0] - bead.localPos[0],
        mappingLightLocal[1] - bead.localPos[1],
        mappingLightLocal[2] - bead.localPos[2],
      ];
      const lightLenLocal = Math.hypot(...lightFromPosLocal) || 1e-6;
      const lightDirLocal: Vec3 = [
        lightFromPosLocal[0] / lightLenLocal,
        lightFromPosLocal[1] / lightLenLocal,
        lightFromPosLocal[2] / lightLenLocal,
      ];
      // If a sensor sees light from behind its outward surface normal, that
      // path necessarily goes through the pyramid body and should be blocked.
      const normalFacingLight =
        bead.localNormal[0] * lightDirLocal[0] +
        bead.localNormal[1] * lightDirLocal[1] +
        bead.localNormal[2] * lightDirLocal[2];
      if (normalFacingLight <= 0) meshTransmission = pyramidBlocked;
      if (meshOccluder) {
        // Start at the outward tip of the physical sensor hemisphere. This
        // avoids a self-hit on its own mounting face while still catching
        // an opposite pyramid wall before the ray reaches the light.
        const localSensorRadius =
          strand.ledSize / Math.max(1e-6, Math.abs(mesh.scale));
        const meshRayOrigin = new Vector3(
          bead.localPos[0] + bead.localNormal[0] * localSensorRadius,
          bead.localPos[1] + bead.localNormal[1] * localSensorRadius,
          bead.localPos[2] + bead.localNormal[2] * localSensorRadius,
        );
        const meshRayDirection = new Vector3(
          mappingLightLocal[0] - meshRayOrigin.x,
          mappingLightLocal[1] - meshRayOrigin.y,
          mappingLightLocal[2] - meshRayOrigin.z,
        );
        const meshRayDistance = meshRayDirection.length();
        if (meshRayDistance > 1e-5) {
          meshOcclusionRaycaster.near = 0;
          meshOcclusionRaycaster.far = Math.max(1e-4, meshRayDistance - 1e-4);
          meshOcclusionRaycaster.set(
            meshRayOrigin,
            meshRayDirection.multiplyScalar(1 / meshRayDistance),
          );
          if (meshOcclusionRaycaster.intersectObject(meshOccluder, false).length > 0) {
            meshTransmission = Math.min(meshTransmission, pyramidBlocked);
          }
        }
      }
      const sensorFrame = gaussianTangentFrame(bead.normal, 0);
      const centerLx = mappingLightPos[0] - bead.pos[0];
      const centerLy = mappingLightPos[1] - bead.pos[1];
      const centerLz = mappingLightPos[2] - bead.pos[2];
      const centerDistance =
        Math.hypot(centerLx, centerLy, centerLz) || 1e-6;
      const centerDirX = centerLx / centerDistance;
      const centerDirY = centerLy / centerDistance;
      const centerDirZ = centerLz / centerDistance;
      const distanceAttenuation = pointLightDistanceAttenuation(
        centerDistance,
        mapping.mappingLightDecay,
      );
      const coneAttenuation = spotConeAttenuation(
        mappingLightPos,
        mappingLightTarget,
        bead.pos,
        spreadToSpotAngle(mapping.mappingLightSpread),
        mapping.mappingLightFocus,
      );
      const domeTransmission =
        mapping.showOffsetsAndDomes !== false &&
        mapping.bumpLightOpacity > 0 &&
        orientedGaussians.length > 0
          ? gaussianRayTransmission(
              bead.localPos,
              lightFromPosLocal,
              lightLenLocal,
              orientedGaussians,
              mapping.bumpLightOpacity,
              bead.localNormal,
            )
          : 1;
      let weightedLight = 0;
      let totalWeight = 0;
      for (const sample of SENSOR_HEMISPHERE_SAMPLES) {
        const sx =
          sample[0] * sensorFrame.tW[0] +
          sample[1] * sensorFrame.tH[0] +
          sample[2] * sensorFrame.n[0];
        const sy =
          sample[0] * sensorFrame.tW[1] +
          sample[1] * sensorFrame.tH[1] +
          sample[2] * sensorFrame.n[1];
        const sz =
          sample[0] * sensorFrame.tW[2] +
          sample[1] * sensorFrame.tH[2] +
          sample[2] * sensorFrame.n[2];
        const cosine =
          sx * centerDirX + sy * centerDirY + sz * centerDirZ;
        const response = sensorAngularResponse(
          cosine,
          mapping.mappingLightSpread,
          cloud.opacity,
        );
        const weight =
          strand.sensorHemisphereFocus > 0
            ? Math.pow(sample[2], strand.sensorHemisphereFocus)
            : 1;
        weightedLight +=
          response *
          distanceAttenuation *
          coneAttenuation *
          domeTransmission *
          meshTransmission *
          weight;
        totalWeight += weight;
      }
      const averagedLight = weightedLight / Math.max(1e-6, totalWeight);
      const level = Math.max(
        0,
        Math.min(
          1,
          averagedLight * mapping.mappingLightIntensity,
        ),
      );
      outputLevelsRef.current[physicalIndex] = level;
      const [red, green, blue] = encodeLedRgb(
        level * outputR,
        level * outputG,
        level * outputB,
        strand.colorProfile,
      );
      bytes[outIndex * 3] = red;
      bytes[outIndex * 3 + 1] = green;
      bytes[outIndex * 3 + 2] = blue;
      const material = outputMaterialRefs.current[physicalIndex];
      if (previewDue && material) {
        material.color.setRGB(red / 255, green / 255, blue / 255);
        material.emissive.copy(material.color);
        material.emissiveIntensity = 1;
      }
    }
    if (previewDue) lastMappingPreviewRef.current = now;
    if (streamDue && wledClient.send(bytes)) lastMappingSendRef.current = now;
  });

  const gaussianMarkers = useMemo(() => {
    return orientedGaussians.map((g) => {
      const wp = localToWorldPos(g.pos);
      const wn = localToWorldNrm(g.normal);
      const lift = mapping.ledSize * 0.5;
      const pos: Vec3 = [
        wp[0] + wn[0] * lift,
        wp[1] + wn[1] * lift,
        wp[2] + wn[2] * lift,
      ];
      // Compact smooth dome used by displaceLed. It has the footprint of the
      // former clipped Gaussian, but reaches zero height and slope at its edge.
      const localFrame = gaussianTangentFrame(g.normal, g.rotationDeg ?? 0);
      const radialSteps = 16;
      const angularSteps = 48;
      // A radial mesh follows the exact elliptical support boundary.
      const extent = DOME_FOOTPRINT_SCALE;
      const vertices: number[] = [];
      const indices: number[] = [];
      const pushVertex = (ux: number, vy: number) => {
          const u = ux * g.width;
          const v = vy * g.height;
          const base: Vec3 = [
            g.pos[0] +
              localFrame.tW[0] * u +
              localFrame.tH[0] * v,
            g.pos[1] +
              localFrame.tW[1] * u +
              localFrame.tH[1] * v,
            g.pos[2] +
              localFrame.tW[2] * u +
              localFrame.tH[2] * v,
          ];
          const local = displaceLed(
            base,
            g.normal,
            orientedGaussians,
            0,
            mapping.bumpAdditivity,
          ).pos;
          const world = localToWorldPos(local);
          vertices.push(world[0], world[1], world[2]);
      };
      pushVertex(0, 0);
      for (let ring = 1; ring <= radialSteps; ring++) {
        const radius = (ring / radialSteps) * extent;
        for (let segment = 0; segment < angularSteps; segment++) {
          const a = (segment / angularSteps) * Math.PI * 2;
          pushVertex(Math.cos(a) * radius, Math.sin(a) * radius);
        }
      }
      for (let segment = 0; segment < angularSteps; segment++) {
        indices.push(0, 1 + segment, 1 + ((segment + 1) % angularSteps));
      }
      for (let ring = 1; ring < radialSteps; ring++) {
        const inner = 1 + (ring - 1) * angularSteps;
        const outer = 1 + ring * angularSteps;
        for (let segment = 0; segment < angularSteps; segment++) {
          const next = (segment + 1) % angularSteps;
          indices.push(
            inner + segment,
            outer + segment,
            inner + next,
            inner + next,
            outer + segment,
            outer + next,
          );
        }
      }
      const surface = new BufferGeometry();
      surface.setAttribute("position", new Float32BufferAttribute(vertices, 3));
      surface.setIndex(indices);
      surface.computeVertexNormals();
      return {
        id: g.id,
        pos,
        normal: wn,
        surface,
      };
    });
  }, [
    orientedGaussians,
    mapping.bumpAdditivity,
    mapping.ledSize,
    meshMatrix,
    meshNormalMat,
  ]);
  useEffect(
    () => () => {
      for (const marker of gaussianMarkers) marker.surface.dispose();
    },
    [gaussianMarkers],
  );

  const linePoints = useMemo<Vec3[]>(
    () => beads.map((b) => [...b.pos] as Vec3),
    [beads],
  );

  const facesCamera = (pos: Vec3, normal: Vec3): boolean => {
    const vx = camera.position.x - pos[0];
    const vy = camera.position.y - pos[1];
    const vz = camera.position.z - pos[2];
    return normal[0] * vx + normal[1] * vy + normal[2] * vz > 0;
  };

  // Mesh-local hit + normal from a pointer event on the uploaded mesh.
  // Storing in local space is what keeps LEDs glued to the surface when
  // the mesh's scale/rotation/offset sliders change afterwards. We derive
  // the world hit + normal alongside for hover/max-seg checks that need
  // to compare against previously-placed beads in world space.
  const surfaceFromEvent = (
    e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>,
  ): {
    localPos: Vec3;
    localNormal: Vec3;
    worldPos: Vec3;
    worldNormal: Vec3;
    dir: Vec3;
  } | null => {
    if (!e.face || !e.object) return null;
    e.object.updateMatrixWorld();
    const localVec = e.object.worldToLocal(
      new Vector3(e.point.x, e.point.y, e.point.z),
    );
    const localPos: Vec3 = [localVec.x, localVec.y, localVec.z];
    const localNormal: Vec3 = [
      e.face.normal.x,
      e.face.normal.y,
      e.face.normal.z,
    ];
    const nMat = new Matrix3().getNormalMatrix(e.object.matrixWorld);
    const wn = new Vector3(
      e.face.normal.x,
      e.face.normal.y,
      e.face.normal.z,
    )
      .applyMatrix3(nMat)
      .normalize();
    const worldPos: Vec3 = [e.point.x, e.point.y, e.point.z];
    const worldNormal: Vec3 = [wn.x, wn.y, wn.z];
    const l = Math.hypot(worldPos[0], worldPos[1], worldPos[2]) || 1;
    const dir: Vec3 = [worldPos[0] / l, worldPos[1] / l, worldPos[2] / l];
    return { localPos, localNormal, worldPos, worldNormal, dir };
  };

  // Previous bead's world-space position (after flips + normal offset),
  // used both to draw the hover preview line and to enforce the
  // max-segment-length rule. Null when the strand is empty.
  const prevBeadPos: Vec3 | null =
    beads.length > 0 ? beads[beads.length - 1].pos : null;

  const distance = (a: Vec3, b: Vec3) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  const withinMaxSeg = (candidate: Vec3): boolean => {
    if (!prevBeadPos) return true;
    return distance(candidate, prevBeadPos) <= mapping.maxSegmentLength + 1e-6;
  };

  // Reject placements/drags that would overlap an existing bead. Minimum
  // centre-to-centre distance is one bead diameter so beads sit side by
  // side but never on top of each other.
  const overlapsExisting = (candidate: Vec3, ignoreIndex?: number): boolean => {
    const minDist = mapping.ledSize * 2 - 1e-6;
    for (let i = 0; i < beads.length; i++) {
      if (i === ignoreIndex) continue;
      if (distance(candidate, beads[i].pos) < minDist) return true;
    }
    return false;
  };

  const onSurfaceClick = (e: ThreeEvent<MouseEvent>) => {
    if (isOffsetTool) return;
    if (draggingRef.current !== null || gaussianDragIdRef.current !== null) return;
    const down = downPosRef.current;
    downPosRef.current = null;
    if (down) {
      const moved = Math.hypot(
        e.nativeEvent.clientX - down.x,
        e.nativeEvent.clientY - down.y,
      );
      if (moved > 5) return;
    }
    e.stopPropagation();
    const hit = surfaceFromEvent(e);
    if (!hit) return;

    if (isGaussianTool) {
      const dispPos = applyMappingOrientationPoint(
        hit.localPos,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      const dispNrm = applyMappingOrientationPoint(
        hit.localNormal,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      // Store un-flipped? LEDs store after flip application on write.
      // Same as LED place: store flipped coords.
      const id = `gaussian-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
      addMappingGaussian({
        id,
        pos: dispPos,
        normal: dispNrm,
        amplitude: 0.05,
        width: 0.08,
        height: 0.08,
        rotationDeg: 0,
      });
      setSelectedGaussianId(id);
      setSelected(null);
      setHover(null);
      return;
    }

    if (!isPlaceTool) return;
    const previewWorld: Vec3 = [
      hit.worldPos[0],
      hit.worldPos[1],
      hit.worldPos[2],
    ];
    if (!withinMaxSeg(previewWorld)) return;
    if (overlapsExisting(previewWorld)) return;
    const nextIndex = useSimStore.getState().mapping.leds.length;
    const dispPos = applyMappingOrientationPoint(
      hit.localPos,
      mapping.flipUpDown,
      mapping.flipLeftRight,
    );
    const dispNrm = applyMappingOrientationPoint(
      hit.localNormal,
      mapping.flipUpDown,
      mapping.flipLeftRight,
    );
    addMappedLed(hit.dir, dispPos, dispNrm);
    setHover(null);
    setSelected(nextIndex);
    setSelectedGaussianId(null);
  };

  const onSurfacePointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (isOffsetTool) {
      setHover(null);
      return;
    }
    const hit = surfaceFromEvent(e);
    if (!hit) return;

    const gaussId = gaussianDragIdRef.current;
    if (gaussId !== null) {
      e.stopPropagation();
      const dispPos = applyMappingOrientationPoint(
        hit.localPos,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      const dispNrm = applyMappingOrientationPoint(
        hit.localNormal,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      updateMappingGaussian(gaussId, { pos: dispPos, normal: dispNrm });
      return;
    }

    if (isGaussianTool) {
      setHover(null);
      return;
    }

    const idx = draggingRef.current;
    if (idx !== null) {
      e.stopPropagation();
      const led = mapping.leds[idx];
      const lp = applyMappingOrientationPoint(
        hit.localPos,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      const ln = applyMappingOrientationPoint(
        hit.localNormal,
        mapping.flipUpDown,
        mapping.flipLeftRight,
      );
      const displaced = displaceLed(
        lp,
        ln,
        orientedGaussians,
        led?.offset ?? 0,
        mapping.bumpAdditivity,
      );
      const candidateWorld = localToWorldPos(displaced.pos);
      const prev = idx > 0 ? beads[idx - 1] : null;
      const next = idx < beads.length - 1 ? beads[idx + 1] : null;
      const max = mapping.maxSegmentLength + 1e-6;
      if (prev && distance(candidateWorld, prev.pos) > max) return;
      if (next && distance(candidateWorld, next.pos) > max) return;
      if (overlapsExisting(candidateWorld, idx)) return;
      moveMappedLed(idx, hit.dir, lp, ln);
      return;
    }
    const previewWorld: Vec3 = [
      hit.worldPos[0],
      hit.worldPos[1],
      hit.worldPos[2],
    ];
    setHover({ pos: previewWorld, normal: hit.worldNormal });
  };

  return (
    <>
      <ambientLight intensity={0.18} />
      <hemisphereLight args={["#b8c7e8", "#151923", 0.22]} />
      <primitive object={mappingSpotTarget} />
      <spotLight
        position={mappingLightPos}
        color={mapping.mappingLightColor}
        intensity={mapping.mappingLightIntensity}
        angle={spreadToSpotAngle(mapping.mappingLightSpread)}
        penumbra={mapping.mappingLightFocus}
        distance={0}
        decay={mapping.mappingLightDecay}
        target={mappingSpotTarget}
      />
      <mesh position={mappingLightPos}>
        <sphereGeometry args={[0.08, 12, 8]} />
        <meshBasicMaterial color={mapping.mappingLightColor} toneMapped={false} />
      </mesh>

      <CoordinateGrid />
      <axesHelper args={[0.5]} />

      {meshGeom && (
        <mesh
          geometry={meshGeom}
          scale={mesh.scale}
          position={[0, mesh.offsetY, 0]}
          rotation={[
            (mesh.tiltDeg * Math.PI) / 180,
            (mesh.yawDeg * Math.PI) / 180,
            0,
          ]}
          onPointerDown={(e) => {
            downPosRef.current = {
              x: e.nativeEvent.clientX,
              y: e.nativeEvent.clientY,
            };
          }}
          onClick={onSurfaceClick}
          onPointerMove={onSurfacePointerMove}
          onPointerOut={() => setHover(null)}
        >
          <meshStandardMaterial
            color="#8b93a4"
            transparent
            opacity={0.65}
            roughness={0.9}
            metalness={0}
          />
        </mesh>
      )}
      {mapping.showOffsetsAndDomes !== false &&
        mapping.showBakedSurface &&
        bakedSurface && (
        <mesh
          geometry={bakedSurface}
          scale={mesh.scale}
          position={[0, mesh.offsetY, 0]}
          rotation={[
            (mesh.tiltDeg * Math.PI) / 180,
            (mesh.yawDeg * Math.PI) / 180,
            0,
          ]}
          raycast={() => null}
        >
          <meshStandardMaterial
            color={GAUSS_COLOR}
            roughness={0.72}
            metalness={0}
            transparent
            opacity={0.62}
            side={DoubleSide}
            depthWrite
          />
        </mesh>
      )}

      {linePoints.length >= 2 && (
        <Line points={linePoints} color="#7f8ca3" lineWidth={1.5} />
      )}

      {hover && draggingRef.current === null && isPlaceTool && (() => {
        const valid = withinMaxSeg(hover.pos) && !overlapsExisting(hover.pos);
        const ghostColor = valid ? "#46e16e" : "#ff5a5a";
        const hoverQuat = new Quaternion().setFromUnitVectors(
          new Vector3(0, 1, 0),
          new Vector3(hover.normal[0], hover.normal[1], hover.normal[2]),
        );
        return (
          <group>
            {prevBeadPos && (
              <Line
                points={[prevBeadPos, hover.pos]}
                color={ghostColor}
                lineWidth={1.5}
                dashed
                dashSize={0.04}
                gapSize={0.03}
                transparent
                opacity={0.7}
              />
            )}
            <mesh position={hover.pos} quaternion={hoverQuat}>
              <sphereGeometry
                args={[mapping.ledSize, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2]}
              />
              <meshStandardMaterial
                color={ghostColor}
                emissive={ghostColor}
                emissiveIntensity={0.35}
                transparent
                opacity={0.45}
                depthWrite={false}
              />
            </mesh>
          </group>
        );
      })()}

      {beads.map(({ pos, normal, quat, baseWorld, baseNormal, physicalIndex }, i) => {
        const count = beads.length;
        const isSelected = i === selected;
        const front = facesCamera(pos, normal);
        const displayNumber = mapping.reversed ? count - i : i + 1;
        const labelPos: Vec3 = [
          pos[0] +
            normal[0] *
              (mapping.showBallSensors ? strand.ledSize * 1.35 : mapping.ledSize * 2.4),
          pos[1] +
            normal[1] *
              (mapping.showBallSensors ? strand.ledSize * 1.35 : mapping.ledSize * 2.4),
          pos[2] +
            normal[2] *
              (mapping.showBallSensors ? strand.ledSize * 1.35 : mapping.ledSize * 2.4),
        ];
        return (
          <group key={i}>
            <mesh
              position={pos}
              quaternion={quat}
              onPointerDown={(e) => {
                if (isGaussianTool) return;
                if (!facesCamera(pos, normal)) return;
                e.stopPropagation();
                setSelected(i);
                setSelectedGaussianId(null);
                setOrbitEnabled(false);
                if (isOffsetTool) {
                  offsetDragRef.current = {
                    index: i,
                    baseWorld: new Vector3(
                      baseWorld[0],
                      baseWorld[1],
                      baseWorld[2],
                    ),
                    axis: new Vector3(
                      baseNormal[0],
                      baseNormal[1],
                      baseNormal[2],
                    ),
                    ledSize: mapping.ledSize,
                  };
                  draggingRef.current = null;
                } else {
                  draggingRef.current = i;
                  offsetDragRef.current = null;
                }
              }}
              onClick={(e) => {
                if (isGaussianTool) return;
                if (!facesCamera(pos, normal)) return;
                e.stopPropagation();
                setSelected(i);
                setSelectedGaussianId(null);
              }}
            >
              <sphereGeometry
                args={markerSphereArgs(
                  markerRadius(
                    mapping.showBallSensors ? "sensor" : "led",
                    mapping.ledSize,
                    strand.ledSize,
                  ),
                  mapping.showBallSensors ? "sensor" : "led",
                )}
              />
              <meshStandardMaterial
                {...MARKER_MATERIAL_DEFAULTS}
                ref={(material) => {
                  outputMaterialRefs.current[physicalIndex] = material;
                  if (!material) return;
                  const level = outputLevelsRef.current[physicalIndex] ?? 0;
                  const packed = Number.parseInt(
                    mapping.mappingLightColor.slice(1),
                    16,
                  );
                  const [red, green, blue] = encodeLedRgb(
                    level * srgbChannelToLinear(((packed >> 16) & 255) / 255),
                    level * srgbChannelToLinear(((packed >> 8) & 255) / 255),
                    level * srgbChannelToLinear((packed & 255) / 255),
                    strand.colorProfile,
                  );
                  material.color.setRGB(red / 255, green / 255, blue / 255);
                  material.emissive.copy(material.color);
                  material.emissiveIntensity = 1;
                }}
                color="#000000"
                emissive="#000000"
                emissiveIntensity={1}
                opacity={front ? 1 : 0.25}
              />
            </mesh>
            <Billboard position={labelPos}>
              <Text
                fontSize={mapping.ledSize * 2.6}
                color={isSelected ? "#ffffff" : "#cfd6e6"}
                anchorX="center"
                anchorY="middle"
                outlineWidth={mapping.ledSize * 0.35}
                outlineColor="#05070d"
                fillOpacity={front ? 1 : 0.3}
                outlineOpacity={front ? 1 : 0.3}
              >
                {displayNumber}
              </Text>
            </Billboard>
          </group>
        );
      })}

      {mapping.showOffsetsAndDomes !== false &&
        gaussianMarkers.map(({ id, pos, normal, surface }) => {
        const isSel = id === selectedGaussianId;
        const color = isSel ? GAUSS_SELECTED : GAUSS_COLOR;
        return (
          <group key={id}>
            {mapping.showBumpSurfaces && !mapping.showBakedSurface && (
              <mesh geometry={surface} raycast={() => null}>
                <meshStandardMaterial
                  color={color}
                  roughness={0.72}
                  metalness={0}
                  transparent
                  opacity={0.62 * (isSel ? 1 : 0.82)}
                  side={DoubleSide}
                  depthWrite
                />
              </mesh>
            )}
            <Billboard position={pos}>
              <mesh
                renderOrder={20}
                onPointerDown={(e) => {
                  if (!isGaussianTool) return;
                  e.stopPropagation();
                  setSelectedGaussianId(id);
                  setSelected(null);
                  setOrbitEnabled(false);
                  gaussianDragIdRef.current = id;
                }}
                onClick={(e) => {
                  if (!isGaussianTool) return;
                  e.stopPropagation();
                  setSelectedGaussianId(id);
                  setSelected(null);
                }}
              >
                <circleGeometry args={[mapping.ledSize * 1.8, 20]} />
                <meshBasicMaterial
                  color={color}
                  transparent
                  opacity={isSel ? 0.98 : 0.85}
                  toneMapped={false}
                  depthWrite={false}
                  depthTest={false}
                />
              </mesh>
            </Billboard>
          </group>
        );
      })}

      <OrbitControls makeDefault enabled={orbitEnabled} />
    </>
  );
}

/**
 * Ground reference grid with fine + coarse tick lines and centimetre
 * labels along the X and Z axes. The world unit is metres, so we draw
 * a minor line every 1 cm, a major line every 10 cm, and axis labels
 * every 10 cm reading in cm. Extent is ±HALF metres.
 */
const GRID_HALF = 1; // metres — 2 m x 2 m plane covers typical props
const GRID_MINOR_STEP = 0.01;
const GRID_MAJOR_STEP = 0.1;

function CoordinateGrid() {
  // Precompute grid + Y-ruler geometry in one pass. The XZ ground plane
  // has minor (1 cm) and major (10 cm) lines; the Y ruler is a vertical
  // line at the origin with tick marks every 1 cm (minor) / 10 cm (major).
  const {
    minorPts,
    majorPts,
    axisPts,
    yMinorPts,
    yMajorPts,
    yAxisPts,
  } = useMemo(() => {
    const minor: Vec3[] = [];
    const major: Vec3[] = [];
    const axis: Vec3[] = [];
    const yMinor: Vec3[] = [];
    const yMajor: Vec3[] = [];
    const yAxis: Vec3[] = [];
    const half = GRID_HALF;
    const eps = 1e-6;
    const isMajorTick = (v: number) =>
      Math.abs(v / GRID_MAJOR_STEP - Math.round(v / GRID_MAJOR_STEP)) < 1e-3;

    for (let x = -half; x <= half + eps; x += GRID_MINOR_STEP) {
      const list = isMajorTick(x) ? major : minor;
      list.push([x, 0, -half], [x, 0, half]);
    }
    for (let z = -half; z <= half + eps; z += GRID_MINOR_STEP) {
      const list = isMajorTick(z) ? major : minor;
      list.push([-half, 0, z], [half, 0, z]);
    }
    axis.push([-half, 0, 0], [half, 0, 0]);
    axis.push([0, 0, -half], [0, 0, half]);

    // Y ruler: vertical line at origin from -half to +half, with tick
    // marks (short XZ line segments) at each 1 cm interval.
    yAxis.push([0, -half, 0], [0, half, 0]);
    const minorTick = 0.005;
    const majorTick = 0.012;
    for (let y = -half; y <= half + eps; y += GRID_MINOR_STEP) {
      const major_ = isMajorTick(y);
      const list = major_ ? yMajor : yMinor;
      const t = major_ ? majorTick : minorTick;
      // Small crosshair ticks in both X and Z so the ruler reads from
      // any camera angle.
      list.push([-t, y, 0], [t, y, 0]);
      list.push([0, y, -t], [0, y, t]);
    }
    return {
      minorPts: minor,
      majorPts: major,
      axisPts: axis,
      yMinorPts: yMinor,
      yMajorPts: yMajor,
      yAxisPts: yAxis,
    };
  }, []);

  // Numeric labels every 10 cm along all three axes, skipping 0.
  const labels = useMemo(() => {
    const out: { pos: Vec3; text: string }[] = [];
    const steps = Math.round(GRID_HALF / GRID_MAJOR_STEP);
    for (let i = -steps; i <= steps; i++) {
      if (i === 0) continue;
      const m = i * GRID_MAJOR_STEP;
      const cm = Math.round(m * 100).toString();
      out.push({ pos: [m, 0, 0], text: cm });
      out.push({ pos: [0, 0, m], text: cm });
      out.push({ pos: [0, m, 0], text: cm });
    }
    return out;
  }, []);

  return (
    <group>
      <Line
        points={minorPts}
        segments
        color="#1c2230"
        lineWidth={0.6}
        transparent
        opacity={0.55}
      />
      <Line
        points={majorPts}
        segments
        color="#3a4356"
        lineWidth={1.1}
        transparent
        opacity={0.9}
      />
      <Line points={axisPts} segments color="#6f7d95" lineWidth={1.6} />

      <Line
        points={yMinorPts}
        segments
        color="#2a3140"
        lineWidth={0.9}
        transparent
        opacity={0.75}
      />
      <Line
        points={yMajorPts}
        segments
        color="#5a6478"
        lineWidth={1.3}
        transparent
        opacity={0.95}
      />
      <Line points={yAxisPts} segments color="#6f7d95" lineWidth={1.6} />

      {labels.map(({ pos, text }, i) => (
        <Billboard key={i} position={[pos[0], pos[1] + 0.006, pos[2]]}>
          <Text
            fontSize={0.018}
            color="#9aa4b8"
            anchorX="center"
            anchorY="middle"
            outlineWidth={0.003}
            outlineColor="#05070d"
          >
            {text}
          </Text>
        </Billboard>
      ))}

      {/* Axis letter labels at the +end of each axis. */}
      <AxisLabel position={[GRID_HALF + 0.03, 0, 0]} text="X" color="#ff6a6a" />
      <AxisLabel position={[0, GRID_HALF + 0.03, 0]} text="Y" color="#7fe37f" />
      <AxisLabel position={[0, 0, GRID_HALF + 0.03]} text="Z" color="#6aa8ff" />

      {/* Unit hint. */}
      <Billboard position={[GRID_HALF - 0.05, 0.015, 0]}>
        <Text
          fontSize={0.022}
          color="#c7d0e2"
          anchorX="right"
          anchorY="middle"
          outlineWidth={0.003}
          outlineColor="#05070d"
        >
          cm
        </Text>
      </Billboard>
    </group>
  );
}

function AxisLabel({
  position,
  text,
  color,
}: {
  position: Vec3;
  text: string;
  color: string;
}) {
  return (
    <Billboard position={position}>
      <Text
        fontSize={0.05}
        color={color}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.006}
        outlineColor="#05070d"
      >
        {text}
      </Text>
    </Billboard>
  );
}
