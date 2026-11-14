import { Sidebar } from "@excalidraw/excalidraw";

import { HLD_COMPONENTS } from "../data/components";

import type { HLDComponent } from "../data/components";

export const COMPONENTS_SIDEBAR = "components";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
export const ALT = isMac ? "⌥" : "Alt+";

export const ComponentsPanel = (props: {
  docked: boolean;
  onDock: (docked: boolean) => void;
  onInsert: (component: HLDComponent) => void;
}) => (
  <Sidebar
    name={COMPONENTS_SIDEBAR}
    docked={props.docked}
    onDock={props.onDock}
    className="components-panel"
  >
    <Sidebar.Header>
      <div className="components-panel__title">Components</div>
    </Sidebar.Header>
    <div className="components-panel__list">
      {HLD_COMPONENTS.map((c) => (
        <button
          key={c.key}
          className="components-panel__item"
          onClick={() => props.onInsert(c)}
          title={`Insert ${c.label} (${ALT}${c.key})`}
        >
          <span
            className="components-panel__swatch"
            style={{ background: c.color.bg, borderColor: c.color.stroke }}
          />
          <span className="components-panel__label">{c.label}</span>
          <kbd>
            {ALT}
            {c.key}
          </kbd>
        </button>
      ))}
    </div>
    <div className="components-panel__footer">
      {ALT}1 panel · {ALT}I AI · Ctrl/Cmd+P boards
    </div>
  </Sidebar>
);
