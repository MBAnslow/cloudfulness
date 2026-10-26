import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FloatType,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  Vector3,
} from "three";
import { loadCoverGeometry } from "../mapping/meshAsset";
import { useSimStore } from "../state";
import { getFrame } from "../stream/frameBuffer";

/** Upper bound on LEDs the covering shader iterates over. */
const MAX_COVER_LEDS = 2048;
const EMISSIVE_SCALE = 0.12;

type ShaderHandle = {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
};

/**
 * A visual-only transport medium. Each fragment of the cloud-top mesh sums
 * light from every LED directly (position, outward normal and streamed
 * colour live in a small float texture), so the glow stays sharp at any
 * zoom instead of being limited by a baked light grid.
 */
export function CloudTop() {
  const cloudTop = useSimStore((s) => s.cloudTop);
  const [geometry, setGeometry] = useState<BufferGeometry | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!cloudTop.id) {
      setGeometry(null);
      return;
    }
    loadCoverGeometry(cloudTop.id)
      .then((next) => {
        if (!cancelled) setGeometry(next);
      })
      .catch((err) => {
        console.warn("[cloud-top] mesh load failed", err);
        if (!cancelled) setGeometry(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cloudTop.id]);

  if (!cloudTop.visible || !geometry) return null;
  return <CloudTopMesh geometry={geometry} />;
}

