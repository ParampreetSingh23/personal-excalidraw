import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import {
  restoreAppState,
  restoreElements,
} from "@excalidraw/excalidraw/data/restore";
import { useEffect, useState } from "react";

import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";

import { loadPublicDrawing } from "../data/drawings";

/** what someone with a share link sees: the board, view-only, no login */
export const SharedView = ({ token }: { token: string }) => {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "missing" }
    | { status: "ready"; name: string; data: ExcalidrawInitialDataState }
  >({ status: "loading" });

  useEffect(() => {
    loadPublicDrawing(token)
      .then((data) => {
        if (!data) {
          setState({ status: "missing" });
          return;
        }
        document.title = `${data.name} · Draw`;
        setState({
          status: "ready",
          name: data.name,
          data: {
            elements: restoreElements(data.elements, null),
            appState: {
              ...restoreAppState(data.appState, null),
              viewModeEnabled: true,
            },
            files: data.files,
          },
        });
      })
      .catch(() => setState({ status: "missing" }));
  }, [token]);

  if (state.status !== "ready") {
    return (
      <div className="shared-empty">
        {state.status === "loading"
          ? "Loading…"
          : "This link doesn't exist or is no longer shared."}
      </div>
    );
  }

  return (
    <div style={{ height: "100%" }}>
      <Excalidraw
        initialData={state.data}
        viewModeEnabled
        onInitialize={(api) =>
          // whole board in view, whatever the visitor's screen size
          requestAnimationFrame(() =>
            api.setViewport({
              target: api.getSceneElements(),
              fit: "scale-down",
              offsets: { ui: true },
            }),
          )
        }
        UIOptions={{
          canvasActions: {
            loadScene: false,
            saveToActiveFile: false,
            clearCanvas: false,
          },
        }}
        renderTopLeftUI={() => (
          <div className="drawing-chip shared-chip">
            <span className="drawing-chip__name">{state.name}</span>
            <span className="drawing-chip__status">read-only</span>
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.ToggleTheme allowSystemTheme={false} />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  );
};
