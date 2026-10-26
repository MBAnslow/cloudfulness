import type {
  AmbientLightParams,
  BreathTimeCombineMode,
  BreathParams,
  CloudTopParams,
  CloudParams,
  DirectionalLightParams,
  DayCycleParams,
  DroneParams,
  MasterFxParams,
  PadParams,
  SamplesParams,
  EllipsoidParams,
  LedDisplayMode,
  LedStreamPipeline,
  LedLocatorState,
  LedViewMode,
  LightningParams,
  BreathFilterParams,
  MappingParams,
  MeshTargetParams,
  SkyParams,
  UiParams,
  StrandParams,
  WledParams,
} from "../state";

/** Bumped whenever the shape of the saved snapshot changes incompatibly. */
const SCHEMA_VERSION = 1;
const STORAGE_KEY = "cloudLeds.settings.v1";

export interface Snapshot {
  version: typeof SCHEMA_VERSION;
  ellipsoid: EllipsoidParams;
  cloud: CloudParams;
  cloudTop?: CloudTopParams;
  strand: StrandParams;
  ambient: AmbientLightParams;
  directional: DirectionalLightParams;
  sky?: SkyParams;
  wled: WledParams;
  breath?: BreathParams;
  lightning?: LightningParams;
  breathFilter?: BreathFilterParams;
  drone?: DroneParams;
  pad?: PadParams;
  samples?: SamplesParams;
  dayCycle?: DayCycleParams;
  masterFx?: MasterFxParams;
  breathMod?: Record<string, number>;
  breathModEnabled?: boolean;
  breathModRevealCeiling?: number;
  ledViewMode?: LedViewMode;
  ledDisplayMode?: LedDisplayMode;
  breathTimeCombineMode?: BreathTimeCombineMode;
  ledStreamPipeline?: LedStreamPipeline;
  ledLocator?: LedLocatorState;
  mapping?: MappingParams;
  mesh?: MeshTargetParams;
  ui?: UiParams;
}

export function audioContentCount(snap: Partial<Snapshot>): number {
  return (
    (snap.drone?.notes?.length ?? 0) +
    (snap.pad?.notes?.length ?? 0) +
    (snap.pad?.keyframes?.length ?? 0) +
    (snap.samples?.library?.length ?? 0) +
    (snap.samples?.clips?.length ?? 0)
  );
}

export function saveSnapshot(snap: Omit<Snapshot, "version">): void {
  const payload: Snapshot = { version: SCHEMA_VERSION, ...snap };
  try {
    const existingRaw = localStorage.getItem(STORAGE_KEY);
    if (existingRaw) {
      const existing = JSON.parse(existingRaw) as Partial<Snapshot>;
      if (audioContentCount(existing) > 0 && audioContentCount(payload) === 0) {
        console.warn(
          "[persistence] skipped empty audio snapshot to protect existing notes/samples",
        );
        return;
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn("[persistence] saveSnapshot failed", err);
  }
}

export function loadSnapshot(): Snapshot | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as Snapshot;
    if (data.version !== SCHEMA_VERSION) return null;
    return data;
  } catch (err) {
    console.warn("[persistence] loadSnapshot failed", err);
    return null;
  }
}

export function hasSavedSnapshot(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}
