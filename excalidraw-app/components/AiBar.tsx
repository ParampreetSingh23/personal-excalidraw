import { useState } from "react";

export const AiBar = (props: {
  onSubmit: (prompt: string) => Promise<string>;
  onClose: () => void;
}) => {
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const submit = async () => {
    const text = prompt.trim();
    if (!text || busy) {
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const summary = await props.onSubmit(text);
      setResult({ ok: true, text: summary });
      setPrompt("");
    } catch (e: any) {
      setResult({ ok: false, text: e?.message || String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-bar">
      {result && (
        <div className={`ai-bar__result ${result.ok ? "" : "is-error"}`}>
          {result.text}
          {result.ok && <span className="ai-bar__hint"> · ⌘Z to undo</span>}
        </div>
      )}
      <form
        className="ai-bar__form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="ai-bar__badge">AI</span>
        <input
          autoFocus
          disabled={busy}
          value={prompt}
          placeholder={
            busy
              ? "Thinking…"
              : 'e.g. "client, server and AI gateway design" or "add a load balancer"'
          }
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              props.onClose();
            }
          }}
        />
        {busy ? (
          <span className="ai-bar__spinner" aria-label="Thinking" />
        ) : (
          <button type="submit" disabled={!prompt.trim()}>
            Send ↵
          </button>
        )}
        <button
          type="button"
          className="ai-bar__close"
          title="Close (Esc)"
          onClick={props.onClose}
        >
          ×
        </button>
      </form>
    </div>
  );
};
