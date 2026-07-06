import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

// Agent-facing JSON API, served on the deployment's `.convex.site` domain and
// proxied onto the web app's own domain at the same /api/* paths by a Vercel
// rewrite (packages/web/vercel.json) — agent URLs share the viewer's domain,
// no separate api subdomain or DNS setup.
//
//   GET /api/snapshot/<shareToken>          full JSON (metadata + inlined logs)
//   GET /api/snapshot/<shareToken>/console  filtered console log array only
//   GET /api/snapshot/<shareToken>/network  filtered network log array only
//   GET /api/snapshot/<shareToken>/image    302 redirect to the raw image/video
//   GET /api/snapshot/<shareToken>/html     302 redirect to the captured page HTML
//
// Access is gated by the same unguessable share token as the web viewer, so
// anything reachable here is already reachable through the share link. Log
// entries the owner hid in the viewer ("cleanup") are filtered out; each
// surviving entry keeps its original array index in `index` so markedView
// highlight references stay meaningful.

const http = httpRouter();

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}

function errorResponse(status: number, message: string): Response {
  return jsonResponse({ error: message }, status);
}

// Parse an uploaded log file (a JSON array) and drop owner-hidden entries,
// tagging each surviving entry with its original index.
async function loadFilteredLogs(
  blob: Blob | null,
  hiddenIndices: number[] | undefined
): Promise<{ entries: unknown[]; hiddenCount: number } | null> {
  if (!blob) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await blob.text());
  } catch {
    return { entries: [], hiddenCount: 0 };
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], hiddenCount: 0 };
  }

  const hidden = new Set(hiddenIndices ?? []);
  const entries: unknown[] = [];
  parsed.forEach((entry, index) => {
    if (hidden.has(index)) return;
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      entries.push({ index, ...entry });
    } else {
      entries.push({ index, value: entry });
    }
  });

  return { entries, hiddenCount: parsed.length - entries.length };
}

function parseAnnotations(annotations: string | undefined): unknown {
  if (!annotations) return null;
  try {
    return JSON.parse(annotations);
  } catch {
    return null;
  }
}

function buildDeviceInfo(s: Doc<"screenshots">) {
  return {
    browser: s.deviceBrowser ?? null,
    browserVersion: s.deviceBrowserVersion ?? null,
    browserMode: s.deviceBrowserMode ?? null,
    os: s.deviceOs ?? null,
    platform: s.devicePlatform ?? null,
    networkSpeed: s.deviceNetworkSpeed ?? null,
    charging: s.deviceCharging ?? null,
    screenWidth: s.deviceScreenWidth ?? null,
    screenHeight: s.deviceScreenHeight ?? null,
    viewportWidth: s.deviceViewportWidth ?? null,
    viewportHeight: s.deviceViewportHeight ?? null,
    pixelRatio: s.devicePixelRatio ?? null,
    userAgent: s.deviceUserAgent ?? null,
    language: s.deviceLanguage ?? null,
  };
}

const USAGE = {
  name: "Screenshot agent API",
  description:
    "Machine-readable access to a shared snapshot: image, console logs, network logs, and capture metadata.",
  usage: {
    "GET /api/snapshot/{shareToken}":
      "Full JSON: metadata, device info, media URL, annotations, marked highlights, console + network logs inlined.",
    "GET /api/snapshot/{shareToken}/console": "Console log entries only (JSON array).",
    "GET /api/snapshot/{shareToken}/network": "Network log entries only (JSON array).",
    "GET /api/snapshot/{shareToken}/image": "302 redirect to the raw image or video file.",
    "GET /api/snapshot/{shareToken}/html": "302 redirect to the captured page HTML, when stored.",
  },
  note: "The shareToken is the last path segment of a viewer link like https://<app>/#/snapshot/<shareToken>.",
};

