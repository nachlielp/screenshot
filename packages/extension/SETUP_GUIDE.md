# Extension Setup Guide

This guide matches the code currently in this repo.

## Architecture

- The extension captures screenshots and recordings
- Convex stores files and metadata
- Clerk handles authentication
- The React app in `packages/web` renders the library and public snapshot viewer

## 1. Install and initialize

```bash
pnpm install
npx convex dev
```

That will:

- create or link a Convex project
- generate files in `convex/_generated/`
- give you a deployment URL

## 2. Configure Clerk for the extension

Create a Clerk app and collect:

- publishable key
- Clerk frontend domain
- Clerk API domain / issuer domain

If you want to keep the current sign-in UX unchanged, enable Google in Clerk because the popup uses `Sign in with Google`.

Create a JWT template with application ID `convex`.

## 3. Update local config

### `packages/extension/utils/auth.js`

Replace the current development constants with your own Clerk values:

- `CLERK_PUBLISHABLE_KEY`
- `CLERK_DOMAIN`
- `CLERK_API_DOMAIN`
- `CLERK_COOKIE_DOMAINS`
- `CLERK_COOKIE_URLS`

These values must all point at the same Clerk instance.

### `packages/extension/utils/convex-client.js`

Set:

```js
const CONVEX_URL = "https://your-deployment.convex.cloud";
```

### `packages/web/.env.local`

Add:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
VITE_CONVEX_URL=https://your-deployment.convex.cloud
```

### Convex environment

Set the Clerk issuer used by `convex/auth.config.js`:

```bash
npx convex env set CLERK_ISSUER https://your-instance.clerk.accounts.dev
```

## 4. Load the extension in Chrome

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click `Load unpacked`
4. Select `packages/extension`
5. Copy the extension ID

In Clerk, add:

```text
chrome-extension://YOUR_EXTENSION_ID
```

to allowed origins.

## 5. Run the web app

```bash
pnpm dev
```

The app is used for:

- `/library`
- `/snapshot/:shareToken`

The router runs with hash routes, and old path-style links are migrated in `packages/web/src/main.tsx`.

## 6. Verify the full flow

1. Open the extension popup
2. Click `Sign in with Google`
3. Finish the Clerk flow in the opened tab
4. Return to the popup and click `Sync Session`
5. Capture a screenshot
6. Upload it
7. Open the generated snapshot URL
8. Confirm it appears in the library

## What gets stored

Each capture can include:

- the main image or video
- an optional HTML snapshot
- optional console logs
- optional network logs
- optional page and device metadata

Records expire after 30 days and are cleaned up daily by the Convex cron.

## Troubleshooting

### Sign-in succeeds but the extension still looks logged out

- The current extension flow depends on `Sync Session`
- Check that the Clerk domains in `utils/auth.js` are correct
- Confirm the extension origin is allowed in Clerk

### Convex says `Not authenticated`

- Verify the Clerk JWT template uses `convex`
- Verify `CLERK_ISSUER` matches your Clerk issuer domain
- Make sure you synced the session after signing in

### The web app fails to start

- Check `packages/web/.env.local`
- Confirm both `VITE_CLERK_PUBLISHABLE_KEY` and `VITE_CONVEX_URL` are set

### Uploads fail

- Confirm `CONVEX_URL` points at the same deployment you started with `npx convex dev`
- Check the extension background console and page console for fetch errors
