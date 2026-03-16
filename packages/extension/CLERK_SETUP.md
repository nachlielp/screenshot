# Clerk Setup

This project uses Clerk in two places:

- the Chrome extension for sign-in and Convex tokens
- the React app for authenticated library access

## What you need from Clerk

- a publishable key
- your Clerk frontend domain
- your Clerk issuer / API domain
- a JWT template for Convex

## Required Clerk configuration

### 1. Create an application

Create a Clerk app for this project.

### 2. Enable the sign-in method you want

The extension popup currently exposes `Sign in with Google`, so Google should be enabled unless you plan to change the popup UI and auth flow.

### 3. Create the Convex JWT template

Create a JWT template that uses:

- application ID: `convex`

### 4. Add allowed origins

After loading the unpacked extension, add this origin in Clerk:

```text
chrome-extension://YOUR_EXTENSION_ID
```

## Where the values go

### Extension

Update `packages/extension/utils/auth.js` with:

- `CLERK_PUBLISHABLE_KEY`
- `CLERK_DOMAIN`
- `CLERK_API_DOMAIN`
- `CLERK_COOKIE_DOMAINS`
- `CLERK_COOKIE_URLS`

### Web app

Add to `packages/web/.env.local`:

```bash
VITE_CLERK_PUBLISHABLE_KEY=pk_test_...
```

### Convex

Set the issuer:

```bash
npx convex env set CLERK_ISSUER https://your-instance.clerk.accounts.dev
```

## How this repo currently authenticates

1. The extension opens the Clerk hosted sign-in page in a tab
2. After sign-in, the user returns to the popup
3. The popup uses `Sync Session` to read Clerk cookies
4. The extension exchanges that session for a Convex token
5. The web app uses Clerk React directly with the same publishable key

## Common mistakes

- Mixing values from two different Clerk instances
- Forgetting to add the extension origin
- Creating a JWT template with the wrong application ID
- Updating the web app env but not `utils/auth.js`
