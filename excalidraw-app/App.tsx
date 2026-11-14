import {
  Excalidraw,
  TTDDialog,
  TTDDialogTrigger,
  CaptureUpdateAction,
  ExcalidrawAPIProvider,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import {
  CommandPalette,
  DEFAULT_CATEGORIES,
} from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import { debounce, EVENT, resolvablePromise } from "@excalidraw/common";
import polyfill from "@excalidraw/excalidraw/polyfill";
import {
  getNonDeletedElements,
  getSceneVersion,
  isElementLink,
  isInitializedImageElement,
} from "@excalidraw/element";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { useHandleLibrary } from "@excalidraw/excalidraw/data/library";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import { Provider, appJotaiStore } from "./app-jotai";
import { SAVE_DEBOUNCE_MS, SAVE_RETRY_MS, STORAGE_KEYS } from "./app_constants";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import { DrawingSwitcher } from "./components/DrawingSwitcher";
import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { loadDrawing, saveDrawing } from "./data/drawings";
import { LibraryIndexedDBAdapter } from "./data/library";
import { useHandleAppTheme } from "./useHandleAppTheme";

import "./index.scss";

import type { DrawingData } from "./data/drawings";

polyfill();

window.EXCALIDRAW_THROTTLE_RENDER = true;

type SaveStatus = "saved" | "saving" | "error";

const DEFAULT_DRAWING = "home";

/** drawing id from `/d/<id>`, else the last opened one */
const getInitialId = () => {
  const match = window.location.pathname.match(/^\/d\/([a-z0-9-]+)\/?$/);
  let last: string | null = null;
  try {
    last = localStorage.getItem(STORAGE_KEYS.LOCAL_STORAGE_LAST_DRAWING);
  } catch {}
  return match?.[1] || last || DEFAULT_DRAWING;
};

const toInitialData = (
  data: DrawingData | null,
): ExcalidrawInitialDataState => ({
  elements: restoreElements(data?.elements, null, { repairBindings: true }),
  appState: restoreAppState(data?.appState, null),
  files: data?.files,
});

const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [drawing, setDrawing] = useState(() => {
    const id = getInitialId();
    return { id, name: id };
  });
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");

  // mutable save state; refs so the debounced saver never goes stale
  const drawingRef = useRef(drawing);
  drawingRef.current = drawing;
  // false until the drawing finished loading: never save before that, or an
  // empty canvas would overwrite the stored drawing
  const loadedRef = useRef(false);
  const baselineVersionRef = useRef(0);
  const pendingRef = useRef<{
    id: string;
    name: string;
    elements: readonly OrderedExcalidrawElement[];
    appState: AppState;
    files: BinaryFiles;
  } | null>(null);
  const savingRef = useRef(false);

  const initialDataRef = useRef<ResolvablePromise<ExcalidrawInitialDataState>>(
    null!,
  );
  if (!initialDataRef.current) {
    initialDataRef.current = resolvablePromise();
  }

  useHandleLibrary({ excalidrawAPI, adapter: LibraryIndexedDBAdapter });

  // ---------------------------------------------------------------------------
  // saving
  // ---------------------------------------------------------------------------

  const doSave = useCallback(async (): Promise<void> => {
    const pending = pendingRef.current;
    if (!pending) {
      return;
    }
    if (savingRef.current) {
      // never overlap PUTs, last one must win
      debouncedSave();
      return;
    }
    savingRef.current = true;
    setSaveStatus("saving");

    const usedFileIds = new Set(
      pending.elements.filter(isInitializedImageElement).map((e) => e.fileId),
    );
    const files: BinaryFiles = {};
    for (const [id, file] of Object.entries(pending.files)) {
      if (usedFileIds.has(file.id)) {
        files[id] = file;
      }
    }
    const body: DrawingData = {
      name: pending.name,
      elements: getNonDeletedElements(pending.elements),
      appState: clearAppStateForLocalStorage(pending.appState),
      files,
    };

    try {
      await saveDrawing(pending.id, JSON.stringify(body));
      if (pendingRef.current === pending) {
        pendingRef.current = null;
        setSaveStatus("saved");
      } else {
        debouncedSave();
      }
    } catch (error) {
      console.error(error);
      setSaveStatus("error");
      setTimeout(() => debouncedSave(), SAVE_RETRY_MS);
    } finally {
      savingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const debouncedSave = useMemo(
    () => debounce(() => doSave(), SAVE_DEBOUNCE_MS),
    [doSave],
  );

  /** resolves true if nothing is left unsaved */
  const flushSave = useCallback(async () => {
    debouncedSave.cancel();
    while (savingRef.current) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await doSave();
    return !pendingRef.current;
  }, [debouncedSave, doSave]);

  const onChange = (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    if (!loadedRef.current) {
      return;
    }
    // scroll/zoom/selection also fire onChange; only persist content changes
    const version = getSceneVersion(elements);
    if (version === baselineVersionRef.current) {
      return;
    }
    baselineVersionRef.current = version;
    pendingRef.current = {
      ...drawingRef.current,
      elements,
      appState,
      files,
    };
    setSaveStatus("saving");
    debouncedSave();
  };

  // ---------------------------------------------------------------------------
  // loading / switching
  // ---------------------------------------------------------------------------

  const remember = (id: string, name: string) => {
    document.title = name;
    try {
      localStorage.setItem(STORAGE_KEYS.LOCAL_STORAGE_LAST_DRAWING, id);
    } catch {}
  };

  // initial load
  useEffect(() => {
    const { id } = drawingRef.current;
    loadDrawing(id)
      .then((data) => {
        const initial = toInitialData(data);
        baselineVersionRef.current = getSceneVersion(initial.elements || []);
        if (data?.name) {
          setDrawing({ id, name: data.name });
        }
        remember(id, data?.name || id);
        initialDataRef.current.resolve({
          ...initial,
          scrollToContent: !!initial.elements?.length,
        });
        loadedRef.current = true;
      })
      .catch((error) => {
        // stay unloaded -> autosave stays off, so nothing gets overwritten
        console.error(error);
        initialDataRef.current.resolve({
          appState: {
            errorMessage: `Could not load drawing: ${error.message}`,
          },
        });
        setSaveStatus("error");
      });
  }, []);

  const openDrawing = useCallback(
    async (id: string, name: string, { push = true } = {}) => {
      setSwitcherOpen(false);
      if (!excalidrawAPI || id === drawingRef.current.id) {
        return;
      }
      loadedRef.current = false;
      if (
        !(await flushSave()) &&
        !window.confirm(
          "Current drawing has unsaved changes that failed to save. Switch anyway?",
        )
      ) {
        loadedRef.current = true;
        return;
      }
      pendingRef.current = null;
      let data: DrawingData | null;
      try {
        data = await loadDrawing(id);
      } catch (error: any) {
        loadedRef.current = true;
        excalidrawAPI.setToast({ message: `Could not open: ${error.message}` });
        return;
      }
      const initial = toInitialData(data);
      excalidrawAPI.resetScene();
      excalidrawAPI.updateScene({
        elements: initial.elements as OrderedExcalidrawElement[],
        appState: initial.appState as AppState,
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (data?.files) {
        excalidrawAPI.addFiles(Object.values(data.files));
      }
      baselineVersionRef.current = getSceneVersion(initial.elements || []);
      const finalName = data?.name || name;
      if (push) {
        window.history.pushState({}, "", `/d/${id}`);
      }
      remember(id, finalName);
      setDrawing({ id, name: finalName });
      setSaveStatus("saved");
      loadedRef.current = true;
    },
    [excalidrawAPI, flushSave],
  );

  // back / forward
  useEffect(() => {
    const onPopState = () => {
      const id = getInitialId();
      openDrawing(id, id, { push: false });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [openDrawing]);

  // Ctrl/Cmd+P: quick open. Capture phase, the editor binds it to a toast.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setSwitcherOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  // don't lose edits on tab close / hide
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (pendingRef.current) {
        debouncedSave.flush();
        event.preventDefault();
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        debouncedSave.flush();
      }
    };
    window.addEventListener(EVENT.BEFORE_UNLOAD, onBeforeUnload);
    document.addEventListener(EVENT.VISIBILITY_CHANGE, onVisibility);
    return () => {
      window.removeEventListener(EVENT.BEFORE_UNLOAD, onBeforeUnload);
      document.removeEventListener(EVENT.VISIBILITY_CHANGE, onVisibility);
    };
  }, [debouncedSave]);

  return (
    <div style={{ height: "100%" }} className="excalidraw-app">
      <Excalidraw
        onChange={onChange}
        initialData={initialDataRef.current}
        UIOptions={{ canvasActions: { toggleTheme: true } }}
        detectScroll={false}
        handleKeyboardGlobally={true}
        autoFocus={true}
        theme={editorTheme}
        onThemeChange={setAppTheme}
        renderTopLeftUI={() => (
          <button
            className="drawing-chip"
            title="Open or create a drawing (Ctrl/Cmd+P)"
            onClick={() => setSwitcherOpen(true)}
          >
            <span className="drawing-chip__name">{drawing.name}</span>
            <span className={`drawing-chip__status is-${saveStatus}`}>
              {saveStatus === "saved"
                ? "saved"
                : saveStatus === "saving"
                ? "saving…"
                : "not saved!"}
            </span>
          </button>
        )}
        onLinkOpen={(element, event) => {
          if (element.link && isElementLink(element.link)) {
            event.preventDefault();
            excalidrawAPI?.setViewport({
              target: element.link,
              fit: "scale-down",
              animation: true,
            });
          }
        }}
      >
        <AppMainMenu
          theme={appTheme}
          onOpenDrawings={() => setSwitcherOpen(true)}
        />
        <AppWelcomeScreen onOpenDrawings={() => setSwitcherOpen(true)} />
        <TTDDialogTrigger />
        {/* mermaid -> diagram only, no AI backend */}
        <TTDDialog __fallback />
        <CommandPalette
          customCommandPaletteItems={[
            {
              label: "Open / create drawing",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: ["switch", "new", "file", "drawings"],
              perform: () => setSwitcherOpen(true),
            },
          ]}
        />
        {switcherOpen && (
          <DrawingSwitcher
            currentId={drawing.id}
            onOpen={openDrawing}
            onClose={() => setSwitcherOpen(false)}
          />
        )}
      </Excalidraw>
    </div>
  );
};

const ExcalidrawApp = () => (
  <TopErrorBoundary>
    <Provider store={appJotaiStore}>
      <ExcalidrawAPIProvider>
        <ExcalidrawWrapper />
      </ExcalidrawAPIProvider>
    </Provider>
  </TopErrorBoundary>
);

export default ExcalidrawApp;
