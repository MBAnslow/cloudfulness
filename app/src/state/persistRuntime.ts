/**
 * Keeps the live Zustand store mirrored to localStorage, and on first
 * paint tries to reload the last YAML config file the user opened/saved
 * (File System Access handle in IndexedDB).
 */

import defaultConfigYaml from "../../../cloud-led-config.yaml?raw";
import { applySnapshot, currentSnapshot, useSimStore } from "../state";
import { audioContentCount, loadSnapshot, saveSnapshot } from "./persistence";
import {
  autosaveBoundFileIfPermitted,
  yamlToSnapshot,
} from "./fileIO";

const AUTOSAVE_MS = 400;
const REPO_DEFAULT_APPLIED_KEY = "cloudLeds.repoDefaultApplied";

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;

/** Call once from the app entrypoint. */
export function startPersistence(): void {
  if (started) return;
  started = true;

  // Note arrangements are irreplaceable authoring data, so mirror them to
  // localStorage synchronously on every edit. Other high-frequency changes
  // (notably the playing sky clock) remain debounced.
  useSimStore.subscribe((state, previous) => {
    const arrangementChanged =
      state.drone.notes !== previous.drone.notes ||
      state.pad.notes !== previous.pad.notes ||
      state.pad.keyframes !== previous.pad.keyframes;
    const colorAuthoringChanged =
      state.sky.sunStops !== previous.sky.sunStops ||
      state.sky.moonStops !== previous.sky.moonStops ||
      state.sky.ambientStops !== previous.sky.ambientStops ||
      state.ambient !== previous.ambient ||
      state.strand.colorProfile !== previous.strand.colorProfile;
    if (arrangementChanged || colorAuthoringChanged) {
      saveSnapshot(currentSnapshot());
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      saveSnapshot(currentSnapshot());
      void autosaveBoundFileIfPermitted();
    }, AUTOSAVE_MS);
  });

  // Flush the latest state before the page is hidden or unloaded. This
  // closes the debounce window when refreshing, closing, or backgrounding.
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    saveSnapshot(currentSnapshot());
  };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  // The committed cloud-led-config.yaml is the repo default. Apply it when
  // the browser save has less arrangement data than that file, once per
  // file revision. A richer browser save is left alone.
  const browserSnap = loadSnapshot();
  const defaultSnap = yamlToSnapshot(defaultConfigYaml);
  const defaultId = String(defaultConfigYaml.length);
  const appliedId = localStorage.getItem(REPO_DEFAULT_APPLIED_KEY);
  if (
    appliedId !== defaultId &&
    audioContentCount(browserSnap ?? {}) < audioContentCount(defaultSnap)
  ) {
    applySnapshot(defaultSnap);
    saveSnapshot(currentSnapshot());
    localStorage.setItem(REPO_DEFAULT_APPLIED_KEY, defaultId);
  }
}
