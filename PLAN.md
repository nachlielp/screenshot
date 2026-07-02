# Improvement & Refactor Plan

Goals, in the user's words:
1. Edit mode: draw **lines** and **move annotations** after placing them.
2. Uploaded captures with console/network logs: **shift-select a bunch of entries and delete** (cleanup).
3. **Video recordings** you can easily **slide through and annotate**.
4. It feels unstable → **full refactor** for stability.

## Where the code stands today (findings)

- **Annotations are rasterized.** All three editors (web `ImageEditor.tsx`, extension `editor.js`, `slideshow-editor.js`) burn rect/arrow/text/crop straight into canvas pixels. There is no object model, so select/move/resize/delete-after-place is impossible without a rewrite of the drawing layer. The three editors are ~60–70% duplicated code (same `drawArrow`, history stack, mouse handlers, text-input logic copied three times).
- **Logs are immutable JSON blobs.** Console/network logs are uploaded to Convex storage as whole JSON files; the viewer only filters and "marks" entries (`markedView` stores `entryIndex` references into the original arrays). There is no mutation to remove entries. Note: `markedView.entryIndex` points into the original array — any log-deletion design must not shift indices (or must remap them).
- **Video recording already exists but is split in two.** Tab recording lives in `offscreen.js` (MediaRecorder, WebM, audio mixing); desktop recording is a *separate duplicated* implementation in `screenRecord.js` opened in a pinned tab. `screenRecord.js` doesn't reliably handle `stop-recording`, AudioContexts are never closed, and the single global `mediaRecorder`/`recordedChunks` state races on double-start. The "slideshow" is a sequence of *screenshots* (each a separate IndexedDB capture), not video frames — which is actually a great foundation for "slide through and annotate."
- **Instability has identifiable causes**, mostly in the extension:
  - Fire-and-forget `chrome.runtime.sendMessage` for start/stop recording — failures are silent (sw.js:317–319).
  - Clerk token expires in ~55–60s; uploads longer than that fail mid-flight with no retry, leaving orphaned storage blobs.
  - Page interceptors read full response bodies with no size cap — big JSON responses freeze the captured page.
  - Full-page capture restores scroll position only on the happy path; failure leaves the page scrolled.
  - AudioContext leak, offscreen-document lifecycle not cleaned up on error, IndexedDB cleanup races, silent log-fetch failures in the web viewer, no pagination in Library (hard 100 cap), unbounded `viewerTokens` array.

---

## Phase 0 — Stabilization quick wins (do first, no architecture changes)

Small, independent fixes that remove the worst "feels flaky" causes:

1. **Wrap all `chrome.runtime.sendMessage`/`chrome.tabs.sendMessage` in a promise helper** with timeout + `chrome.runtime.lastError` check; surface failures to the popup as a toast/status instead of silence.
2. **Recording state guards**: refuse `start-recording` when a recorder is active; refuse `stop` when idle; close `AudioContext` and stop all tracks in a `finally`.
3. **Response-body cap in `page-interceptors.js`**: only capture text-like bodies up to ~64KB, store `[truncated N bytes]` beyond that. Fixes page freezes during capture.
4. **`try/finally` scroll restoration** in full-page capture; add max-iteration guard to the scroll loop.
5. **Token pre-flight**: refresh the Convex token immediately before each upload step (image, html, console, network are 4 separate uploads); on 401 retry once with a fresh token.
6. **Web viewer: distinguish "no logs" from "failed to fetch logs"** (currently both render an empty panel).
7. **Fix the text-input double-finalize race** (150ms blur timeout in editor.js / slideshow-editor.js) with a `finalized` flag.

Effort: ~1–2 days. Ship as its own release before touching architecture.

## Phase 1 — Refactor foundation: one codebase, typed, shared

The root cause of instability and duplication is three hand-copied vanilla-JS editors plus an unbuilt extension. Fix the foundation once:

