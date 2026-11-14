import { useEffect, useMemo, useRef, useState } from "react";

import { deleteDrawing, listDrawings, slugify } from "../data/drawings";

import type { DrawingMeta } from "../data/drawings";

export const DrawingSwitcher = (props: {
  currentId: string;
  onOpen: (id: string, name: string) => void;
  onClose: () => void;
}) => {
  const [drawings, setDrawings] = useState<DrawingMeta[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listDrawings()
      .then((list) =>
        setDrawings(list.sort((a, b) => b.updatedAt - a.updatedAt)),
      )
      .catch((e) => setError(e.message));
  }, []);

  const matches = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (drawings ?? []).filter((d) =>
      tokens.every((token) => d.name.toLowerCase().includes(token)),
    );
  }, [drawings, query]);

  const name = query.trim();
  const canCreate =
    !!slugify(name) && !(drawings ?? []).some((d) => d.id === slugify(name));
  const rowCount = matches.length + (canCreate ? 1 : 0);

  useEffect(() => setSelected(0), [query]);
  useEffect(() => {
    listRef.current?.children[selected]?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const choose = (index: number) => {
    // list still loading: Enter would wrongly create a duplicate
    if (drawings === null) {
      return;
    }
    const match = matches[index];
    if (match) {
      props.onOpen(match.id, match.name);
    } else if (canCreate) {
      props.onOpen(slugify(name), name);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      props.onClose();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setSelected((s) => (rowCount ? (s + step + rowCount) % rowCount : 0));
    } else if (event.key === "Enter") {
      choose(selected);
    }
  };

  const remove = async (drawing: DrawingMeta) => {
    if (!window.confirm(`Delete "${drawing.name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteDrawing(drawing.id);
      setDrawings((list) => list && list.filter((d) => d.id !== drawing.id));
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="drawing-switcher-backdrop" onMouseDown={props.onClose}>
      <div
        className="drawing-switcher"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          placeholder="Open or create a drawing…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="drawing-switcher__list" ref={listRef}>
          {matches.map((d, i) => (
            <div
              key={d.id}
              className={`drawing-switcher__row${
                i === selected ? " is-selected" : ""
              }`}
              onMouseMove={() => setSelected(i)}
              onClick={() => choose(i)}
            >
              <span>
                {d.name}
                {d.id === props.currentId && " (current)"}
              </span>
              {d.id !== props.currentId && (
                <button
                  title="Delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    remove(d);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {canCreate && (
            <div
              className={`drawing-switcher__row${
                selected === matches.length ? " is-selected" : ""
              }`}
              onMouseMove={() => setSelected(matches.length)}
              onClick={() => choose(matches.length)}
            >
              + Create “{name}”
            </div>
          )}
          {drawings === null && !error && (
            <div className="drawing-switcher__hint">Loading…</div>
          )}
          {error && <div className="drawing-switcher__hint">{error}</div>}
          {drawings?.length === 0 && !name && (
            <div className="drawing-switcher__hint">
              No drawings yet. Type a name to create one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
