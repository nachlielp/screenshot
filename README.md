# Screenshot

Screenshot is a Chrome extension plus a small React app for capturing screenshots, storing them in Convex, and sharing them with public links.

## What is in this repo

- `packages/extension/`: the Chrome extension used to capture, upload, and manage snapshots
- `packages/web/`: the viewer and library UI built with React + Vite
- `convex/`: the backend schema, auth config, queries, mutations, and cleanup cron

## Current feature set

- Capture screenshots (tab, full page, delayed, screen/window)
- Record tab or screen videos with mic narration, then scrub the recording, snap frames, and annotate them as a slideshow
- Vector annotations (rectangle, arrow, line, pen, text) that stay selectable, movable, and editable — including after upload
- Upload media to Convex storage
- Sign in with Clerk from the extension
- Open a personal library in the web app (search, grouping, multi-select delete)
- Share captures with token-based public URLs
- Store optional HTML, console logs, and network logs alongside a capture
- Clean up shared logs: shift-select console/network entries and hide them (reversible)
- Let owners rename captures and save marked viewer annotations
- Automatically remove expired captures after 30 days
- Agent-friendly JSON API: every snapshot is fetchable as machine-readable JSON (see below)

## Agent access (JSON API)

Every shared snapshot is also available as plain JSON so an AI agent (or any script) can read the image, console logs, network logs, and metadata without opening the viewer UI. The API lives on the **same domain as the app** — a Vercel rewrite (`packages/web/vercel.json`) proxies `/api/*` to the Convex HTTP action on `.convex.site`, so there's no separate api subdomain or DNS setup. Access is gated by the same unguessable share token as the viewer link — no auth needed.

```
GET https://<app>/api/snapshot/<shareToken>
```

Returns one JSON document with:

- `media.url` — direct URL to the image or video file
- `console` / `network` — the log entries inlined (entries the owner hid via cleanup are filtered out; each entry keeps its original `index`)
- `device`, `sourceUrl`, `capturedAt`, `annotations`, `markedHighlights` — capture metadata
- `htmlUrl` — the captured page HTML, when stored

Sub-resources for fetching pieces individually:

```
GET /api/snapshot/<shareToken>/console   # console log array only
GET /api/snapshot/<shareToken>/network   # network log array only
GET /api/snapshot/<shareToken>/image     # 302 redirect to the raw image/video
GET /api/snapshot/<shareToken>/html      # 302 redirect to the captured HTML
```

There is only one link to share: the viewer link (`https://<app>/#/snapshot/<shareToken>`). Agents derive the API URL from it:

- Same origin, drop the `#`: take the last path segment (the share token) and GET `/api/snapshot/<token>` on the link's own domain.
- Agents can self-discover: fetching the share link returns the SPA's `index.html`, which contains a `<meta name="snapshot-agent-api">` tag describing the endpoint.
- The `snapshot-debug` skill in `.claude/skills/` does this automatically — paste the viewer link and it fetches everything.

Example agent prompt: "Fetch this QA snapshot and diagnose the bug: `https://<app>/#/snapshot/<token>` — take the token and GET `https://<app>/api/snapshot/<token>` for the screenshot URL, console errors, and failed network requests."

## Quick start

### 1. Install dependencies

```bash
pnpm install
```

### 2. Start Convex

```bash
npx convex dev
```

This links or creates a Convex project and generates `convex/_generated/`.

### 3. Configure Clerk and Convex

Update these files with your real values:

- `packages/extension/utils/auth.js`
- `packages/extension/utils/convex-client.js`
- `packages/web/.env.local`

Set the Clerk issuer in Convex:

```bash
npx convex env set CLERK_ISSUER https://your-instance.clerk.accounts.dev
```

`convex/auth.config.js` also accepts `CLERK_JWT_ISSUER_DOMAIN`, but `CLERK_ISSUER` is the clearest option.

### 4. Run the web app

```bash
pnpm dev
```

Available scripts:

- `pnpm dev`: runs Convex and the web app together
- `pnpm dev:web`: runs the Vite app
- `pnpm dev:convex`: runs Convex only
- `pnpm build:web`: builds the web app

### 5. Load the extension

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `packages/extension`
5. Add `chrome-extension://<YOUR_EXTENSION_ID>` to Clerk allowed origins

## Important config files

### Extension

- `packages/extension/utils/auth.js`: Clerk publishable key and Clerk domain settings
- `packages/extension/utils/convex-client.js`: Convex deployment URL
- `packages/extension/manifest.json`: Chrome permissions and allowed hosts

### Web app

Create `packages/web/.env.local`:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_CONVEX_URL=https://your-deployment.convex.cloud
```

## Notes

- The extension auth flow currently opens the Clerk hosted sign-in page and then relies on `Sync Session` in the popup.
- Shared snapshot pages are served by the React app using hash routes.
- Capture records are deleted by a Convex cron once they pass the 30-day retention window.

## Docs

- `packages/extension/QUICKSTART.md`: shortest setup checklist
- `packages/extension/SETUP_GUIDE.md`: full extension + backend setup
- `packages/extension/CLERK_SETUP.md`: Clerk-specific setup notes
- `convex/README.md`: backend schema and function overview