1. **Add a build step to the extension** (Vite + CRXJS or plain multi-entry Vite build → `dist/`). Keeps manifest v3, enables TypeScript and workspace imports.
2. **Convert extension JS to TypeScript** incrementally (start with `sw.js`, `offscreen.js`, `utils/*` — the message-passing core).
3. **Create `packages/shared/`** with:
   - `messaging/` — typed message contracts (one discriminated union of all message types), promise-based request/response helpers used by sw, content, offscreen, popup. Kills the silent-failure class of bugs.
   - `annotation-engine/` — see Phase 2.
   - `log-types/` — shared `ConsoleEntry`/`NetworkEntry` types used by interceptors, extension, web, and Convex validators.
4. **Merge `screenRecord.js` into the offscreen recording path.** One `RecordingController` handling both tab and desktop sources; single state machine (`idle → acquiring → recording → stopping → saved`), badge + popup reflect the real state.
5. **Auth hardening** (`utils/auth.js`): proactive refresh scheduling, exponential backoff on token fetch, explicit "signed out — click to re-auth" state instead of silent clears.
6. **Upload flow**: upload all blobs first, then a single `createScreenshot` mutation; on mutation failure, delete the uploaded blobs (or add a Convex cron sweeping unreferenced storage).

Effort: ~1 week. Everything after this gets cheaper.

## Phase 2 — Vector annotation engine (lines + move/edit annotations)

Replace raster drawing with an object model. One engine, used by all editors.

**Design** (`packages/shared/annotation-engine`):
- Annotation objects in normalized image coordinates:
  `{ id, type: 'rect' | 'arrow' | 'line' | 'freehand' | 'text', points, color, thickness, text?, fontSize? }`
- Render loop: draw base image, then all annotations, every frame (canvas redraw or SVG overlay — recommend canvas redraw since export burn-in is then free).
- **Select tool**: hit-testing per shape, drag to move, handles to resize/re-point arrows and lines, Delete key removes, Escape deselects.
- Undo/redo over the annotation *list* (cheap object snapshots) instead of 50 full-canvas ImageData snapshots — also fixes memory use.
- Export = render to canvas → PNG (burn-in happens only at download/upload time).

