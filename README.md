# draw

Personal, minimal Excalidraw. Every drawing is its own file (`/d/<name>`), stored in Cloudflare Workers KV. Hosted at `draw.parampreetsingh.dev`.

- `/` = boards dashboard (search `/`, new board `N`, from Mermaid `M`), `/d/<name>` = board
- Rename boards from the dashboard card or the editor menu (URL stays the same)
- Mermaid → editable shapes: dashboard "From Mermaid", or paste Mermaid code onto any canvas
- Password login (`/login`), 30-day session cookie
- Right panel: one-click HLD components (User, Client, LB, Gateway, Server,
  DB, Cache, Queue, Container, K8s, Note …), each on **Alt+letter**; Alt+1 toggles panel
- **Ctrl/Cmd+P** inside a board: fuzzy-open / create another board
- Autosave (1s debounce), top-left chip shows `saved / saving… / not saved!`
- Mermaid → diagram stays (menu → TTD). No collab, share links, AI, telemetry.

## Dev

```bash
yarn
yarn dev:api   # worker + local KV on :8787 (terminal 1)
yarn start     # vite on :3001, proxies /api to :8787 (terminal 2)
```

## Deploy (one-time)

1. `npx wrangler login`
2. `npx wrangler kv namespace create DRAWINGS` → paste the `id` into `wrangler.jsonc`
3. `yarn deploy` (needs `parampreetsingh.dev` zone on this Cloudflare account; the custom domain + cert are created automatically)
4. **Protect it**: Zero Trust → Access → Applications → Self-hosted → `draw.parampreetsingh.dev`, policy = allow only your email. The API has no auth of its own; `workers_dev` is off so Access cannot be bypassed.

## Layout

- `excalidraw-app/` – the UI (`App.tsx`, `components/DrawingSwitcher.tsx`, `data/drawings.ts`)
- `worker/index.ts` – `/api/drawings` CRUD on KV; static files via assets binding
- `packages/` – upstream editor library, untouched
