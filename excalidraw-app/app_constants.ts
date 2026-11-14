export const SAVE_DEBOUNCE_MS = 1000;
export const SAVE_RETRY_MS = 5000;
export const THUMBNAIL_DEBOUNCE_MS = 3000;

export const STORAGE_KEYS = {
  // only used by packages/excalidraw test helpers
  LOCAL_STORAGE_ELEMENTS: "excalidraw",
  LOCAL_STORAGE_APP_STATE: "excalidraw-state",
  LOCAL_STORAGE_THEME: "excalidraw-theme",
  IDB_LIBRARY: "excalidraw-library",
} as const;
