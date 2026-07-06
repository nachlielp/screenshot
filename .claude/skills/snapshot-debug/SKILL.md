---
name: snapshot-debug
description: Fetch and analyze a QA snapshot from the team's Screenshot tool — image, console logs, network requests, and capture metadata — without opening any UI. Use this whenever the user pastes a snapshot share link (a URL containing /snapshot/<token> or /api/snapshot/<token>, often on *.convex.site or the Screenshot web app), mentions "a snapshot from QA", asks to debug or diagnose a bug from a screenshot link, or wants the logs/network/metadata behind a shared capture. Even if the user just pastes such a link with no instructions, use this skill to pull the data and summarize what went wrong.
---

# Debugging from a Screenshot snapshot link

QA captures bugs with the team's Screenshot Chrome extension. Each capture is
shared as a link, and behind every link sits a JSON API with everything the
reporter saw: the screenshot (or recording), the browser console, the network
log, device info, and any annotations or log entries the reporter highlighted.
This skill turns such a link into local files you can read and a diagnosis you
can act on.

## Step 1 — Fetch everything with the bundled script

```bash
python3 scripts/fetch_snapshot.py "<link-or-token>" --out ./snapshot-data
```

The share link the user pastes is the only link needed — the JSON API lives on
the same domain as the viewer, so the script extracts the token and talks to
`<same-origin>/api/snapshot/<token>` itself. It accepts a viewer link
(`https://<app>/#/snapshot/<token>`), a direct API link
(`https://<app>/api/snapshot/<token>`), or a bare token. It writes `snapshot.json`, `console.json`, `network.json`, the
media file, and (when stored) `page.html`, then prints a summary that already
lists console errors and failed requests. Python 3 with no extra packages.

If it reports "not found or expired": snapshots expire after 30 days, or the
token is wrong — tell the user rather than guessing. If the link is on an
unfamiliar host and discovery fails, pass `--base https://<deployment>.convex.site`
(ask the user which Convex deployment their Screenshot instance uses).

## Step 2 — Look at the evidence, in this order

1. **Read the media file** (it's an image — view it; for `.webm`/`.mp4`
   recordings extract a few frames with ffmpeg if needed). The screenshot
   shows what the reporter actually saw, and vector `annotations` in
   `snapshot.json` mean the reporter circled/arrowed something specific —
   treat annotated regions as the reporter pointing at the bug.
2. **`markedHighlights`** in `snapshot.json`: the reporter explicitly flagged
   these console/network entries. Each has a `source` and `entryIndex` that
   matches the `index` field in `console.json`/`network.json`. Start there —
   it's the reporter telling you which log lines matter.
3. **Console errors and failed requests** (the script summary lists them).
   Correlate them: a console `TypeError` right after a 500 response usually
   means unhandled error-path code, not two separate bugs. Timestamps (`ts`,
   epoch ms) and request `duration` help establish ordering.
4. **Metadata for context**: `sourceUrl` is the page the bug happened on,
   `device` gives browser/OS/viewport (relevant for layout bugs),
   `capturedAt` for correlating with server logs or deploys.

Note: log entries the reporter hid during cleanup are already filtered out
server-side, and the surviving `index` values are the original positions —
gaps in the sequence are intentional, not missing data.

## Step 3 — Report

Lead with the diagnosis, then the evidence. A good report answers:

- **What's broken, user-visibly** (from the image + title).
- **Why** — the failing request and/or the exception, quoted with its
  console/network `index` so others can find it in the shared viewer.
- **Where to look in code** — file/line if the stack trace names one, the
  failing endpoint otherwise.
- **What to do next** — a concrete fix or the narrowest missing piece of
  information.

If the user is working in the codebase where the bug lives, go find the code
the stack trace or failing endpoint points at and confirm the diagnosis
against the actual source before proposing a fix.

**Example.** `console.json` has
`TypeError: Cannot read properties of undefined (reading 'total') at submitOrder (checkout.js:214)`
and `network.json` has `POST /v2/payment-intents -> 500` with body
`{"error":"missing field: cart_total"}`. Report: the checkout submit sends a
payment-intent request without `cart_total`; the server 500s, and the
unguarded response handler in `checkout.js:214` then reads `.total` off an
undefined error payload. Fix the missing field first; the TypeError is the
symptom, not the cause.
