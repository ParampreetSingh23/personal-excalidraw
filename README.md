# draw

Personal, minimal Excalidraw. Every drawing is its own file (`/d/<name>`), stored in Cloudflare Workers KV. Hosted at `draw.parampreetsingh.dev`.

- **Ctrl/Cmd+P**: fuzzy-open a drawing, or type a new name + Enter to create one
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
