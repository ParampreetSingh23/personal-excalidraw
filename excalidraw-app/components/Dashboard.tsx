import { useEffect, useMemo, useState } from "react";

import {
  createDrawing,
  deleteDrawing,
  listDrawings,
  renameDrawing,
  slugify,
  thumbnailUrl,
} from "../data/drawings";
import { parseMermaid, setPendingMermaid } from "../data/mermaid";

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

/** saved preview, or the first letter until (or unless) it has loaded */
const Thumb = ({ board }: { board: DrawingMeta }) => {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="dash__thumb" aria-hidden="true">
      {!loaded && board.name.slice(0, 1).toUpperCase()}
      <img
        alt=""
        loading="lazy"
        src={thumbnailUrl(board.id, board.updatedAt)}
        // not display:none: lazy images that aren't rendered never load
        style={
          loaded
            ? undefined
            : { position: "absolute", width: 1, height: 1, opacity: 0 }
        }
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
};

const openBoard = (id: string) => window.location.assign(`/d/${id}`);

const MERMAID_PLACEHOLDER = `flowchart LR
  User --> CDN --> LB[Load Balancer]
  LB --> API[API Server]
  API --> Cache[(Redis)]
  API --> DB[(Postgres)]`;

const MermaidDialog = (props: { onClose: () => void }) => {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!slugify(name)) {
      setError("Give the board a name.");
      return;
    }
    if (!code.trim()) {
      setError("Paste some Mermaid code.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await parseMermaid(code); // validate here, so errors show next to the code
      const id = await createDrawing(name.trim());
      setPendingMermaid(id, code);
      openBoard(id);
    } catch (e: any) {
      setError(e?.message || String(e));
      setBusy(false);
    }
  };

  return (
    <div className="dash__modal-backdrop" onMouseDown={props.onClose}>
      <form
        className="dash__modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            props.onClose();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            submit();
          }
        }}
      >
        <h2>New board from Mermaid</h2>
        <input
          autoFocus
          placeholder="Board name, e.g. checkout flow"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <textarea
          spellCheck={false}
          placeholder={MERMAID_PLACEHOLDER}
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <p className="dash__muted">
          Flowchart, sequence, class, ER, state… It becomes normal, editable
          shapes. If a board with this name exists, the diagram is added to it.
        </p>
        {error && (
          <div className="dash__error dash__error--inline">{error}</div>
        )}
        <div className="dash__modal-actions">
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
          <button className="dash__primary" type="submit" disabled={busy}>
            {busy ? "Converting…" : "Create board"} <kbd>⌘↵</kbd>
          </button>
        </div>
      </form>
    </div>
  );
};

export const Dashboard = () => {
  const [boards, setBoards] = useState<DrawingMeta[] | null>(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState<string | null>(null);
  const [mermaidOpen, setMermaidOpen] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(
    null,
  );

  useEffect(() => {
    document.title = "Boards · Draw";
    listDrawings()
      .then((list) => setBoards(list.sort((a, b) => b.updatedAt - a.updatedAt)))
      .catch((e) => setError(e.message));
  }, []);

  // N: new board, M: from Mermaid, /: search
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement).tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }
      if (event.key === "n") {
        event.preventDefault();
        setNewName("");
      } else if (event.key === "m") {
        event.preventDefault();
        setMermaidOpen(true);
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

  const commitRename = async () => {
    if (!renaming) {
      return;
    }
    const { id } = renaming;
    const name = renaming.name.trim();
    setRenaming(null);
    const old = boards?.find((b) => b.id === id);
    if (!name || !old || name === old.name) {
      return;
    }
    setBoards(
      (list) =>
        list &&
        list.map((b) =>
          b.id === id ? { ...b, name, updatedAt: Date.now() } : b,
        ),
    );
    try {
      await renameDrawing(id, name);
    } catch (e: any) {
      setError(e.message);
      setBoards((list) => list && list.map((b) => (b.id === id ? old : b)));
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
          <div className="dash__actions">
            <button onClick={() => setMermaidOpen(true)}>
              From Mermaid <kbd>M</kbd>
            </button>
            <button className="dash__primary" onClick={() => setNewName("")}>
              + New board <kbd>N</kbd>
            </button>
          </div>
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
          {filtered.map((b) =>
            renaming?.id === b.id ? (
              <div key={b.id} className="dash__card is-editing">
                <div className="dash__thumb" aria-hidden="true">
                  {(renaming.name || b.name).slice(0, 1).toUpperCase()}
                </div>
                <div className="dash__meta">
                  <input
                    autoFocus
                    className="dash__rename"
                    value={renaming.name}
                    onChange={(e) =>
                      setRenaming({ id: b.id, name: e.target.value })
                    }
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur();
                      } else if (e.key === "Escape") {
                        setRenaming(null);
                      }
                    }}
                  />
                  <div className="dash__time">
                    Enter to save · Esc to cancel
                  </div>
                </div>
              </div>
            ) : (
              <a key={b.id} className="dash__card" href={`/d/${b.id}`}>
                <Thumb board={b} />
                <div className="dash__meta">
                  <div className="dash__name">{b.name}</div>
                  <div className="dash__time">{timeAgo(b.updatedAt)}</div>
                </div>
                <div className="dash__card-actions">
                  <button
                    title="Rename board"
                    onClick={(e) => {
                      e.preventDefault();
                      setRenaming({ id: b.id, name: b.name });
                    }}
                  >
                    Rename
                  </button>
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
                </div>
              </a>
            ),
          )}
        </div>
      </main>

      {mermaidOpen && <MermaidDialog onClose={() => setMermaidOpen(false)} />}
    </div>
  );
};
