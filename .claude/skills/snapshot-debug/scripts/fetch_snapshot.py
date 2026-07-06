#!/usr/bin/env python3
"""Fetch a QA snapshot (image + console/network logs + metadata) as local files.

Accepts any of:
  - a viewer share link:  https://<app>/#/snapshot/<shareToken>
                          (the API lives on the same origin, at /api/snapshot/…)
  - a direct API link:    https://<app>/api/snapshot/<shareToken>
  - a bare share token:   32+ hex chars

Usage:
  python3 fetch_snapshot.py <url-or-token> [--out DIR] [--base URL]

Writes into the output directory:
  snapshot.json   full API response (metadata, device, annotations, highlights)
  console.json    console log entries (owner-hidden entries already filtered)
  network.json    network log entries (owner-hidden entries already filtered)
  media.<ext>     the screenshot image or recording video
  page.html       the captured page HTML (only when the snapshot stored it)

Then prints a human/agent-readable summary: source URL, device, console
errors, and failed network requests.

The API base defaults to the team deployment below; override with --base or
the SNAPSHOT_API_BASE env var. If given a viewer link on an unknown host, the
script also tries to self-discover the base from the page's
<meta name="snapshot-agent-api"> tag.
"""

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

# Production Screenshot app; it proxies /api/* to the Convex deployment, so
# API URLs share the viewer's domain. Override with --base or SNAPSHOT_API_BASE
# for other deployments (e.g. a dev/staging Convex instance's .convex.site).
DEFAULT_API_BASE = "https://snap.nachli.com"

MEDIA_EXT = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/gif": "gif",
    "video/webm": "webm",
    "video/mp4": "mp4",
}


