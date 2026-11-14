// API for drawings (Workers KV) + password login. Static app is served by the
// assets binding (see wrangler.jsonc); only /api/*, /login, /logout reach this
// worker. The app shell is public (it's open-source code), all data is behind
// the session cookie.
//
// ponytail: KV is eventually consistent across regions (~60s) -> fine for one
// user. Move to R2/D1 if read-after-write globally ever matters.

interface Env {
  /** set with `npx wrangler secret put APP_PASSWORD` (local: .dev.vars) */
  APP_PASSWORD?: string;
  DRAWINGS: {
    get(key: string, type: "stream"): Promise<ReadableStream | null>;
    put(
      key: string,
      value: string,
      opts: { metadata: { name: string; updatedAt: number } },
    ): Promise<void>;
    delete(key: string): Promise<void>;
    list(opts: { prefix: string; cursor?: string }): Promise<{
      keys: { name: string; metadata?: { name: string; updatedAt: number } }[];
      list_complete: boolean;
      cursor?: string;
    }>;
  };
}

const PREFIX = "d:";
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
const MAX_BYTES = 24 * 1024 * 1024; // KV value limit is 25 MiB
const SESSION_DAYS = 30;
const COOKIE = "session";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

// ---------------------------------------------------------------------------
// auth: cookie = "<expiresAt>.<hex hmac(expiresAt)>", keyed by APP_PASSWORD,
// so changing the password logs out every session.
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const hmac = async (secret: string, data: string) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(data)),
  );
};

const toHex = (bytes: Uint8Array) =>
  [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

const safeEqual = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length &&
  (crypto.subtle as any).timingSafeEqual(a, b) === true;

const isAuthed = async (request: Request, env: Env) => {
  if (!env.APP_PASSWORD) {
    return false; // fail closed
  }
  const cookie = request.headers.get("cookie") ?? "";
  const value = cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]+)`))?.[1];
  const [expires, sig] = value?.split(".") ?? [];
  if (!expires || !sig || Number(expires) < Date.now()) {
    return false;
  }
  const expected = toHex(await hmac(env.APP_PASSWORD, expires));
  return safeEqual(encoder.encode(expected), encoder.encode(sig));
};

const loginPage = (error = "") =>
  new Response(
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Sign in · Draw</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--text:#1f2328;--muted:#6b7280;--border:#e5e7eb;--accent:#4f46e5}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1c1d21;--text:#e8e8ea;--muted:#9a9ca3;--border:#2c2e33;--accent:#7c78ff}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
form{width:100%;max-width:340px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 20px;color:var(--muted)}
input{width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:transparent;color:inherit;font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:-1px;border-color:transparent}
button{width:100%;margin-top:12px;padding:10px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.err{color:#dc2626;margin:10px 0 0;font-size:14px}
</style></head><body>
<form method="post" action="/login">
<h1>Draw</h1><p>Sign in to see your boards.</p>
<input type="password" name="password" placeholder="Password" autofocus required autocomplete="current-password">
<button type="submit">Sign in</button>
${error ? `<div class="err">${error}</div>` : ""}
</form></body></html>`,
    {
      status: error ? 401 : 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );

const handleLogin = async (request: Request, env: Env) => {
  if (request.method !== "POST") {
    return loginPage();
  }
  if (!env.APP_PASSWORD) {
    return loginPage("Server not configured: APP_PASSWORD secret is missing.");
  }
  const form = await request.formData();
  const password = String(form.get("password") ?? "");
  // compare fixed-length digests so length doesn't leak
  const ok = safeEqual(
    await hmac("login", password),
    await hmac("login", env.APP_PASSWORD),
  );
  if (!ok) {
    // ponytail: fixed delay only slows serial guessing; add a Cloudflare rate
    // limiting rule on /login if this ever faces real attacks
    await new Promise((r) => setTimeout(r, 1000));
    return loginPage("Wrong password.");
  }
  const expires = String(Date.now() + SESSION_DAYS * 864e5);
  const sig = toHex(await hmac(env.APP_PASSWORD, expires));
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: "/",
      "set-cookie": `${COOKIE}=${expires}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${
        SESSION_DAYS * 86400
      }${secure}`,
    },
  });
};

// ---------------------------------------------------------------------------
// drawings API
// ---------------------------------------------------------------------------

const handleApi = async (request: Request, env: Env, url: URL) => {
  const match = url.pathname.match(/^\/api\/drawings(?:\/([^/]+))?\/?$/);
  if (!match) {
    return json({ error: "not found" }, 404);
  }
  const id = match[1];

  if (!id) {
    if (request.method !== "GET") {
      return json({ error: "method not allowed" }, 405);
    }
    const drawings = [];
    let cursor: string | undefined;
    do {
      const page = await env.DRAWINGS.list({ prefix: PREFIX, cursor });
      for (const key of page.keys) {
        drawings.push({
          id: key.name.slice(PREFIX.length),
          name: key.metadata?.name ?? key.name.slice(PREFIX.length),
          updatedAt: key.metadata?.updatedAt ?? 0,
        });
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return json(drawings);
  }

  if (!ID_RE.test(id)) {
    return json({ error: "invalid id" }, 400);
  }
  const key = PREFIX + id;

  switch (request.method) {
    case "GET": {
      const body = await env.DRAWINGS.get(key, "stream");
      return body
        ? new Response(body, {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
          })
        : json({ error: "not found" }, 404);
    }
    case "PUT": {
      const text = await request.text();
      if (text.length > MAX_BYTES) {
        return json({ error: "too large" }, 413);
      }
      let name: unknown;
      try {
        name = JSON.parse(text).name;
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      await env.DRAWINGS.put(key, text, {
        metadata: {
          // KV metadata is capped at 1KB
          name: (typeof name === "string" && name ? name : id).slice(0, 100),
          updatedAt: Date.now(),
        },
      });
      return json({ ok: true });
    }
    case "DELETE":
      await env.DRAWINGS.delete(key);
      return json({ ok: true });
    default:
      return json({ error: "method not allowed" }, 405);
  }
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/login") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/logout") {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/login",
          "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        },
      });
    }
    if (!(await isAuthed(request, env))) {
      return json({ error: "unauthorized" }, 401);
    }
    return handleApi(request, env, url);
  },
};