**New tools**: line (trivial once arrow exists — it's an arrow without a head), freehand pen, and fix the arrow-head-proportional-to-thickness bug while in there.

**Persistence** (this is what makes annotations *re-editable after upload*):
- Extension: store `annotations: Annotation[]` on the IndexedDB capture record.
- Convex: add optional `annotations` field to `screenshots` (and per-frame on `slideshows.frames`), mirroring how `markedView` already works. Viewer/editor renders base image + annotation objects; share links show them too.
- Keep uploading the flattened PNG as the `publicUrl` for backward compat / thumbnails.

**Adoption**: web `ImageEditor.tsx` becomes a thin React wrapper around the engine; extension `editor.js` and `slideshow-editor.js` become thin pages around the same engine. Deletes ~1,500 lines of duplicated code.

Effort: ~1–1.5 weeks including migration of the three editors.

## Phase 3 — Log cleanup: multi-select + delete entries

**Recommended approach: hidden-indices field, not file rewrite.**
- Add `hiddenLogEntries?: { console: number[], network: number[] }` to the `screenshots` doc + a `setHiddenLogEntries` mutation (owner-only), same pattern as `saveMarkedView`.
- Why: the JSON log files stay immutable, `markedView.entryIndex` references stay valid, and cleanup is *reversible* ("show N hidden entries" toggle). No re-upload, no remapping.
- Optional later: a "Compact logs" action that rewrites the JSON file without hidden entries, remaps `markedView` indices, swaps `consoleLogsStorageId`, and deletes the old blob — for when someone wants the shared link to truly not contain the data. (If logs may contain secrets, this matters; hiding is cosmetic.)

**Selection UX** in `SnapshotViewer.tsx`:
- Selection mode toggle in the console and network panels; checkbox per row; **shift-click selects a range** (reuse the exact pattern already implemented in `Library.tsx:` shift-select); Ctrl/Cmd-click toggles; "Select all filtered" respects the active level/type filters.
- Action bar: "Hide selected (N)", "Unhide all". Marked entries that get hidden are also removed from `markedView`.

Effort: ~2–3 days after Phase 1.

## Phase 4 — Video recording: slide through and annotate

Build on what exists rather than inventing a video-annotation timeline from scratch:

1. **Unified recording** (done in Phase 1) so tab + desktop recording are equally reliable.
2. **Video review page** (replaces bare `video.html`): proper player with a **filmstrip/scrubber** (thumbnails generated by seeking a hidden `<video>` + canvas grabs at intervals).
3. **"Snap frame" while scrubbing**: pause anywhere → grab the current frame as a PNG capture → it appends to a slideshow session. This *reuses the entire existing slideshow pipeline* (frames, per-frame annotation via the Phase-2 engine, upload, shared slideshow viewer). Result: record a video → scrub → pick the moments → annotate each → share as a slideshow, optionally alongside the raw video.
4. **Optional v2 — timestamped annotations on the video itself**: `videoAnnotations: { t: number, annotations: Annotation[] }[]` on the recording doc; the web player shows annotations overlaid during ±N seconds around each timestamp, with markers on the seek bar. The Phase-2 engine renders these too — the overlay is the same code. Do this only if frame-snapping proves insufficient.
5. **Recording UX**: countdown before start, live badge timer, mic/system-audio toggles remembered, and console/network log capture *during* recording for tab recordings (interceptors are already injected — buffer the whole recording window, not just a snapshot).

Effort: ~1 week for 1–3 + 5; timestamped overlay (~4) is another ~4–5 days if wanted.

## Phase 5 — Backend & web hardening

- **Pagination** in `library.ts` (cursor-based via Convex `paginate`), plus a `by_userId_createdAt` index; Library gets infinite scroll and search-by-title/domain.
- **Cap/prune `viewerTokens`** (e.g. keep last 500) or move view-dedup to a separate table.
- **Validate `markedView`/`hiddenLogEntries` indices** against actual log lengths in mutations.
- **Orphaned-blob sweep cron** (storage files not referenced by any doc).
- **Fix view-count race** (dedupe check before increment).
- **Error toasts everywhere the web app currently swallows errors** (log fetch, markedView save has no failure surfacing).
- **Tests**: unit tests for annotation-engine (hit-testing, undo/redo, serialization), message-contract tests for the typed bus, Convex function tests for the new mutations.

Effort: ~3–4 days.

---

## Suggested order & rough total

| Phase | What | Effort |
|---|---|---|
| 0 | Stability quick wins | 1–2 days |
| 1 | Build step, TS, shared packages, unified recording, auth/upload hardening | ~1 week |
| 2 | Vector annotation engine (lines, move/select, re-editable) | 1–1.5 weeks |
| 3 | Log multi-select + hide/delete | 2–3 days |
| 4 | Video review: scrub, snap-to-slideshow, annotate | ~1 week |
| 5 | Backend/web hardening + tests | 3–4 days |

Total ≈ 4–5 weeks of focused work. Phases 2/3/4 are independent after Phase 1, so they can be reordered by what hurts most — but do 0 and 1 first; every later phase gets easier and less buggy on top of them.

## Key decisions to confirm

1. **Annotations become vector data stored alongside the image** (re-editable forever), with PNG burn-in only at export — vs. keeping raster and only adding a session-local object layer. Recommended: vector + stored.
2. **Log cleanup = hide (reversible, indices stay valid)** with optional later "compact" that truly rewrites the file. Recommended: hide first.
3. **Video annotation = snap frames into the existing slideshow flow** first; timestamped on-video overlays as a v2. Recommended: frames first.
4. **Extension gets a build step + TypeScript** — this is the one structural prerequisite for sharing the engine and killing the duplication.
