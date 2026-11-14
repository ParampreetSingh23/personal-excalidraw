import { getCommonBounds } from "@excalidraw/excalidraw";
import {
  Scene,
  isBindableElement,
  updateBoundElements,
} from "@excalidraw/element";

import type {
  ExcalidrawElement,
  NonDeletedExcalidrawElement,
} from "@excalidraw/element/types";

import { describeBoard, outerGroup } from "./ai";

/**
 * "Tidy up": lays the board's components out left-to-right in layers (dagre)
 * and moves them there. Arrows are NOT recreated: they keep their ids, labels
 * and style, and are re-routed by the editor's own binding logic (the same
 * code that runs while you drag a box), so elbow arrows stay elbowed and undo
 * is a plain "move back".
 *
 * Shapes that aren't components (free text, sketches) stay where they are,
 * and so do regions (a box that contains other components, e.g. a cluster).
 */
export const tidyUp = async (elements: readonly ExcalidrawElement[]) => {
  // big library, only loaded when someone tidies
  const dagre = await import("@dagrejs/dagre");

  // work on copies: the scene helpers mutate in place, and the editor's own
  // element objects must stay untouched (history diffs against them)
  const copies: ExcalidrawElement[] = structuredClone(
    elements as ExcalidrawElement[],
  );
  const live = copies.filter((el) => !el.isDeleted);
  const board = describeBoard(live);

  // every element of a component: its group (or itself) + bound texts
  const partsOf = (el: ExcalidrawElement) => {
    const group = outerGroup(el);
    const parts = live.filter(
      (x) =>
        x.type !== "arrow" &&
        (x.id === el.id || (group && outerGroup(x) === group)),
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

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90, edgesep: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const c of movable) {
    g.setNode(c.node.key, { width: c.x2 - c.x1, height: c.y2 - c.y1 });
  }
  const keys = new Set(movable.map((c) => c.node.key));
  for (const e of board.edges) {
    if (keys.has(e.from.key) && keys.has(e.to.key) && e.from !== e.to) {
      g.setEdge(e.from.key, e.to.key, {}, e.key);
    }
  }
  // an invisible root feeding every source (nothing points into it: users,
  // clients, config...) pulls all sources into the first column
  const hasIncoming = new Set(g.edges().map((e) => e.w));
  const ROOT = "__root__";
  g.setNode(ROOT, { width: 1, height: 1 });
  for (const c of movable) {
    if (!hasIncoming.has(c.node.key) && g.nodeEdges(c.node.key)?.length) {
      g.setEdge(ROOT, c.node.key, { weight: 10 }, ROOT + c.node.key);
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

  const scene = new Scene(copies);
  const moved: ExcalidrawElement[] = [];
  let movedComponents = 0;
  for (const c of movable) {
    const n = g.node(c.node.key);
    const dx = ox + (n.x - n.width / 2 - minX) - c.x1;
    const dy = oy + (n.y - n.height / 2 - minY) - c.y1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      continue;
    }
    movedComponents++;
    for (const p of c.parts) {
      scene.mutateElement(p, { x: p.x + dx, y: p.y + dy });
      moved.push(p);
    }
  }
  if (!moved.length) {
    return { elements: copies, moved: 0 };
  }

  // Elbow arrows remember which side of a box they attach to and any segment
  // the user pinned; both are stale after a re-layout (that's what sends
  // arrows looping around boxes). Re-pick sides from the new positions and
  // spread several arrows on one side instead of stacking them.
  type End = {
    arrow: ExcalidrawElement;
    which: "startBinding" | "endBinding";
    other: ExcalidrawElement;
  };
  const sides = new Map<string, End[]>(); // `${elementId}:${side}` -> ends
  const byId = new Map(copies.map((el) => [el.id, el]));
  const centerOf = (el: ExcalidrawElement) => ({
    x: el.x + el.width / 2,
    y: el.y + el.height / 2,
  });
  const sideTowards = (from: ExcalidrawElement, to: ExcalidrawElement) => {
    const a = centerOf(from);
    const b = centerOf(to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    // prefer left/right: the layout flows left-to-right
    if (Math.abs(dx) * 1.5 >= Math.abs(dy)) {
      return dx >= 0 ? "right" : "left";
    }
    return dy >= 0 ? "bottom" : "top";
  };
  for (const e of board.edges) {
    const arrow = byId.get(e.el.id);
    if (!arrow || arrow.type !== "arrow" || !(arrow as any).elbowed) {
      continue;
    }
    const start = arrow.startBinding && byId.get(arrow.startBinding.elementId);
    const end = arrow.endBinding && byId.get(arrow.endBinding.elementId);
    if (!start || !end) {
      continue;
    }
    for (const [self, other, which] of [
      [start, end, "startBinding"],
      [end, start, "endBinding"],
    ] as const) {
      const key = `${self.id}:${sideTowards(self, other)}`;
      sides.set(key, [...(sides.get(key) ?? []), { arrow, which, other }]);
    }
  }
  const GAP = 0.03; // just outside the box, like the editor's own bindings
  for (const [key, ends] of sides) {
    const side = key.slice(key.lastIndexOf(":") + 1);
    const vertical = side === "left" || side === "right";
    ends.sort((a, b) =>
      vertical
        ? centerOf(a.other).y - centerOf(b.other).y
        : centerOf(a.other).x - centerOf(b.other).x,
    );
    ends.forEach(({ arrow, which }, i) => {
      // 0.0001 off: an exact 0.5 has a special meaning for the editor
      const along = (i + 1) / (ends.length + 1) + 0.0001;
      const fixedPoint: [number, number] =
        side === "right"
          ? [1 + GAP, along]
          : side === "left"
          ? [-GAP, along]
          : side === "bottom"
          ? [along, 1 + GAP]
          : [along, -GAP];
      const binding = (arrow as any)[which];
      scene.mutateElement(arrow as any, {
        [which]: { ...binding, fixedPoint },
        fixedSegments: null,
        startIsSpecial: false,
        endIsSpecial: false,
      });
    });
  }

  // let the editor re-route every arrow attached to a moved shape. Called
  // once per shape after *all* moves, so both ends see final positions.
  for (const el of moved) {
    if (isBindableElement(el) && !el.isDeleted) {
      updateBoundElements(el as NonDeletedExcalidrawElement, scene);
    }
  }

  return {
    elements: scene.getElementsIncludingDeleted(),
    moved: movedComponents,
  };
};
