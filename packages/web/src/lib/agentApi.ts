// The deployed app proxies /api/* to Convex's HTTP-actions domain (see
// packages/web/vercel.json), so agent URLs live on the same domain as the
// share link — no separate api subdomain or DNS setup. In local dev no proxy
// sits in front of vite, so fall back to the deployment's `.convex.site`
// domain.
export function getAgentApiBase(): string {
  if (!import.meta.env.DEV) return window.location.origin;
  return import.meta.env.VITE_CONVEX_URL.replace(
    ".convex.cloud",
    ".convex.site"
  ).replace(/\/$/, "");
}

// A self-contained instruction block a user can paste into any AI agent so it
// can read snapshots shared from this tool without any install. It documents
// the JSON API against the live deployment, so whatever agent receives it can
// act immediately — no Python, no repo checkout.
export function buildAgentSkillText(): string {
  const base = getAgentApiBase();
  return `# Reading a Screenshot snapshot (for AI agents)

Any snapshot shared from this tool is readable as JSON — no login, no UI, no install.

Given a share link like:
  https://<app>/#/snapshot/<TOKEN>
take <TOKEN> (the last path segment) and fetch:
  GET ${base}/api/snapshot/<TOKEN>
(The API lives on the same domain as the share link itself.)

The JSON response contains:
- media.url        direct URL to the screenshot image or recording video
- console          { entries: [...] } — each entry has index, ts, level, args
- network          { entries: [...] } — each has index, method, url, status,
                   duration, and (when captured) request/response headers + bodies
- device           browser, version, os, viewport, pixelRatio, userAgent, language
- sourceUrl        the page the capture was taken on
- capturedAt       ISO timestamp
- annotations      vector shapes the reporter drew on the image (may be null)
- markedHighlights log entries the reporter explicitly flagged (source + entryIndex,
                   where entryIndex matches the "index" field in console/network)
- htmlUrl          the captured page HTML, when stored (may be null)

Fetch just one piece instead of the whole thing:
  ${base}/api/snapshot/<TOKEN>/console   console entries only (JSON array)
  ${base}/api/snapshot/<TOKEN>/network   network entries only (JSON array)
  ${base}/api/snapshot/<TOKEN>/image     302 redirect to the raw image/video
  ${base}/api/snapshot/<TOKEN>/html      302 redirect to the captured HTML

Notes:
- Log entries the reporter hid during cleanup are already filtered out; surviving
  "index" values are the original positions, so gaps are intentional.
- Snapshots expire ~30 days after capture; a missing/expired token returns 404.

To debug a bug report: fetch the JSON, look at media.url (the screenshot), then
correlate console errors with failed network requests (status >= 400 or with an
"error" field). A console exception right after a failing request is usually one
bug — report the root cause and cite the console/network "index".`;
}
