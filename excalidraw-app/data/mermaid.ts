import { FONT_FAMILY } from "@excalidraw/common";
import { MERMAID_TO_EXCALIDRAW_CONFIG } from "@excalidraw/excalidraw/mermaid";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

/** mermaid code waiting to be drawn into a freshly created board */
const pendingKey = (boardId: string) => `pending-mermaid:${boardId}`;

/** lazy: mermaid is big, only load it when a diagram is actually converted */
export const parseMermaid = async (code: string) => {
  const lib = await import("@excalidraw/mermaid-to-excalidraw");
  try {
    return await lib.parseMermaidToExcalidraw(
      code,
      MERMAID_TO_EXCALIDRAW_CONFIG,
    );
  } catch (error) {
    // same fallback as the editor's Mermaid dialog: " often breaks labels
    if (code.includes('"')) {
      try {
        return await lib.parseMermaidToExcalidraw(
          code.replace(/"/g, "'"),
          MERMAID_TO_EXCALIDRAW_CONFIG,
        );
      } catch {}
    }
    throw error;
  }
};

/** match the app's clean look: no sketchy strokes, Nunito text */
export const toCleanStyle = (
  skeletons: readonly ExcalidrawElementSkeleton[],
): ExcalidrawElementSkeleton[] =>
  skeletons.map((el: any) => ({
    ...el,
    roughness: 0,
    ...(el.type === "text" ? { fontFamily: FONT_FAMILY.Nunito } : {}),
    ...(el.label
      ? { label: { ...el.label, fontFamily: FONT_FAMILY.Nunito } }
      : {}),
  }));

export const setPendingMermaid = (boardId: string, code: string) =>
  sessionStorage.setItem(pendingKey(boardId), code);

export const takePendingMermaid = (boardId: string) => {
  try {
    const code = sessionStorage.getItem(pendingKey(boardId));
    sessionStorage.removeItem(pendingKey(boardId));
    return code;
  } catch {
    return null;
  }
};