def http_get(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "snapshot-debug-skill"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def parse_input(raw: str) -> tuple[str, str | None]:
    """Return (shareToken, apiBase or None)."""
    raw = raw.strip()

    # Bare token
    if re.fullmatch(r"[0-9A-Za-z]{16,64}", raw):
        return raw, None

    # Agent API link — the base is right there
    m = re.match(r"(https?://[^/]+)/api/snapshot/([0-9A-Za-z]{16,64})", raw)
    if m:
        return m.group(2), m.group(1)

    # Viewer link: .../#/snapshot/<token> or .../snapshot/<token>. The API is
    # served on the viewer's own origin (/api/snapshot/…), so the link gives
    # us the base too.
    m = re.search(r"/snapshot/([0-9A-Za-z]{16,64})", raw)
    if m:
        origin = re.match(r"(https?://[^/]+)", raw)
        return m.group(1), origin.group(1) if origin else None

    sys.exit(f"Could not find a share token in: {raw!r}")


def discover_base_from_page(page_url: str) -> str | None:
    """Fetch the SPA index.html and read the snapshot-agent-api meta tag."""
    try:
        html = http_get(page_url.split("#")[0], timeout=10).decode("utf-8", "replace")
    except Exception:
        return None
    if 'name="snapshot-agent-api"' not in html:
        return None
    # Absolute endpoint (older deployments) — use its origin.
    m = re.search(r'name="snapshot-agent-api"\s+content="(https?://[^/"]+)', html)
    if m:
        return m.group(1).replace(".convex.cloud", ".convex.site")
    # Relative endpoint — the API is served on the page's own origin.
    m = re.match(r"(https?://[^/]+)", page_url)
    return m.group(1) if m else None


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("url", help="share link, agent API link, or bare share token")
    parser.add_argument("--out", default=None, help="output directory")
    parser.add_argument("--base", default=None, help="API base URL override")
    args = parser.parse_args()

    token, base_from_url = parse_input(args.url)
    base = (
        args.base
        or base_from_url
        or os.environ.get("SNAPSHOT_API_BASE")
        or (args.url.startswith("http") and discover_base_from_page(args.url))
        or DEFAULT_API_BASE
    )
    base = base.rstrip("/")

    api_url = f"{base}/api/snapshot/{token}"
    try:
        data = json.loads(http_get(api_url))
    except urllib.error.HTTPError as e:
        try:
            detail = json.loads(e.read()).get("error", "")
        except Exception:
            detail = ""
        sys.exit(f"Failed to fetch {api_url}: {e.code} {detail or e.reason}")
    except Exception as e:
        sys.exit(f"Failed to fetch {api_url}: {e}")
    if "error" in data:
        sys.exit(f"API error for {api_url}: {data['error']}")

    out_dir = Path(args.out or f"snapshot-{token[:8]}")
    out_dir.mkdir(parents=True, exist_ok=True)

    (out_dir / "snapshot.json").write_text(json.dumps(data, indent=2))

    console_entries = (data.get("console") or {}).get("entries", [])
    network_entries = (data.get("network") or {}).get("entries", [])
    (out_dir / "console.json").write_text(json.dumps(console_entries, indent=2))
    (out_dir / "network.json").write_text(json.dumps(network_entries, indent=2))

    media = data.get("media") or {}
    media_path = None
    if media.get("url"):
        ext = MEDIA_EXT.get(media.get("mimeType", ""), "bin")
        media_path = out_dir / f"media.{ext}"
        media_path.write_bytes(http_get(media["url"], timeout=120))

    html_path = None
    if data.get("htmlUrl"):
        html_path = out_dir / "page.html"
        try:
            html_path.write_bytes(http_get(data["htmlUrl"], timeout=60))
        except Exception:
            html_path = None

    # --- Summary ---
    device = data.get("device") or {}
    errors = [e for e in console_entries if e.get("level") == "error"]
    warnings = [e for e in console_entries if e.get("level") == "warn"]
    failed = [
        n for n in network_entries
        if n.get("error") or (isinstance(n.get("status"), int) and n["status"] >= 400)
    ]
    highlights = data.get("markedHighlights") or []

    print(f"Snapshot: {data.get('title') or data.get('filename')}")
    print(f"  type: {data.get('type')}   captured: {data.get('capturedAt')}")
    print(f"  page: {data.get('sourceUrl')}")
    dev_bits = [device.get("browser"), device.get("browserVersion"), device.get("os")]
    vp = (
        f"{device['viewportWidth']}x{device['viewportHeight']}"
        if device.get("viewportWidth")
        else None
    )
    print(f"  device: {' '.join(str(b) for b in dev_bits if b)}"
          + (f", viewport {vp}" if vp else ""))
    print(f"  expires: {data.get('expiresAt')}")
    print()
    print(f"Files written to {out_dir}/:")
    print(f"  snapshot.json  (full metadata)")
    print(f"  console.json   ({len(console_entries)} entries, {len(errors)} errors, {len(warnings)} warnings)")
    print(f"  network.json   ({len(network_entries)} requests, {len(failed)} failed)")
    if media_path:
        dims = (
            f", {media['width']}x{media['height']}"
            if media.get("width") and media.get("height")
            else ""
        )
        print(f"  {media_path.name}      ({media.get('mimeType')}{dims})")
    if html_path:
        print(f"  page.html      (captured DOM)")
    if data.get("annotations"):
        print("  (has vector annotations drawn on the image — see snapshot.json)")
    if highlights:
        print(f"  ({len(highlights)} owner-marked log highlights — the reporter flagged these entries; see markedHighlights in snapshot.json)")
    print()
    if errors:
        print("Console errors:")
        for e in errors:
            print(f"  [{e.get('index')}] {' '.join(e.get('args') or [])[:300]}")
    if failed:
        print("Failed network requests:")
        for n in failed:
            line = f"  [{n.get('index')}] {n.get('method')} {n.get('url')} -> {n.get('status') or n.get('error')}"
            if n.get("responsePreview"):
                line += f"  body: {str(n['responsePreview'])[:200]}"
            print(line)
    if not errors and not failed:
        print("No console errors or failed requests captured.")


if __name__ == "__main__":
    main()
