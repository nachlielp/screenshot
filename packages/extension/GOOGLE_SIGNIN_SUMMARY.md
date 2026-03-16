# Google Sign-In Summary

The extension currently assumes a Google-first auth flow.

## Current behavior

- The popup button is labeled `Sign in with Google`
- Clicking it opens the Clerk hosted sign-in page in a browser tab
- After sign-in, the user returns to the extension and clicks `Sync Session`
- The extension reads Clerk cookies and fetches a Convex token

## To keep this flow working

1. Enable Google in Clerk
2. Use the same Clerk instance in:
   - `packages/extension/utils/auth.js`
   - `packages/web/.env.local`
   - `convex/auth.config.js` via `CLERK_ISSUER`
3. Add the extension origin to Clerk
4. Create a JWT template with application ID `convex`

## If you want non-Google sign-in

You can support it, but the docs in this repo assume the current popup flow and label. If you change the UI, update:

- `packages/extension/index.html`
- `packages/extension/script.js`
- this document and `CLERK_SETUP.md`
