import { useEffect, useMemo, useState } from "react";

import {
  createDrawing,
  deleteDrawing,
  listDrawings,
  slugify,
} from "../data/drawings";

import type { DrawingMeta } from "../data/drawings";

const timeAgo = (ms: number) => {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) {
    return "just now";
  }
  for (const [unit, secs] of [
    ["year", 31536000],
    ["month", 2592000],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ] as const) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${unit}${n > 1 ? "s" : ""} ago`;
    }
  }
  return "";
};

const openBoard = (id: string) => window.location.assign(`/d/${id}`);

export const Dashboard = () => {
  const [boards, setBoards] = useState<DrawingMeta[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState<string | null>(null);

  useEffect(() => {
    document.title = "Boards · Draw";
    listDrawings()
      .then((list) => setBoards(list.sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((e) => setError(e.message));
  }, []);

  // N: new board, /: search (VS Code-ish muscle memory)
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).tagName === "INPUT") {
        return;
      }
      if (event.key === "n") {
        event.preventDefault();
        setNewName("");
      } else if (event.key === "/") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".dash__search")?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const filtered = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (boards ?? []).filter((b) =>
      tokens.every((t) => b.name.toLowerCase().includes(t)),
    );
  }, [boards, query]);

  const create = async () => {
    const name = newName?.trim() ?? "";
    if (!slugify(name)) {
      return;
    }
    try {
      openBoard(await createDrawing(name));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (board: DrawingMeta) => {
    if (!window.confirm(`Delete "${board.name}"? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteDrawing(board.id);
      setBoards((list) => list && list.filter((b) => b.id !== board.id));
    } catch (e: any) {
      setError(e.message);
    }
  };

  return (
    <div className="dash">
      <header className="dash__header">
        <div className="dash__brand">Draw</div>
        <input
          className="dash__search"
          placeholder="Search boards   /"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) {
              openBoard(filtered[0].id);
            } else if (e.key === "Escape") {
              e.currentTarget.blur();
            }
          }}
        />
        <a className="dash__logout" href="/logout">
          Log out
        </a>
      </header>

      <main className="dash__main">
        <div className="dash__titlebar">
          <h1>Boards</h1>
          <button className="dash__primary" onClick={() => setNewName("")}>
            + New board <kbd>N</kbd>
          </button>
        </div>

        {newName !== null && (
          <form
            className="dash__new"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <input
              autoFocus
              placeholder="Board name, e.g. drip hld"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setNewName(null)}
            />
            <button className="dash__primary" type="submit">
              Create
            </button>
            <button type="button" onClick={() => setNewName(null)}>
              Cancel
            </button>
          </form>
        )}

        {error && <div className="dash__error">{error}</div>}
        {boards === null && !error && (
          <div className="dash__hint">Loading…</div>
        )}
        {boards?.length === 0 && (
          <div className="dash__hint">
            No boards yet. Create your first one.
          </div>
        )}

        <div className="dash__grid">
          {filtered.map((b) => (
            <a key={b.id} className="dash__card" href={`/d/${b.id}`}>
              <div className="dash__thumb" aria-hidden="true">
                {b.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="dash__meta">
                <div className="dash__name">{b.name}</div>
                <div className="dash__time">{timeAgo(b.updatedAt)}</div>
              </div>
              <button
                className="dash__delete"
                title="Delete board"
                onClick={(e) => {
                  e.preventDefault();
                  remove(b);
                }}
              >
                ×
              </button>
            </a>
          ))}
        </div>
      </main>
    </div>
  );
};