function CloudTopMesh({ geometry }: { geometry: BufferGeometry }) {
  const cloud = useSimStore((s) => s.cloud);
  const cloudTop = useSimStore((s) => s.cloudTop);
  const meshRef = useRef<Mesh>(null);

  // Row 0: local position (w = valid), row 1: local normal, row 2: colour.
  const ledData = useMemo(() => new Float32Array(MAX_COVER_LEDS * 3 * 4), []);
  const ledTexture = useMemo(() => {
    const next = new DataTexture(ledData, MAX_COVER_LEDS, 3, RGBAFormat, FloatType);
    next.minFilter = NearestFilter;
    next.magFilter = NearestFilter;
    next.generateMipmaps = false;
    next.needsUpdate = true;
    return next;
  }, [ledData]);

  const uniforms = useMemo(
    () => ({
      cloudTopLeds: { value: ledTexture },
      cloudTopLedCount: { value: 0 },
      cloudTopRadius: { value: 1 },
      cloudTopFocus: { value: 1 },
      cloudTopGlowStrength: { value: 0 },
      cloudTopTint: { value: new Color() },
    }),
    [ledTexture],
  );

  const material = useMemo(() => {
    const next = new MeshStandardMaterial({
      // The covering receives no sun, moon, ambient, or scene lighting.
      // Its only visible contribution is the LED light arriving from below.
      color: "#000000",
      transparent: false,
      opacity: 1,
      roughness: 1,
      metalness: 0,
      depthWrite: true,
      side: DoubleSide,
    });
    // Match the LED emitter preview: preserve the authored output colors
    // instead of letting scene exposure crush a mostly-emissive surface.
    next.toneMapped = false;
    next.onBeforeCompile = (shader) => {
      const handle = shader as unknown as ShaderHandle;
      Object.assign(handle.uniforms, uniforms);
      handle.vertexShader = handle.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vCloudTopLocalPosition;",
        )
        .replace(
          "#include <begin_vertex>",
          "#include <begin_vertex>\nvCloudTopLocalPosition = position;",
        );
      handle.fragmentShader = handle.fragmentShader
        .replace(
          "#include <common>",
          [
            "#include <common>",
            `#define CLOUD_TOP_MAX_LEDS ${MAX_COVER_LEDS}`,
            "varying vec3 vCloudTopLocalPosition;",
            "uniform highp sampler2D cloudTopLeds;",
            "uniform int cloudTopLedCount;",
            "uniform float cloudTopRadius;",
            "uniform float cloudTopFocus;",
            "uniform float cloudTopGlowStrength;",
            "uniform vec3 cloudTopTint;",
          ].join("\n"),
        )
        .replace(
          "#include <emissivemap_fragment>",
          [
            "#include <emissivemap_fragment>",
            "vec3 cloudTopLedLight = vec3(0.0);",
            "for (int i = 0; i < CLOUD_TOP_MAX_LEDS; i++) {",
            "  if (i >= cloudTopLedCount) break;",
            "  vec4 ledPos = texelFetch(cloudTopLeds, ivec2(i, 0), 0);",
            "  if (ledPos.w < 0.5) continue;",
            "  vec3 toFragment = vCloudTopLocalPosition - ledPos.xyz;",
            "  float dist = length(toFragment);",
            "  if (dist > cloudTopRadius) continue;",
            "  vec3 ledNormal = texelFetch(cloudTopLeds, ivec2(i, 1), 0).xyz;",
            "  float facing = dist < 1e-6 ? 1.0 : max(0.0, dot(toFragment, ledNormal) / dist);",
            "  if (facing <= 0.0) continue;",
            "  float weight = exp(-2.5 * dist / cloudTopRadius) * pow(facing, cloudTopFocus);",
            // A diffuser should spread each source, not add hundreds of
            // overlapping sources until the entire covering clips white.
            "  cloudTopLedLight = max(cloudTopLedLight, texelFetch(cloudTopLeds, ivec2(i, 2), 0).rgb * weight);",
            "}",
            "totalEmissiveRadiance += min(cloudTopLedLight, vec3(1.0)) * cloudTopTint * cloudTopGlowStrength;",
          ].join("\n"),
        );
    };
    next.customProgramCacheKey = () => "cloud-top-leds-v2";
    return next;
  }, [uniforms]);

  useEffect(() => {
    uniforms.cloudTopTint.value.set(cloudTop.tint);
  }, [cloudTop.tint, uniforms]);
  useEffect(() => {
    uniforms.cloudTopGlowStrength.value = cloudTop.glowStrength * EMISSIVE_SCALE;
    uniforms.cloudTopFocus.value = cloudTop.glowFocus;
  }, [cloudTop.glowStrength, cloudTop.glowFocus, uniforms]);

  useEffect(
    () => () => {
      material.dispose();
      ledTexture.dispose();
    },
    [material, ledTexture],
  );

  const localPosition = useMemo(() => new Vector3(), []);
  const localNormal = useMemo(() => new Vector3(), []);
  const inverseWorld = useMemo(() => new Matrix4(), []);

  useFrame(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const frame = getFrame();
    if (!frame.buffer || !frame.positions || !frame.normals) return;
    mesh.updateWorldMatrix(true, false);
    inverseWorld.copy(mesh.matrixWorld).invert();

    // The control describes the visible softness at the covering. Light must
    // first cross the air gap between the pyramid LEDs and that covering, so
    // use a wider transport radius than the final displayed falloff.
    const transportRadius = cloudTop.glowRadius * 2;
    uniforms.cloudTopRadius.value =
      transportRadius / Math.max(0.001, cloudTop.scale);

    const count = Math.min(frame.count, frame.positionCount, MAX_COVER_LEDS);
    const colorRow = MAX_COVER_LEDS * 8;
    const normalRow = MAX_COVER_LEDS * 4;
    for (let led = 0; led < count; led++) {
      const i3 = led * 3;
      const i4 = led * 4;
      if (frame.positionValidity && !frame.positionValidity[led]) {
        ledData[i4 + 3] = 0;
        continue;
      }
      localPosition
        .set(frame.positions[i3], frame.positions[i3 + 1], frame.positions[i3 + 2])
        .applyMatrix4(inverseWorld);
      localNormal
        .set(frame.normals[i3], frame.normals[i3 + 1], frame.normals[i3 + 2])
        .transformDirection(inverseWorld);
      ledData[i4] = localPosition.x;
      ledData[i4 + 1] = localPosition.y;
      ledData[i4 + 2] = localPosition.z;
      ledData[i4 + 3] = 1;
      ledData[normalRow + i4] = localNormal.x;
      ledData[normalRow + i4 + 1] = localNormal.y;
      ledData[normalRow + i4 + 2] = localNormal.z;
      ledData[colorRow + i4] = frame.buffer[i3] / 255;
      ledData[colorRow + i4 + 1] = frame.buffer[i3 + 1] / 255;
      ledData[colorRow + i4 + 2] = frame.buffer[i3 + 2] / 255;
    }
    uniforms.cloudTopLedCount.value = count;
    ledTexture.needsUpdate = true;
  });

  const deg = Math.PI / 180;
  return (
    <group
      position={[cloud.offsetX, cloud.offsetY, cloud.offsetZ]}
      rotation={[cloud.rotationXDeg * deg, cloud.rotationYDeg * deg, 0]}
    >
      <mesh
        ref={meshRef}
        geometry={geometry}
        material={material}
        position={[cloudTop.offsetX, cloudTop.offsetY, cloudTop.offsetZ]}
        rotation={[cloudTop.tiltDeg * deg, cloudTop.yawDeg * deg, 0]}
        scale={cloudTop.scale}
        castShadow={false}
        receiveShadow={false}
      />
    </group>
  );
}
