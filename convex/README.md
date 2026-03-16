# Convex Backend

This folder contains the backend used by the extension and the React viewer.

## Files

- `schema.ts`: `users` and `screenshots` tables
- `screenshots.ts`: auth-aware mutations and queries for upload, listing, sharing, deleting, title edits, view tracking, and marked-view saves
- `auth.config.js`: Clerk issuer configuration
- `crons.ts`: daily cleanup for expired captures

## Auth

`auth.config.js` accepts either of these environment variables:

- `CLERK_ISSUER`
- `CLERK_JWT_ISSUER_DOMAIN`

If neither is set, it falls back to the current development Clerk domain in the file.

Recommended setup:

```bash
npx convex env set CLERK_ISSUER https://your-instance.clerk.accounts.dev
```

The Clerk JWT template should use `convex` as the application ID.

## Data model

### `users`

- `clerkId`
- `email`
- `name`
- `createdAt`

### `screenshots`

Stores the primary media file plus optional related artifacts:

- media metadata: `filename`, `title`, `mimeType`, `fileSize`, `type`
- storage URLs: `publicUrl`, optional `htmlPublicUrl`, `consoleLogsUrl`, `networkLogsUrl`
- ownership and sharing: `userId`, `shareToken`, `isPublic`
- capture details: dimensions, duration, source URL, device metadata, capture timestamp
- viewer state: `viewCount`, `viewerTokens`, `lastViewedAt`, `markedView`
- lifecycle: `createdAt`, `expiresAt`

## Main functions

- `generateUploadUrl`: creates a signed Convex storage upload URL
- `getOrCreateUser`: creates a local user record for a Clerk identity
- `uploadScreenshot`: stores the capture record and optional metadata files
- `getUserScreenshots`: returns the signed-in user's recent captures
- `getScreenshotByShareToken`: public read for the web viewer
- `getSnapshotViewerState`: returns the capture plus whether the current user can edit it
- `incrementViewCount`: counts distinct viewer tokens
- `updateScreenshotTitle`: owner-only title updates
- `saveMarkedView`: owner-only highlight/annotation persistence
- `deleteScreenshot` and `deleteScreenshots`: owner-only deletion
- `cleanupExpired`: internal cleanup used by the cron job

## Retention

- Captures expire after 30 days
- Cleanup runs daily at `02:00 UTC`
- Cleanup removes both storage objects and database records
