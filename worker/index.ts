// API for drawings, backed by Workers KV. Static app is served by the assets
// binding (see wrangler.jsonc); only /api/* reaches this worker.
//
// ponytail: KV is eventually consistent across regions (~60s) -> fine for one
// user. Move to R2/D1 if read-after-write globally ever matters.
// Auth: none here on purpose, protect the hostname with Cloudflare Access.

interface Env {
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
  },
};
