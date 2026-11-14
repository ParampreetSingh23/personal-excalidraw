import { getCommonBounds } from "@excalidraw/excalidraw";

import type { ExcalidrawElement } from "@excalidraw/element/types";

import { convertWithArrows, describeBoard, outerGroup } from "./ai";

import type { ArrowPair, Box } from "./ai";

/**
 * "Tidy up": lays the board's components out left-to-right in layers (dagre),
 * then redraws the connections between them so no arrow keeps a stale route.
 * Shapes that aren't components (free text, sketches) stay where they are,
 * and so do regions (a box that contains other components, e.g. a cluster).
 */
export const tidyUp = async (elements: readonly ExcalidrawElement[]) => {
  // big library, only loaded when someone tidies
  const dagre = await import("@dagrejs/dagre");

  const live = elements.filter((el) => !el.isDeleted);
  const board = describeBoard(live);

  // every element of a component: its group (or itself) + bound texts
  const partsOf = (el: ExcalidrawElement) => {
    const group = outerGroup(el);
    const parts = live.filter(
      (x) => x.id === el.id || (group && outerGroup(x) === group),
    );
    const texts = new Set(
      parts.flatMap((p) =>
        (p.boundElements ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.id),
      ),
    );
    return [
      ...parts,
      ...live.filter((x) => texts.has(x.id) && !parts.includes(x)),
    ];
  };

  const comps = board.nodes.map((node) => {
    const parts = partsOf(node.el);
    const [x1, y1, x2, y2] = getCommonBounds(parts);
    return { node, parts, x1, y1, x2, y2 };
  });
  // a component whose box holds another component's center is a region
  const regions = new Set(
    comps
      .filter((c) =>
        comps.some((o) => {
          if (o === c) {
            return false;
          }
          const cx = (o.x1 + o.x2) / 2;
          const cy = (o.y1 + o.y2) / 2;
          return cx > c.x1 && cx < c.x2 && cy > c.y1 && cy < c.y2;
        }),
      )
      .map((c) => c.node.key),
  );
  const movable = comps.filter((c) => !regions.has(c.node.key));
  if (movable.length < 2) {
    return null;
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: "LR", nodesep: 50, ranksep: 110 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const c of movable) {
    g.setNode(c.node.key, { width: c.x2 - c.x1, height: c.y2 - c.y1 });
  }
  const keys = new Set(movable.map((c) => c.node.key));
  for (const e of board.edges) {
    if (keys.has(e.from.key) && keys.has(e.to.key) && e.from !== e.to) {
      g.setEdge(e.from.key, e.to.key);
    }
  }
  dagre.layout(g);

  // keep the diagram where it was: align the layout's top-left with the old one
  const ox = Math.min(...movable.map((c) => c.x1));
  const oy = Math.min(...movable.map((c) => c.y1));
  let minX = Infinity;
  let minY = Infinity;
  for (const c of movable) {
    const n = g.node(c.node.key);
    minX = Math.min(minX, n.x - n.width / 2);
    minY = Math.min(minY, n.y - n.height / 2);
  }

  const shift = new Map<string, { dx: number; dy: number }>(); // element id -> move
  const boxOf = new Map<string, Box>(); // node key -> new main-shape box
  for (const c of movable) {
    const n = g.node(c.node.key);
    const dx = ox + (n.x - n.width / 2 - minX) - c.x1;
    const dy = oy + (n.y - n.height / 2 - minY) - c.y1;
    for (const p of c.parts) {
      shift.set(p.id, { dx, dy });
    }
    const el = c.node.el;
    boxOf.set(c.node.key, {
      id: el.id,
      x: el.x + dx,
      y: el.y + dy,
      w: el.width,
      h: el.height,
    });
  }
  for (const c of comps.filter((c) => regions.has(c.node.key))) {
    const el = c.node.el;
    boxOf.set(c.node.key, {
      id: el.id,
      x: el.x,
      y: el.y,
      w: el.width,
      h: el.height,
    });
  }

  // redraw every component-to-component arrow, keeping its label
  const textOf = (arrow: ExcalidrawElement) => {
    const ref = arrow.boundElements?.find((b) => b.type === "text");
    const t = ref && live.find((x) => x.id === ref.id);
    return t && t.type === "text" ? t.text : undefined;
  };
  const removed = new Set<string>();
  const pairs: ArrowPair[] = [];
  for (const e of board.edges) {
    const a = boxOf.get(e.from.key);
    const b = boxOf.get(e.to.key);
    if (!a || !b) {
      continue;
    }
    removed.add(e.el.id);
    e.el.boundElements?.forEach((x) => x.type === "text" && removed.add(x.id));
    pairs.push({ a, b, label: textOf(e.el) });
  }

  const { added, arrowRefs } = convertWithArrows(
    elements,
    [],
    new Set(),
    pairs,
  );

  const next = elements.map((el) => {
    if (removed.has(el.id)) {
      return {
        ...el,
        isDeleted: true,
        version: el.version + 1,
      } as ExcalidrawElement;
    }
    const move = shift.get(el.id);
    const arrows = arrowRefs.get(el.id);
    if (!move && !arrows) {
      return el;
    }
    const boundElements = arrows
      ? [
          ...(el.boundElements ?? []).filter((b) => !removed.has(b.id)),
          ...arrows,
        ]
      : el.boundElements;
    return {
      ...el,
      x: el.x + (move?.dx ?? 0),
      y: el.y + (move?.dy ?? 0),
      boundElements,
      version: el.version + 1,
    } as ExcalidrawElement;
  });

  return { elements: [...next, ...added], moved: movable.length };
};
