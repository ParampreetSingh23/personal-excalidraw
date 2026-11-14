import { FONT_FAMILY, ROUNDNESS, randomId } from "@excalidraw/common";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";

/**
 * One-click HLD building blocks. Each `build` returns skeletons centered on
 * (cx, cy); everything in one component shares a group so it moves together.
 */
export type HLDComponent = {
  key: string; // Alt + this key inserts it (event.code `Key${key}`)
  label: string;
  color: { bg: string; stroke: string };
  build: (cx: number, cy: number) => ExcalidrawElementSkeleton[];
};

const FONT = FONT_FAMILY.Nunito;

const base = (stroke: string, bg: string) => ({
  strokeColor: stroke,
  backgroundColor: bg,
  fillStyle: "solid" as const,
  strokeWidth: 1,
  roughness: 0,
});

type BoxOpts = {
  text: string;
  w?: number;
  h?: number;
  shape?: "rectangle" | "ellipse" | "diamond";
  dashed?: boolean;
  top?: boolean; // label at top (for regions)
};

const box =
  (color: HLDComponent["color"], o: BoxOpts) =>
  (cx: number, cy: number): ExcalidrawElementSkeleton[] => {
    const w = o.w ?? 160;
    const h = o.h ?? 72;
    const shape = o.shape ?? "rectangle";
    return [
      {
        type: shape,
        x: cx - w / 2,
        y: cy - h / 2,
        width: w,
        height: h,
        ...base(color.stroke, color.bg),
        strokeStyle: o.dashed ? "dashed" : "solid",
        roundness:
          shape === "rectangle" ? { type: ROUNDNESS.ADAPTIVE_RADIUS } : null,
        label: {
          text: o.text,
          fontSize: 16,
          fontFamily: FONT,
          verticalAlign: o.top ? "top" : "middle",
        },
      },
    ];
  };

/** half-ellipse points from angle 0..π, used for the cylinder outline */
const arc = (
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fromLeft: boolean,
): [number, number][] =>
  Array.from({ length: 13 }, (_, i) => {
    const t = (Math.PI * i) / 12;
    return [cx + (fromLeft ? -1 : 1) * rx * Math.cos(t), cy + ry * Math.sin(t)];
  });

const cylinder =
  (color: HLDComponent["color"], text: string) =>
  (cx: number, cy: number): ExcalidrawElementSkeleton[] => {
    const w = 130;
    const h = 100;
    const ry = 12;
    const x = cx - w / 2;
    const y = cy - h / 2;
    const groupIds = [randomId()];
    // body outline: down the left side, along the bottom curve, up the right
    // side, back along the lower half of the top ellipse (closed -> filled)
    const points: [number, number][] = [
      [0, ry],
      ...arc(w / 2, h - ry, w / 2, ry, true),
      ...arc(w / 2, ry, w / 2, ry, false),
    ];
    return [
      {
        type: "line",
        x,
        y,
        width: w,
        height: h,
        points: points as any,
        polygon: true,
        roundness: null,
        groupIds,
        ...base(color.stroke, color.bg),
      } as ExcalidrawElementSkeleton,
      {
        type: "ellipse",
        x,
        y,
        width: w,
        height: ry * 2,
        groupIds,
        ...base(color.stroke, color.bg),
      },
      {
        // invisible label holder over the body, also the arrow target
        type: "rectangle",
        x,
        y: y + ry * 2,
        width: w,
        height: h - ry * 3,
        groupIds,
        ...base("transparent", "transparent"),
        label: {
          text,
          fontSize: 16,
          fontFamily: FONT,
          strokeColor: color.stroke,
        },
      },
    ];
  };

const queue =
  (color: HLDComponent["color"], text: string) =>
  (cx: number, cy: number): ExcalidrawElementSkeleton[] => {
    const w = 200;
    const h = 64;
    const x = cx - w / 2;
    const y = cy - h / 2;
    const groupIds = [randomId()];
    const slots = [0.68, 0.76, 0.84, 0.92].map(
      (f): ExcalidrawElementSkeleton => ({
        type: "line",
        x: x + w * f,
        y: y + 10,
        width: 0.01, // 0 would fall back to the default line width
        height: h - 20,
        points: [
          [0, 0],
          [0, h - 20],
        ] as any,
        groupIds,
        ...base(color.stroke, "transparent"),
      }),
    );
    return [
      {
        type: "rectangle",
        x,
        y,
        width: w,
        height: h,
        groupIds,
        roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
        ...base(color.stroke, color.bg),
        label: {
          text,
          fontSize: 16,
          fontFamily: FONT,
          textAlign: "left",
        },
      },
      ...slots,
    ];
  };

