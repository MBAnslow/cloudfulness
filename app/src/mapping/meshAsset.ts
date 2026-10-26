/**
 * Storage + loading for uploaded LED-mapping meshes.
 *
 * Binary GLB/GLTF blobs live in IndexedDB (see the samples store for the
 * same pattern) so `localStorage` snapshots only carry lightweight
 * metadata (`id`, `name`). At runtime we parse the buffer with three's
 * `GLTFLoader`, merge every mesh in the scene into a single normalised
 * `THREE.Mesh` centred on the origin, and cache it in-memory keyed by id.
 */

import { BufferGeometry, Mesh, MeshStandardMaterial, Box3, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshSurfaceSampler } from "three/examples/jsm/math/MeshSurfaceSampler.js";

const DB_NAME = "cloudLeds.meshes";
const STORE = "blobs";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function withStore<T>(
  mode: IDBTransactionMode,
  op: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const req = op(store);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }),
  );
}

export async function putMeshBlob(id: string, blob: Blob): Promise<void> {
  await withStore("readwrite", (s) => s.put(blob, id));
}

export async function getMeshBlob(id: string): Promise<Blob | null> {
  const v = await withStore<Blob | undefined>("readonly", (s) => s.get(id));
  return v ?? null;
}

export async function deleteMeshBlob(id: string): Promise<void> {
  await withStore("readwrite", (s) => s.delete(id));
}

const geometryCache = new Map<string, BufferGeometry>();
const surfaceSamplerCache = new Map<string, MeshSurfaceSampler>();

/**
 * Parse a GLB/GLTF ArrayBuffer into a single merged BufferGeometry
 * centred on the origin. All child meshes are baked into a single
 * geometry so raycasting hits any of them uniformly. Bakes each mesh's
 * world transform into vertex positions.
 */
export async function loadMeshGeometry(id: string): Promise<BufferGeometry | null> {
  const cached = geometryCache.get(id);
  if (cached) return cached;
  const parsed = await parseMeshParts(id);
  if (!parsed) return null;
  const { parts, centre } = parsed;
  const merged = parts.length === 1 ? parts[0] : (mergeGeometries(parts, false) ?? parts[0]);
  // Recentre so the mesh's bounding-box centre sits at origin. The
  // per-mesh transform sliders (scale/yaw/tilt/offsetY) then operate on
  // a predictable frame.
  merged.translate(-centre.x, -centre.y, -centre.z);
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  geometryCache.set(id, merged);
  return merged;
}

/**
 * Like `loadMeshGeometry`, but keeps only the densest mesh in the file (the
 * covering itself, not helper frames or planes exported alongside it). It is
 * recentred on the whole file's bounds so saved offsets keep lining up.
 */
export async function loadCoverGeometry(id: string): Promise<BufferGeometry | null> {
  const key = `${id}#cover`;
  const cached = geometryCache.get(key);
  if (cached) return cached;
  const parsed = await parseMeshParts(id);
  if (!parsed) return null;
  const triangles = (g: BufferGeometry) =>
    (g.index ? g.index.count : g.attributes.position.count) / 3;
  const cover = parsed.parts.reduce((a, b) => (triangles(b) > triangles(a) ? b : a));
  cover.translate(-parsed.centre.x, -parsed.centre.y, -parsed.centre.z);
  cover.computeBoundingBox();
  cover.computeBoundingSphere();
  geometryCache.set(key, cover);
  return cover;
}

async function parseMeshParts(
  id: string,
): Promise<{ parts: BufferGeometry[]; centre: Vector3 } | null> {
  const blob = await getMeshBlob(id);
  if (!blob) return null;
  const buffer = await blob.arrayBuffer();
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buffer, "");
  const parts: BufferGeometry[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((obj) => {
    const m = obj as Mesh;
    if ((m as unknown as { isMesh?: boolean }).isMesh && m.geometry) {
      const g = m.geometry.clone();
      // Bake world transform; drop attributes that don't align across meshes.
      g.applyMatrix4(m.matrixWorld);
      // Strip incompatible attributes so mergeGeometries doesn't reject
      // meshes with different UV/tangent sets.
      const keep = new Set(["position", "normal"]);
      for (const name of Object.keys(g.attributes)) {
        if (!keep.has(name)) g.deleteAttribute(name);
      }
      if (!g.attributes.normal) g.computeVertexNormals();
      parts.push(g);
    }
  });
  if (parts.length === 0) return null;
  const box = new Box3();
  for (const g of parts) {
    g.computeBoundingBox();
    if (g.boundingBox) box.union(g.boundingBox);
  }
  return { parts, centre: box.getCenter(new Vector3()) };
}

/**
 * Half-extents of the cached mesh's axis-aligned bounding box in
 * mesh-local space (before the runtime `scale` multiplier). Returns
 * null if the geometry isn't loaded or has no valid bounds. Useful for
 * spawn-volume calculations (e.g. constraining lightning bolts to the
 * mesh interior).
 */
export function getMeshHalfExtents(id: string): {
  hx: number;
  hy: number;
  hz: number;
} | null {
  const g = geometryCache.get(id);
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  const box = g.boundingBox;
  if (!box) return null;
  return {
    hx: Math.max(0, (box.max.x - box.min.x) * 0.5),
    hy: Math.max(0, (box.max.y - box.min.y) * 0.5),
    hz: Math.max(0, (box.max.z - box.min.z) * 0.5),
  };
}

/** Sample an area-uniform point on the uploaded mesh surface. */
export function sampleMeshSurfacePoint(id: string, target: Vector3): boolean {
  const geometry = geometryCache.get(id);
  if (!geometry) return false;
  let sampler = surfaceSamplerCache.get(id);
  if (!sampler) {
    sampler = new MeshSurfaceSampler(new Mesh(geometry)).build();
    surfaceSamplerCache.set(id, sampler);
  }
  sampler.sample(target);
  return true;
}

/** Drop the cached parsed geometry for `id` (call when the blob changes). */
export function invalidateMeshGeometry(id: string): void {
  for (const key of [id, `${id}#cover`]) {
    geometryCache.get(key)?.dispose();
    geometryCache.delete(key);
  }
  surfaceSamplerCache.delete(id);
}

/** Convenience: default material used to render an uploaded mesh in the scene. */
export function makeMeshMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: "#39414f",
    transparent: true,
    opacity: 0.55,
    roughness: 0.95,
    metalness: 0,
  });
}
