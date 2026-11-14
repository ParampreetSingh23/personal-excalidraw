import { useEffect, useState } from "react";

import {
  createShareToken,
  getShareToken,
  revokeShareToken,
  shareUrl,
} from "../data/drawings";

export const ShareDialog = (props: {
  boardId: string;
  onClose: () => void;
}) => {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getShareToken(props.boardId)
      .then(setToken)
      .catch((e) => setError(e.message));
  }, [props.boardId]);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError("");
    try {
      setToken(await fn());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!token) {
      return;
    }
    await navigator.clipboard.writeText(shareUrl(token));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="share-backdrop" onMouseDown={props.onClose}>
      <div
        className="share-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && props.onClose()}
      >
        <h2>Share read-only link</h2>
        <p>
          Anyone with the link can view this board, not edit it. Your other
          boards stay private. The link shows your latest saved version.
        </p>
        {token === undefined && !error && <p>Loading…</p>}
        {token === null && (
          <button
            className="share-dialog__primary"
            disabled={busy}
            onClick={() => run(() => createShareToken(props.boardId))}
          >
            Create link
          </button>
        )}
        {token && (
          <>
            <div className="share-dialog__row">
              <input
                readOnly
                value={shareUrl(token)}
                onFocus={(e) => e.currentTarget.select()}
              />
              <button className="share-dialog__primary" onClick={copy}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <button
              className="share-dialog__danger"
              disabled={busy}
              onClick={() => {
                if (
                  window.confirm(
                    "Stop sharing? The current link will stop working.",
                  )
                ) {
                  run(() => revokeShareToken(props.boardId));
                }
              }}
            >
              Stop sharing
            </button>
          </>
        )}
        {error && <p className="share-dialog__error">{error}</p>}
      </div>
    </div>
  );
};
