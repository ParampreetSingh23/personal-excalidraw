import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { FONT_FAMILY, randomId } from "@excalidraw/common";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";
import type { ExcalidrawElement } from "@excalidraw/element/types";

import { HLD_COMPONENTS } from "./components";

/**
 * Bridges the board and the AI: the board is described as a small graph on a
 * grid (nodes + edges), the AI answers with edit ops, which are turned back
 * into our own components and bound arrows.
 */

const GX = 280; // grid cell size in scene px
const GY = 200;
const BINDABLE = new Set(["rectangle", "ellipse", "diamond", "stickynote"]);

export type AiOps = {
  summary: string;
  addNodes: {
    ref: string;
    type: string;
    label: string;
    col: number;
    row: number;
  }[];
  addEdges: { from: string; to: string; label?: string }[];
  removeNodes: string[];
  removeEdges: string[];
};

type Node = {
  key: string;
  el: ExcalidrawElement;
  label: string;
  col: number;
  row: number;
};

const center = (el: ExcalidrawElement) => ({
  x: el.x + el.width / 2,
  y: el.y + el.height / 2,
});
const outerGroup = (el: ExcalidrawElement) => el.groupIds.at(-1);

/** nodes = labelled shapes (one per component group), edges = bound arrows */
export const describeBoard = (elements: readonly ExcalidrawElement[]) => {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const boundText = (el: ExcalidrawElement) => {
    const ref = el.boundElements?.find((b) => b.type === "text");
    const t = ref && byId.get(ref.id);
    return t && t.type === "text" ? t.text : "";
  };

  const nodes: Node[] = [];
  const nodeOfElement = new Map<string, Node>(); // any element id -> its node
  const seenGroups = new Map<string, Node>();
  for (const el of elements) {
    if (!BINDABLE.has(el.type) || el.isDeleted) {
      continue;
    }
    const group = outerGroup(el);
    let label = boundText(el);
    if (!label && group) {
      const t = elements.find(
        (e) => e.type === "text" && !e.containerId && outerGroup(e) === group,
      );
      label = t && t.type === "text" ? t.text : "";
    }
    if (!label) {
      continue;
    }
    // one node per component: prefer the shape that carries the label
    if (group && seenGroups.has(group) && !boundText(el)) {
      continue;
    }
    const c = center(el);
    const node: Node = {
      key: `n${nodes.length + 1}`,
      el,
      label: label.replace(/\s+/g, " ").trim(),
      col: Math.round(c.x / GX),
      row: Math.round(c.y / GY),
    };
    if (group && seenGroups.has(group)) {
      nodes.splice(nodes.indexOf(seenGroups.get(group)!), 1, node);
    } else {
      nodes.push(node);
    }
    if (group) {
      seenGroups.set(group, node);
    }
  }
  for (const node of nodes) {
    const group = outerGroup(node.el);
    for (const el of elements) {
      if (el.id === node.el.id || (group && outerGroup(el) === group)) {
        nodeOfElement.set(el.id, node);
      }
    }
  }

  const edges: { key: string; el: ExcalidrawElement; from: Node; to: Node }[] =
    [];
  for (const el of elements) {
    if (el.type !== "arrow" || el.isDeleted) {
      continue;
    }
    const from =
      el.startBinding && nodeOfElement.get(el.startBinding.elementId);
    const to = el.endBinding && nodeOfElement.get(el.endBinding.elementId);
    if (from && to) {
      edges.push({ key: `e${edges.length + 1}`, el, from, to });
    }
  }

  return {
    nodes,
    edges,
    /** what the model sees: short keys, labels, grid cells */
    forModel: {
      nodes: nodes.map((n) => ({
        id: n.key,
        label: n.label,
        col: n.col,
        row: n.row,
      })),
      edges: edges.map((e) => ({ id: e.key, from: e.from.key, to: e.to.key })),
    },
  };
};

export const askAi = async (
  prompt: string,
  diagram: unknown,
): Promise<AiOps> => {
  const response = await fetch("/api/ai", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, diagram }),
  });
  if (response.status === 401) {
    window.location.assign("/login");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `AI request failed (${response.status})`);
  }
  return {
    summary: data.summary || "Done.",
    addNodes: Array.isArray(data.addNodes) ? data.addNodes : [],
    addEdges: Array.isArray(data.addEdges) ? data.addEdges : [],
    removeNodes: Array.isArray(data.removeNodes) ? data.removeNodes : [],
    removeEdges: Array.isArray(data.removeEdges) ? data.removeEdges : [],
  };
};

/** point where the ray from a's center towards b's center leaves a's box */
const borderPoint = (
  a: ExcalidrawElement,
  toward: { x: number; y: number },
) => {
  const c = center(a);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  const sx = dx ? a.width / 2 / Math.abs(dx) : Infinity;
  const sy = dy ? a.height / 2 / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  const gap = 8 / Math.hypot(dx, dy || 1);
  return { x: c.x + dx * (s + gap), y: c.y + dy * (s + gap) };
};