const user =
  (color: HLDComponent["color"]) =>
  (cx: number, cy: number): ExcalidrawElementSkeleton[] => {
    const groupIds = [randomId()];
    return [
      {
        type: "ellipse",
        x: cx - 14,
        y: cy - 44,
        width: 28,
        height: 28,
        groupIds,
        ...base(color.stroke, color.bg),
      },
      {
        type: "rectangle",
        x: cx - 26,
        y: cy - 12,
        width: 52,
        height: 30,
        groupIds,
        roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
        ...base(color.stroke, color.bg),
      },
      {
        type: "text",
        x: cx - 18,
        y: cy + 24,
        text: "User",
        fontSize: 16,
        fontFamily: FONT,
        groupIds,
        strokeColor: color.stroke,
      },
    ];
  };

const C = {
  blue: { bg: "#e8f0fe", stroke: "#2f5fd0" },
  slate: { bg: "#f1f3f5", stroke: "#495057" },
  violet: { bg: "#f1e9ff", stroke: "#6d3fd6" },
  amber: { bg: "#fff3e0", stroke: "#c2610c" },
  green: { bg: "#e6f6ee", stroke: "#0f8a5f" },
  red: { bg: "#fdecec", stroke: "#c92a2a" },
  yellow: { bg: "#fff8db", stroke: "#a66a00" },
  cyan: { bg: "#e3f8fb", stroke: "#0b7f95" },
  sky: { bg: "#e7f5ff", stroke: "#1971c2" },
  k8s: { bg: "#f8faff", stroke: "#326ce5" },
  gray: { bg: "#ffffff", stroke: "#868e96" },
  note: { bg: "#fff3a6", stroke: "#1e1e1e" },
};

export const HLD_COMPONENTS: HLDComponent[] = [
  { key: "U", label: "User", color: C.blue, build: user(C.blue) },
  {
    key: "C",
    label: "Client",
    color: C.blue,
    build: box(C.blue, { text: "Web Client" }),
  },
  {
    key: "M",
    label: "Mobile app",
    color: C.blue,
    build: box(C.blue, { text: "Mobile", w: 80, h: 130 }),
  },
  {
    key: "E",
    label: "CDN",
    color: C.cyan,
    build: box(C.cyan, { text: "CDN", shape: "ellipse", w: 130, h: 70 }),
  },
  {
    key: "H",
    label: "DNS",
    color: C.cyan,
    build: box(C.cyan, { text: "DNS", shape: "ellipse", w: 110, h: 60 }),
  },
  {
    key: "L",
    label: "Load balancer",
    color: C.violet,
    build: box(C.violet, { text: "Load Balancer", w: 180 }),
  },
  {
    key: "G",
    label: "API gateway",
    color: C.amber,
    build: box(C.amber, { text: "API Gateway", w: 180 }),
  },
  {
    key: "S",
    label: "Server",
    color: C.slate,
    build: box(C.slate, { text: "Server" }),
  },
  {
    key: "V",
    label: "Service",
    color: C.slate,
    build: box(C.slate, { text: "Service" }),
  },
  {
    key: "W",
    label: "Worker",
    color: C.slate,
    build: box(C.slate, { text: "Worker", dashed: true }),
  },
  {
    key: "D",
    label: "Database",
    color: C.green,
    build: cylinder(C.green, "Database"),
  },
  {
    key: "R",
    label: "Cache",
    color: C.red,
    build: box(C.red, { text: "Cache (Redis)" }),
  },
  {
    key: "Q",
    label: "Queue",
    color: C.yellow,
    build: queue(C.yellow, "Queue"),
  },
  {
    key: "O",
    label: "Object storage",
    color: C.green,
    build: box(C.green, { text: "Object Storage", w: 170 }),
  },
  {
    key: "B",
    label: "Docker container",
    color: C.sky,
    build: box(C.sky, {
      text: "Container",
      w: 220,
      h: 130,
      dashed: true,
      top: true,
    }),
  },
  {
    key: "K",
    label: "K8s cluster / VPC",
    color: C.k8s,
    build: box(C.k8s, {
      text: "Cluster",
      w: 420,
      h: 260,
      dashed: true,
      top: true,
    }),
  },
  {
    key: "X",
    label: "External API",
    color: C.gray,
    build: box(C.gray, { text: "External API", dashed: true }),
  },
  {
    key: "N",
    label: "Note",
    color: C.note,
    build: (cx, cy) => [
      {
        type: "stickynote",
        x: cx - 90,
        y: cy - 90,
        width: 180,
        height: 180,
        backgroundColor: C.note.bg,
        strokeColor: C.note.stroke,
        roughness: 0,
        label: { text: "Note", fontSize: 20, fontFamily: FONT },
      },
    ],
  },
];
