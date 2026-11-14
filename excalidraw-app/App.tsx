import {
  Excalidraw,
  TTDDialog,
  TTDDialogTrigger,
  CaptureUpdateAction,
  ExcalidrawAPIProvider,
  Sidebar,
  convertToExcalidrawElements,
  getCommonBounds,
  exportScene,
  useExcalidrawAPI,
} from "@excalidraw/excalidraw";
import { clearAppStateForLocalStorage } from "@excalidraw/excalidraw/appState";
import {
  CommandPalette,
  DEFAULT_CATEGORIES,
} from "@excalidraw/excalidraw/components/CommandPalette/CommandPalette";
import {
  debounce,
  EVENT,
  FONT_FAMILY,
  isWritableElement,
  resolvablePromise,
} from "@excalidraw/common";
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
import type {
  NonDeletedExcalidrawElement,
  OrderedExcalidrawElement,
} from "@excalidraw/element/types";
import type { ResolvablePromise } from "@excalidraw/common/utils";

import { Provider, appJotaiStore } from "./app-jotai";
import {
  SAVE_DEBOUNCE_MS,
  SAVE_RETRY_MS,
  THUMBNAIL_DEBOUNCE_MS,
} from "./app_constants";
import { AppMainMenu } from "./components/AppMainMenu";
import { AppWelcomeScreen } from "./components/AppWelcomeScreen";
import {
  ALT,
  COMPONENTS_SIDEBAR,
  ComponentsPanel,
} from "./components/ComponentsPanel";
import { AiBar } from "./components/AiBar";
import { Dashboard } from "./components/Dashboard";
import { ShareDialog } from "./components/ShareDialog";
import { SharedView } from "./components/SharedView";
import { DrawingSwitcher } from "./components/DrawingSwitcher";
import { TopErrorBoundary } from "./components/TopErrorBoundary";
import { loadDrawing, saveDrawing, saveThumbnail } from "./data/drawings";
import { tidyUp } from "./data/layout";
import { applyAiOps, askAi, describeBoard } from "./data/ai";
import { HLD_COMPONENTS } from "./data/components";
import { LibraryIndexedDBAdapter } from "./data/library";
import { parseMermaid, takePendingMermaid, toCleanStyle } from "./data/mermaid";
import { useHandleAppTheme } from "./useHandleAppTheme";

import "./index.scss";

import type { HLDComponent } from "./data/components";
import type { DrawingData } from "./data/drawings";

polyfill();

window.EXCALIDRAW_THROTTLE_RENDER = true;

type SaveStatus = "saved" | "saving" | "error";

/** drawing id from `/d/<id>`; null = boards dashboard */
const getBoardId = () =>
  window.location.pathname.match(/^\/d\/([a-z0-9-]+)\/?$/)?.[1] ?? null;

/** clean, non-sketchy defaults; a board's own saved state wins */
const DEFAULT_APP_STATE: Partial<AppState> = {
  currentItemRoughness: 0,
  currentItemStrokeWidthKey: "thin",
  currentItemFontFamily: FONT_FAMILY.Nunito,
  currentItemArrowType: "elbow",
  openSidebar: { name: COMPONENTS_SIDEBAR },
};