/** applies the ops; returns the full next element list + the new elements */
export const applyAiOps = (
  elements: readonly ExcalidrawElement[],
  ops: AiOps,
  /** the description that was sent to the model (its keys) */
  board: ReturnType<typeof describeBoard>,
) => {
  const live = new Map(elements.map((e) => [e.id, e]));
  // nodes/edges deleted meanwhile are simply skipped
  const nodes = board.nodes.filter((n) => !live.get(n.el.id)?.isDeleted);
  const edges = board.edges.filter((e) => !live.get(e.el.id)?.isDeleted);
  const nodeByKey = new Map(nodes.map((n) => [n.key, n]));
  const edgeByKey = new Map(edges.map((e) => [e.key, e]));

  // --- deletions ------------------------------------------------------------
  const deleted = new Set<string>();
  const deleteWithText = (el: ExcalidrawElement) => {
    deleted.add(el.id);
    el.boundElements?.forEach((b) => b.type === "text" && deleted.add(b.id));
  };
  for (const key of ops.removeEdges) {
    const edge = edgeByKey.get(key);
    edge && deleteWithText(edge.el);
  }
  for (const key of ops.removeNodes) {
    const node = nodeByKey.get(key);
    if (!node) {
      continue;
    }
    const group = outerGroup(node.el);
    const parts = new Set(
      elements
        .filter(
          (el) => el.id === node.el.id || (group && outerGroup(el) === group),
        )
        .map((el) => el.id),
    );
    for (const el of elements) {
      const attached =
        el.type === "arrow" &&
        ((el.startBinding && parts.has(el.startBinding.elementId)) ||
          (el.endBinding && parts.has(el.endBinding.elementId)));
      if (parts.has(el.id) || attached) {
        deleteWithText(el);
      }
    }
  }

  // --- new nodes --------------------------------------------------------------
  const taken = new Set(
    nodes.filter((n) => !deleted.has(n.el.id)).map((n) => `${n.col},${n.row}`),
  );
  const skeletons: ExcalidrawElementSkeleton[] = [];
  const target = new Map<
    string,
    { id: string; x: number; y: number; w: number; h: number }
  >();
  for (const n of nodes) {
    const el = live.get(n.el.id) ?? n.el; // may have moved since the request
    if (!deleted.has(el.id)) {
      target.set(n.key, {
        id: el.id,
        x: el.x,
        y: el.y,
        w: el.width,
        h: el.height,
      });
    }
  }
  const newIds = new Set<string>();
  for (const n of ops.addNodes) {
    const comp =
      HLD_COMPONENTS.find((c) => c.type === n.type) ??
      HLD_COMPONENTS.find((c) => c.type === "service")!;
    let { col, row } = n;
    // ponytail: the model is told to avoid taken cells; this only nudges down
    while (taken.has(`${col},${row}`)) {
      row++;
    }
    taken.add(`${col},${row}`);
    const id = randomId();
    newIds.add(id);
    const built = comp.build(col * GX, row * GY, { text: n.label, id });
    skeletons.push(...built);
    const main = built.find((s) => (s as any).id === id) as any;
    target.set(n.ref, {
      id,
      x: main.x,
      y: main.y,
      w: main.width,
      h: main.height,
    });
  }

  // --- edges ------------------------------------------------------------------
  // arrows can only bind to elements in the same conversion batch, so existing
  // endpoints are cloned in as stand-ins and dropped after conversion
  const standIns = new Set<string>();
  for (const e of ops.addEdges) {
    const a = target.get(e.from);
    const b = target.get(e.to);
    if (!a || !b || a.id === b.id) {
      continue;
    }
    for (const t of [a, b]) {
      if (!newIds.has(t.id) && !standIns.has(t.id)) {
        const el = elements.find((x) => x.id === t.id)!;
        standIns.add(t.id);
        skeletons.push({
          type: el.type as any,
          id: el.id,
          x: el.x,
          y: el.y,
          width: el.width,
          height: el.height,
        });
      }
    }
    const boxA = {
      x: a.x,
      y: a.y,
      width: a.w,
      height: a.h,
    } as ExcalidrawElement;
    const boxB = {
      x: b.x,
      y: b.y,
      width: b.w,
      height: b.h,
    } as ExcalidrawElement;
    const p1 = borderPoint(boxA, center(boxB));
    const p2 = borderPoint(boxB, center(boxA));
    skeletons.push({
      type: "arrow",
      x: p1.x,
      y: p1.y,
      width: p2.x - p1.x,
      height: p2.y - p1.y,
      points: [
        [0, 0],
        [p2.x - p1.x, p2.y - p1.y],
      ] as any,
      start: { id: a.id },
      end: { id: b.id },
      strokeColor: "#495057",
      strokeWidth: 1,
      roughness: 0,
      ...(e.label
        ? {
            label: {
              text: e.label,
              fontSize: 14,
              fontFamily: FONT_FAMILY.Nunito,
            },
          }
        : {}),
    } as ExcalidrawElementSkeleton);
  }

  // keep our ids: stand-ins must match the real elements, arrows bind by id
  const converted = convertToExcalidrawElements(skeletons, {
    regenerateIds: false,
  });
  const added = converted.filter((el) => !standIns.has(el.id));
  const standInById = new Map(
    converted.filter((el) => standIns.has(el.id)).map((el) => [el.id, el]),
  );

  const next = elements.map((el) => {
    if (deleted.has(el.id)) {
      return {
        ...el,
        isDeleted: true,
        version: el.version + 1,
      } as ExcalidrawElement;
    }
    const standIn = standInById.get(el.id);
    if (standIn) {
      // keep the real element, just register the new arrows on it
      const arrows = (standIn.boundElements ?? []).filter(
        (b) => b.type === "arrow",
      );
      return {
        ...el,
        boundElements: [...(el.boundElements ?? []), ...arrows],
        version: el.version + 1,
      } as ExcalidrawElement;
    }
    return el;
  });

  return { elements: [...next, ...added], added };
};
