# Current Implementation Summary

This file is a short snapshot of how the extension works today.

## Storage and backend

- Convex stores uploaded files and capture metadata
- Capture records live in the `screenshots` table
- User records live in the `users` table
- Records expire after 30 days
- A daily Convex cron deletes expired files and records

## Authentication

- Clerk is the auth provider
- The extension uses Clerk cookies plus a Convex JWT exchange
- The web app uses Clerk React
- Convex validates tokens with the issuer from `CLERK_ISSUER` or `CLERK_JWT_ISSUER_DOMAIN`

## Capture metadata

Each upload may include:

- screenshot or recording media
- HTML snapshot
- console logs
- network logs
- source URL
- browser, OS, viewport, and device information

## Viewer behavior

- Public snapshots are loaded by share token
- View counts are tracked with viewer tokens
- Owners can rename snapshots
- Owners can save marked-view annotations tied to console or network entries

## Useful files

- `packages/extension/utils/auth.js`
- `packages/extension/utils/convex-client.js`
- `convex/schema.ts`
- `convex/screenshots.ts`
- `packages/web/src/pages/Library.tsx`
- `packages/web/src/pages/SnapshotViewer.tsx`