const snapshotHandler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  // pathPrefix route: everything after /api/snapshot/
  const rest = url.pathname.replace(/^\/api\/snapshot\/?/, "");
  const [shareToken, subresource, ...extra] = rest.split("/").filter(Boolean);

  if (!shareToken) {
    return jsonResponse(USAGE);
  }
  if (extra.length > 0) {
    return errorResponse(404, "Unknown resource");
  }

  const screenshot = await ctx.runQuery(
    api.screenshots.getScreenshotByShareToken,
    { shareToken }
  );

  if (!screenshot) {
    return errorResponse(404, "Snapshot not found or expired");
  }

  switch (subresource) {
    case undefined: {
      const [consoleLogs, networkLogs] = await Promise.all([
        screenshot.consoleLogsStorageId
          ? ctx.storage
              .get(screenshot.consoleLogsStorageId)
              .then((blob) =>
                loadFilteredLogs(blob, screenshot.hiddenLogEntries?.console)
              )
          : Promise.resolve(null),
        screenshot.networkLogsStorageId
          ? ctx.storage
              .get(screenshot.networkLogsStorageId)
              .then((blob) =>
                loadFilteredLogs(blob, screenshot.hiddenLogEntries?.network)
              )
          : Promise.resolve(null),
      ]);

      return jsonResponse({
        shareToken: screenshot.shareToken,
        type: screenshot.type,
        title: screenshot.title ?? null,
        filename: screenshot.filename,
        sourceUrl: screenshot.sourceUrl ?? null,
        capturedAt: screenshot.captureTimestamp ?? null,
        createdAt: new Date(screenshot.createdAt).toISOString(),
        expiresAt: new Date(screenshot.expiresAt).toISOString(),
        media: {
          url: screenshot.publicUrl,
          mimeType: screenshot.mimeType,
          fileSize: screenshot.fileSize,
          width: screenshot.width ?? null,
          height: screenshot.height ?? null,
          duration: screenshot.duration ?? null,
        },
        htmlUrl: screenshot.htmlPublicUrl ?? null,
        device: buildDeviceInfo(screenshot),
        // Vector annotations drawn on top of the image ({version, items}).
        annotations: parseAnnotations(screenshot.annotations),
        // Owner-marked log highlights; entryIndex matches `index` in the logs.
        markedHighlights: screenshot.markedView?.items ?? [],
        console: consoleLogs,
        network: networkLogs,
      });
    }
    case "console":
    case "network": {
      const storageId =
        subresource === "console"
          ? screenshot.consoleLogsStorageId
          : screenshot.networkLogsStorageId;
      if (!storageId) {
        return errorResponse(404, `No ${subresource} logs for this snapshot`);
      }
      const blob = await ctx.storage.get(storageId);
      const logs = await loadFilteredLogs(
        blob,
        screenshot.hiddenLogEntries?.[subresource]
      );
      return jsonResponse(logs?.entries ?? []);
    }
    case "image":
      return new Response(null, {
        status: 302,
        headers: {
          Location: screenshot.publicUrl,
          "Access-Control-Allow-Origin": "*",
        },
      });
    case "html":
      if (!screenshot.htmlPublicUrl) {
        return errorResponse(404, "No captured HTML for this snapshot");
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: screenshot.htmlPublicUrl,
          "Access-Control-Allow-Origin": "*",
        },
      });
    default:
      return errorResponse(404, "Unknown resource");
  }
});

const usageHandler = httpAction(async () => jsonResponse(USAGE));

const corsHandler = httpAction(
  async () =>
    new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      },
    })
);

http.route({ path: "/api/snapshot", method: "GET", handler: usageHandler });
http.route({ pathPrefix: "/api/snapshot/", method: "GET", handler: snapshotHandler });
http.route({ path: "/api/snapshot", method: "OPTIONS", handler: corsHandler });
http.route({ pathPrefix: "/api/snapshot/", method: "OPTIONS", handler: corsHandler });

export default http;
