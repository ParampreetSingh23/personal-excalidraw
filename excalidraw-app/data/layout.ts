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
 * Containers (a box holding other boxes: VPC, cluster...) move as one unit
 * with everything inside them. Loose text/sketches move with the unit they
 * sit in or next to. If an arrow isn't attached to boxes and would be left
 * dangling, nothing is changed and the reason is returned instead.
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

  type Box = { x1: number; y1: number; x2: number; y2: number };
  const area = (b: Box) => (b.x2 - b.x1) * (b.y2 - b.y1);
  const inside = (b: Box, x: number, y: number, pad = 0) =>
    x > b.x1 - pad && x < b.x2 + pad && y > b.y1 - pad && y < b.y2 + pad;

  const comps = board.nodes.map((node) => {
    const parts = partsOf(node.el);
    const [x1, y1, x2, y2] = getCommonBounds(parts);
    return { key: node.key, node, parts, x1, y1, x2, y2 };
  });
  type Comp = typeof comps[number];

  // containers (VPC, cluster, AZ...) move together with what's inside them:
  // every component belongs to its outermost enclosing component = its unit
  const parentOf = new Map<Comp, Comp>();
  for (const c of comps) {
    const cx = (c.x1 + c.x2) / 2;
    const cy = (c.y1 + c.y2) / 2;
    let best: Comp | undefined;
    for (const o of comps) {
      if (o !== c && area(o) > area(c) && inside(o, cx, cy)) {
        if (!best || area(o) < area(best)) {
          best = o;
        }
      }
    }
    if (best) {
      parentOf.set(c, best);
    }
  }
  const rootOf = (c: Comp) => {
    let r = c;
    while (parentOf.has(r)) {
      r = parentOf.get(r)!;
    }
    return r;
  };
  const units = comps.filter((c) => !parentOf.has(c));
  if (units.length < 2) {
    return { error: "Nothing to tidy: needs at least 2 boxes" };
  }

  const unitOfElement = new Map<string, Comp>(); // element id -> its unit
  const members = new Map<Comp, ExcalidrawElement[]>();
  for (const c of comps) {
    const u = rootOf(c);
    for (const p of c.parts) {
      unitOf(p.id, u);
    }
  }
  function unitOf(id: string, u: Comp) {
    unitOfElement.set(id, u);
  }
  // loose things (free text, sketches) inside or right next to a unit move
  // with it; anything farther away stays where it is
  const smallestUnitAround = (x: number, y: number, pad: number) => {
    let best: Comp | undefined;
    for (const u of units) {
      if (inside(u, x, y, pad) && (!best || area(u) < area(best))) {
        best = u;
      }
    }
    return best;
  };
  for (const el of live) {
    if (
      el.type === "arrow" ||
      unitOfElement.has(el.id) ||
      (el.type === "text" && el.containerId)
    ) {
      continue;
    }
    const u = smallestUnitAround(el.x + el.width / 2, el.y + el.height / 2, 40);
    if (u) {
      unitOf(el.id, u);
    }
  }

  // arrows: bound on both ends -> re-routed by the editor; fully inside one
  // unit -> moves with it; otherwise tidying would leave it dangling
  const ends = (a: ExcalidrawElement) => {
    const pts = (a as any).points as [number, number][];
    const first = pts[0];
    const last = pts[pts.length - 1];
    return [
      { x: a.x + first[0], y: a.y + first[1] },
      { x: a.x + last[0], y: a.y + last[1] },
    ];
  };
  let loose = 0;
  for (const a of live) {
    if (a.type !== "arrow" && a.type !== "line") {
      continue;
    }
    const [p1, p2] = ends(a);
    const b1 = a.type === "arrow" ? a.startBinding?.elementId : undefined;
    const b2 = a.type === "arrow" ? a.endBinding?.elementId : undefined;
    const u1 =
      (b1 && unitOfElement.get(b1)) || smallestUnitAround(p1.x, p1.y, 20);
    const u2 =
      (b2 && unitOfElement.get(b2)) || smallestUnitAround(p2.x, p2.y, 20);
    if (b1 && b2) {
      continue; // the editor re-routes it
    }
    if (u1 && u1 === u2) {
      unitOf(a.id, u1); // drawn inside one container: move along
    } else if (u1 || u2) {
      loose++;
    }
  }
  if (loose) {
    return {
      error: `${loose} arrow${
        loose > 1 ? "s aren't" : " isn't"
      } attached to boxes, so tidying would break ${
        loose > 1 ? "them" : "it"
      }. Drag each arrow end onto its box, then tidy.`,
    };
  }
  for (const [id, u] of unitOfElement) {
    const el = live.find((x) => x.id === id);
    if (el) {
      members.set(u, [...(members.get(u) ?? []), el]);
    }
  }

  const g = new dagre.graphlib.Graph({ multigraph: true });
  // keep the author's orientation: mostly-vertical arrows -> top-to-bottom
  let horizontal = 0;
  let vertical = 0;
  for (const a of live) {
    if (a.type === "arrow" && a.startBinding && a.endBinding) {
      const [p1, p2] = ends(a);
      if (Math.abs(p2.x - p1.x) >= Math.abs(p2.y - p1.y)) {
        horizontal++;
      } else {
        vertical++;
      }
    }
  }
  const rankdir = vertical > horizontal ? "TB" : "LR";
  g.setGraph({ rankdir, nodesep: 40, ranksep: 90, edgesep: 20 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const u of units) {
    g.setNode(u.key, { width: u.x2 - u.x1, height: u.y2 - u.y1 });
  }
  const crossUnitArrows = new Set<string>();
  for (const a of live) {
    if (a.type !== "arrow" || !a.startBinding || !a.endBinding) {
      continue;
    }
    const u1 = unitOfElement.get(a.startBinding.elementId);
    const u2 = unitOfElement.get(a.endBinding.elementId);
    if (u1 && u2 && u1 !== u2) {
      g.setEdge(u1.key, u2.key, {}, a.id);
      crossUnitArrows.add(a.id);
    }
  }
  // an invisible root feeding every source (nothing points into it: users,
  // clients, config...) pulls all sources into the first column
  const hasIncoming = new Set(g.edges().map((e) => e.w));
  const ROOT = "__root__";
  g.setNode(ROOT, { width: 1, height: 1 });
  for (const u of units) {
    if (!hasIncoming.has(u.key) && g.nodeEdges(u.key)?.length) {
      g.setEdge(ROOT, u.key, { weight: 10 }, ROOT + u.key);
    }
  }
  dagre.layout(g);

  // keep the diagram where it was: align the layout's top-left with the old one
  const ox = Math.min(...units.map((u) => u.x1));
  const oy = Math.min(...units.map((u) => u.y1));
  let minX = Infinity;
  let minY = Infinity;
  for (const u of units) {
    const n = g.node(u.key);
    minX = Math.min(minX, n.x - n.width / 2);
    minY = Math.min(minY, n.y - n.height / 2);
  }

  // free text written next to an arrow (a hand-made arrow label) follows that
  // arrow: remember its offset from the arrow's midpoint
  const midOf = (a: ExcalidrawElement) => {
    const [p1, p2] = ends(a);
    return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  };
  const distToSegment = (
    px: number,
    py: number,
    a: { x: number; y: number },
    b: { x: number; y: number },
  ) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const t = Math.max(
      0,
      Math.min(
        1,
        ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1),
      ),
    );
    return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
  };
  const arrowLabels: {
    text: ExcalidrawElement;
    arrow: string;
    ox: number;
    oy: number;
  }[] = [];
  for (const t of live) {
    if (t.type !== "text" || t.containerId || unitOfElement.has(t.id)) {
      continue;
    }
    const tx = t.x + t.width / 2;
    const ty = t.y + t.height / 2;
    let best: { a: ExcalidrawElement; d: number } | undefined;
    for (const a of live) {
      if (a.type !== "arrow" || !crossUnitArrows.has(a.id)) {
        continue;
      }
      const [p1, p2] = ends(a);
      const d = distToSegment(tx, ty, p1, p2);
      if (d < 50 && (!best || d < best.d)) {
        best = { a, d };
      }
    }
    if (best) {
      const m = midOf(best.a);
      arrowLabels.push({
        text: t,
        arrow: best.a.id,
        ox: t.x - m.x,
        oy: t.y - m.y,
      });
    }
  }

  const scene = new Scene(copies);
  const moved: ExcalidrawElement[] = [];
  let movedComponents = 0;
  for (const u of units) {
    const n = g.node(u.key);
    const dx = ox + (n.x - n.width / 2 - minX) - u.x1;
    const dy = oy + (n.y - n.height / 2 - minY) - u.y1;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      continue;
    }
    movedComponents++;
    for (const p of members.get(u) ?? []) {
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
    // prefer the sides along the layout's flow direction
    const preferHorizontal =
      rankdir === "LR"
        ? Math.abs(dx) * 1.5 >= Math.abs(dy)
        : Math.abs(dx) >= Math.abs(dy) * 1.5;
    if (preferHorizontal) {
      return dx >= 0 ? "right" : "left";
    }
    return dy >= 0 ? "bottom" : "top";
  };
  for (const id of crossUnitArrows) {
    // arrows inside a container keep their route: both ends moved together
    const arrow = byId.get(id);
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

  const arrowsById = new Map(copies.map((el) => [el.id, el]));
  for (const { text, arrow, ox, oy } of arrowLabels) {
    const a = arrowsById.get(arrow);
    if (a) {
      const m = midOf(a);
      scene.mutateElement(text, { x: m.x + ox, y: m.y + oy });
    }
  }

  return {
    elements: scene.getElementsIncludingDeleted(),
    moved: movedComponents,
  };
};
