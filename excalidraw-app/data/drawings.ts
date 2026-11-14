import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

export type DrawingMeta = { id: string; name: string; updatedAt: number };

export type DrawingData = {
  name: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

/** "Drip HLD" -> "drip-hld". Must match the worker's id regex. */
export const slugify = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

const request = async (path: string, init?: RequestInit) => {
  const response = await fetch(`/api/drawings${path}`, init);
  if (response.status === 401) {
    window.location.assign("/login");
    throw new Error("Not signed in");
  }
  if (!response.ok && response.status !== 404) {
    throw new Error(`${init?.method ?? "GET"} ${path}: ${response.status}`);
  }
  return response;
};

export const listDrawings = async (): Promise<DrawingMeta[]> =>
  (await request("")).json();

export const loadDrawing = async (id: string): Promise<DrawingData | null> => {
  const response = await request(`/${id}`);
  return response.status === 404 ? null : response.json();
};

/** `body` is the already-serialized DrawingData */
export const saveDrawing = (id: string, body: string) =>
  request(`/${id}`, { method: "PUT", body });

export const deleteDrawing = (id: string) =>
  request(`/${id}`, { method: "DELETE" });

/** creates an empty board (no-op if the id already exists) */
export const createDrawing = async (name: string) => {
  const id = slugify(name);
  if (!(await loadDrawing(id))) {
    const empty: DrawingData = { name, elements: [], appState: {}, files: {} };
    await saveDrawing(id, JSON.stringify(empty));
  }
  return id;
};
