# Screenshot

Screenshot is a Chrome extension plus a small React app for capturing screenshots, storing them in Convex, and sharing them with public links.

## What is in this repo

- `packages/extension/`: the Chrome extension used to capture, upload, and manage snapshots
- `packages/web/`: the viewer and library UI built with React + Vite
- `convex/`: the backend schema, auth config, queries, mutations, and cleanup cron

## Current feature set

- Capture screenshots
- Upload media to Convex storage
- Sign in with Clerk from the extension
- Open a personal library in the web app
- Share captures with token-based public URLs
- Store optional HTML, console logs, and network logs alongside a capture
- Let owners rename captures and save marked viewer annotations
- Automatically remove expired captures after 30 days

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