const toInitialData = (
  data: DrawingData | null,
): ExcalidrawInitialDataState => ({
  elements: restoreElements(data?.elements, null, { repairBindings: true }),
  appState: restoreAppState({ ...DEFAULT_APP_STATE, ...data?.appState }, null),
  files: data?.files,
});
const ExcalidrawWrapper = () => {
  const excalidrawAPI = useExcalidrawAPI();
  const { editorTheme, appTheme, setAppTheme } = useHandleAppTheme();

  const [drawing, setDrawing] = useState(() => {
    const id = getBoardId()!;
    return { id, name: id };
  });
  const [panelDocked, setPanelDocked] = useState(true);
  const [aiOpen, setAiOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
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
      debouncedThumbnail(
        pending.id,
        getNonDeletedElements(pending.elements),
        files,
      );
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

  // dashboard preview: a small JPEG, made once the board has been quiet a bit
  const debouncedThumbnail = useMemo(
    () =>
      debounce(
        async (
          id: string,
          elements: readonly NonDeletedExcalidrawElement[],
          files: BinaryFiles,
        ) => {
          if (!elements.length) {
            return;
          }
          try {
            const jpeg = await exportScene({
              type: "jpeg",
              data: { elements, files },
              config: {
                maxWidthOrHeight: 480,
                quality: 0.8,
                canvasBackgroundColor: "#ffffff",
                padding: 24,
              },
            });
            await saveThumbnail(id, jpeg);
          } catch (error) {
            console.warn("thumbnail failed", error);
          }
        },
        THUMBNAIL_DEBOUNCE_MS,
      ),
    [],
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

  const remember = (_id: string, name: string) => {
    document.title = `${name} · Draw`;
  };

  // initial load
  useEffect(() => {
    const { id } = drawingRef.current;
    loadDrawing(id)
      .then(async (data) => {
        const initial = toInitialData(data);
        baselineVersionRef.current = getSceneVersion(initial.elements || []);
        // board created from the dashboard's "From Mermaid": draw it now.
        // Baseline stays pre-mermaid, so the first onChange saves it.
        const mermaid = takePendingMermaid(id);
        if (mermaid) {
          try {
            const { elements, files } = await parseMermaid(mermaid);
            initial.elements = [
              ...(initial.elements || []),
              ...convertToExcalidrawElements(toCleanStyle(elements), {
                regenerateIds: true,
              }),
            ];
            initial.files = { ...initial.files, ...files };
          } catch (error: any) {
            initial.appState = {
              ...initial.appState,
              errorMessage: `Mermaid could not be converted: ${error.message}`,
            };
          }
        }
        if (data?.name) {
          setDrawing({ id, name: data.name });
        }
        remember(id, data?.name || id);
        initialDataRef.current.resolve({
          ...initial,
          scrollToContent: !!initial.elements?.length,
        });
        // older boards (and Mermaid/AI-only ones) get a dashboard preview too
        if (initial.elements?.length) {
          debouncedThumbnail(
            id,
            getNonDeletedElements(initial.elements),
            initial.files || {},
          );
        }
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
  }, [debouncedThumbnail]); // stable (memoized once): still runs once

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

  const renameBoard = useCallback(() => {
    const name = window.prompt("Rename board", drawingRef.current.name)?.trim();
    if (!name || name === drawingRef.current.name || !excalidrawAPI) {
      return;
    }
    // id (and URL) stay the same; only the display name changes
    drawingRef.current = { ...drawingRef.current, name };
    setDrawing(drawingRef.current);
    remember(drawingRef.current.id, name);
    pendingRef.current = {
      ...drawingRef.current,
      elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
      appState: excalidrawAPI.getAppState(),
      files: excalidrawAPI.getFiles(),
    };
    setSaveStatus("saving");
    debouncedSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excalidrawAPI, debouncedSave]);

  const runAi = useCallback(
    async (prompt: string) => {
      if (!excalidrawAPI) {
        throw new Error("Editor not ready");
      }
      const board = describeBoard(excalidrawAPI.getSceneElements());
      const ops = await askAi(prompt, board.forModel);
      const { elements, added, changed } = applyAiOps(
        excalidrawAPI.getSceneElementsIncludingDeleted(),
        ops,
        board,
      );
      if (!changed) {
        // don't claim success when the answer matched nothing on the board
        throw new Error(
          `AI answered but nothing on the board changed ("${ops.summary}"). Try rephrasing.`,
        );
      }
      excalidrawAPI.updateScene({
        elements: elements as OrderedExcalidrawElement[],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
      if (added.length) {
        // next frame: the scene update above has to land first
        requestAnimationFrame(() =>
          excalidrawAPI.setViewport({
            target: excalidrawAPI.getSceneElements(),
            fit: "scale-down",
            animation: true,
            // keep clear of the docked panel and toolbars
            offsets: { ui: true },
          }),
        );
      }
      return ops.summary;
    },
    [excalidrawAPI],
  );

  const tidy = useCallback(async () => {
    if (!excalidrawAPI) {
      return;
    }
    const result = await tidyUp(
      excalidrawAPI.getSceneElementsIncludingDeleted(),
    );
    if (!result) {
      excalidrawAPI.setToast({
        message: "Nothing to tidy: needs at least 2 components",
      });
      return;
    }
    excalidrawAPI.updateScene({
      elements: result.elements as OrderedExcalidrawElement[],
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
    requestAnimationFrame(() =>
      excalidrawAPI.setViewport({
        target: excalidrawAPI.getSceneElements(),
        fit: "scale-down",
        animation: true,
        offsets: { ui: true },
      }),
    );
    excalidrawAPI.setToast({
      message: `Tidied ${result.moved} components · ⌘Z to undo`,
    });
  }, [excalidrawAPI]);

  // back / forward
  useEffect(() => {
    const onPopState = () => {
      const id = getBoardId();
      if (id) {
        openDrawing(id, id, { push: false });
      } else {
        window.location.reload(); // back to the dashboard
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [openDrawing]);

  // ---------------------------------------------------------------------------
  // HLD components
  // ---------------------------------------------------------------------------

  const insertComponent = useCallback(
    (component: HLDComponent) => {
      if (!excalidrawAPI) {
        return;
      }
      const { scrollX, scrollY, zoom, width, height } =
        excalidrawAPI.getAppState();
      const existing = excalidrawAPI
        .getSceneElements()
        .map((e) => getCommonBounds([e]));
      const overlaps = ([x1, y1, x2, y2]: readonly number[]) =>
        existing.some(
          ([a1, b1, a2, b2]) => x1 < a2 && x2 > a1 && y1 < b2 && y2 > b1,
        );
      // start at viewport center, walk right then down to the first free spot
      // ponytail: O(tries * elements), fine for diagram-sized scenes
      const cx0 = width / 2 / zoom.value - scrollX;
      const cy0 = height / 2 / zoom.value - scrollY;
      let added = convertToExcalidrawElements(component.build(cx0, cy0), {
        regenerateIds: true,
      });
      const [bx1, by1, bx2, by2] = getCommonBounds(added);
      const stepX = bx2 - bx1 + 40;
      const stepY = by2 - by1 + 40;
      search: for (let row = 0; row < 6; row++) {
        for (let col = 0; col < 6; col++) {
          const dx = col * stepX;
          const dy = row * stepY;
          if (!overlaps([bx1 + dx, by1 + dy, bx2 + dx, by2 + dy])) {
            if (dx || dy) {
              added = convertToExcalidrawElements(
                component.build(cx0 + dx, cy0 + dy),
                { regenerateIds: true },
              );
            }
            break search;
          }
        }
      }
      excalidrawAPI.updateScene({
        elements: [
          ...excalidrawAPI.getSceneElementsIncludingDeleted(),
          ...added,
        ],
        appState: {
          selectedElementIds: Object.fromEntries(
            added
              .filter((e) => !("containerId" in e && e.containerId))
              .map((e) => [e.id, true]),
          ),
          selectedGroupIds: Object.fromEntries(
            added.flatMap((e) => e.groupIds).map((id) => [id, true]),
          ),
        },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY,
      });
    },
    [excalidrawAPI],
  );

  // Alt+<key>: insert component, Alt+1: toggle panel.
  // event.code, since Alt+letter types special chars on macOS.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        isWritableElement(event.target)
      ) {
        return;
      }
      if (event.code === "KeyT") {
        event.preventDefault();
        event.stopImmediatePropagation();
        tidy();
        return;
      }
      if (event.code === "KeyI") {
        event.preventDefault();
        event.stopImmediatePropagation();
        setAiOpen((open) => !open);
        return;
      }
      if (event.code === "Digit1") {
        event.preventDefault();
        event.stopImmediatePropagation();
        excalidrawAPI?.toggleSidebar({ name: COMPONENTS_SIDEBAR });
        return;
      }
      const component = HLD_COMPONENTS.find(
        (c) => event.code === `Key${c.key}`,
      );
      if (component) {
        event.preventDefault();
        event.stopImmediatePropagation();
        insertComponent(component);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [excalidrawAPI, insertComponent, tidy]);

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
          <div className="top-left-bar">
            <a
              className="drawing-chip drawing-chip--home"
              href="/"
              title="All boards"
            >
              Boards
            </a>
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
          </div>
        )}
        renderTopRightUI={(isMobile) =>
          isMobile ? null : (
            <div className="top-right-bar">
              <button
                className="top-btn"
                title={`Tidy up layout (${ALT}T)`}
                onClick={tidy}
              >
                Tidy
              </button>
              <button
                className="top-btn"
                title="Share read-only link"
                onClick={() => setShareOpen(true)}
              >
                Share
              </button>
              <button
                className="ai-trigger"
                title={`Ask AI (${ALT}I)`}
                onClick={() => setAiOpen((open) => !open)}
              >
                ✦ AI
              </button>
              <Sidebar.Trigger
                name={COMPONENTS_SIDEBAR}
                title={`Components (${ALT}1)`}
                className="components-trigger"
              >
                Components
              </Sidebar.Trigger>
            </div>
          )
        }
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
          onRename={renameBoard}
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
            {
              label: "Tidy up layout",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: ["layout", "arrange", "auto", "clean", "organize"],
              perform: tidy,
            },
            {
              label: "Share read-only link",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: ["share", "link", "public", "view"],
              perform: () => setShareOpen(true),
            },
            {
              label: "Ask AI",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: ["ai", "gemini", "generate", "prompt", "design"],
              perform: () => setAiOpen(true),
            },
            {
              label: "Rename board",
              category: DEFAULT_CATEGORIES.app,
              predicate: true,
              keywords: ["name", "title"],
              perform: renameBoard,
            },
          ]}
        />
        <ComponentsPanel
          docked={panelDocked}
          onDock={setPanelDocked}
          onInsert={insertComponent}
        />
        {shareOpen && (
          <ShareDialog
            boardId={drawing.id}
            onClose={() => setShareOpen(false)}
          />
        )}
        {aiOpen && <AiBar onSubmit={runAi} onClose={() => setAiOpen(false)} />}
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

const getShareToken = () =>
  window.location.pathname.match(/^\/s\/([A-Za-z0-9_-]+)\/?$/)?.[1] ?? null;

const ExcalidrawApp = () => (
  <TopErrorBoundary>
    {getShareToken() ? (
      <SharedView token={getShareToken()!} />
    ) : getBoardId() ? (
      <Provider store={appJotaiStore}>
        <ExcalidrawAPIProvider>
          <ExcalidrawWrapper />
        </ExcalidrawAPIProvider>
      </Provider>
    ) : (
      <Dashboard />
    )}
  </TopErrorBoundary>
);

export default ExcalidrawApp;
