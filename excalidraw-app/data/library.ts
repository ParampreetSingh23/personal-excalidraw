import { createStore, get, set } from "idb-keyval";

import type { LibraryPersistedData } from "@excalidraw/excalidraw/data/library";

import { STORAGE_KEYS } from "../app_constants";

const store = createStore(
  `${STORAGE_KEYS.IDB_LIBRARY}-db`,
  `${STORAGE_KEYS.IDB_LIBRARY}-store`,
);
const KEY = "libraryData";

// library stays per-browser (IndexedDB)
export const LibraryIndexedDBAdapter = {
  load: async () => (await get<LibraryPersistedData>(KEY, store)) || null,
  save: (data: LibraryPersistedData) => set(KEY, data, store),
};
