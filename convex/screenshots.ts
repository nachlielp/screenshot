import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";

// 30 days in milliseconds
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const markedItemValidator = v.object({
  id: v.string(),
  source: v.union(v.literal("console"), v.literal("network")),
  entryIndex: v.number(),
  order: v.number(),
  xPercent: v.number(),
  yPercent: v.number(),
});

const markedViewValidator = v.object({
  version: v.literal(1),
  updatedAt: v.number(),
  items: v.array(markedItemValidator),
});

// Generate a random share token
function generateShareToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Generate upload URL for file storage
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }
    
    return await ctx.storage.generateUploadUrl();
  },
});


// Get or create user from Clerk ID
export const getOrCreateUser = mutation({
  args: {
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Check if user exists
    const existingUser = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", args.clerkId))
      .first();

    if (existingUser) {
      return existingUser._id;
    }

    // Create new user
    const userId = await ctx.db.insert("users", {
      clerkId: args.clerkId,
      email: args.email,
      name: args.name,
      createdAt: Date.now(),
    });

    return userId;
  },
});

// Upload screenshot to Convex storage
export const uploadScreenshot = mutation({
  args: {
    storageId: v.id("_storage"),
    htmlStorageId: v.optional(v.id("_storage")),
    consoleLogsStorageId: v.optional(v.id("_storage")),
    networkLogsStorageId: v.optional(v.id("_storage")),
    filename: v.string(),
    title: v.optional(v.string()),
    mimeType: v.string(),
    fileSize: v.number(),
    type: v.union(
      v.literal("screenshot"),
      v.literal("tab-recording"),
      v.literal("screen-recording")
    ),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    duration: v.optional(v.number()),
    sourceUrl: v.optional(v.string()),
    // Device metadata
    deviceBrowser: v.optional(v.string()),
    deviceBrowserVersion: v.optional(v.string()),
    deviceOs: v.optional(v.string()),
    devicePlatform: v.optional(v.string()),
    deviceNetworkSpeed: v.optional(v.string()),
    deviceCharging: v.optional(v.string()),
    deviceBrowserMode: v.optional(v.string()),
    deviceScreenWidth: v.optional(v.number()),
    deviceScreenHeight: v.optional(v.number()),
    deviceViewportWidth: v.optional(v.number()),
    deviceViewportHeight: v.optional(v.number()),
    devicePixelRatio: v.optional(v.number()),
    deviceUserAgent: v.optional(v.string()),
    deviceLanguage: v.optional(v.string()),
    captureTimestamp: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    // Get user ID from Clerk ID
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      throw new Error("User not found");
    }

    const shareToken = generateShareToken();
    const now = Date.now();
    const expiresAt = now + THIRTY_DAYS_MS;

    // Get the storage URL
    const storageUrl = await ctx.storage.getUrl(args.storageId);
    if (!storageUrl) {
      throw new Error("Failed to get storage URL");
    }
    
    // Get HTML storage URL if provided
    let htmlPublicUrl = undefined;
    if (args.htmlStorageId) {
      const htmlUrl = await ctx.storage.getUrl(args.htmlStorageId);
      htmlPublicUrl = htmlUrl || undefined;
    }

    // Get console logs storage URL if provided
    let consoleLogsUrl = undefined;
    if (args.consoleLogsStorageId) {
      const clUrl = await ctx.storage.getUrl(args.consoleLogsStorageId);
      consoleLogsUrl = clUrl || undefined;
    }

    // Get network logs storage URL if provided
    let networkLogsUrl = undefined;
    if (args.networkLogsStorageId) {
      const nlUrl = await ctx.storage.getUrl(args.networkLogsStorageId);
      networkLogsUrl = nlUrl || undefined;
    }

    const screenshotId = await ctx.db.insert("screenshots", {
      userId: user._id,
      filename: args.filename,
      title: normalizeScreenshotTitle(args.title),
      mimeType: args.mimeType,
      fileSize: args.fileSize,
      storageId: args.storageId,
      publicUrl: storageUrl,
      htmlStorageId: args.htmlStorageId,
      htmlPublicUrl: htmlPublicUrl,
      consoleLogsStorageId: args.consoleLogsStorageId,
      consoleLogsUrl: consoleLogsUrl,
      networkLogsStorageId: args.networkLogsStorageId,
      networkLogsUrl: networkLogsUrl,
      sourceUrl: args.sourceUrl,
      type: args.type,
      width: args.width,
      height: args.height,
      duration: args.duration,
      // Device metadata
      deviceBrowser: args.deviceBrowser,
      deviceBrowserVersion: args.deviceBrowserVersion,
      deviceOs: args.deviceOs,
      devicePlatform: args.devicePlatform,
      deviceNetworkSpeed: args.deviceNetworkSpeed,
      deviceCharging: args.deviceCharging,
      deviceBrowserMode: args.deviceBrowserMode,
      deviceScreenWidth: args.deviceScreenWidth,
      deviceScreenHeight: args.deviceScreenHeight,
      deviceViewportWidth: args.deviceViewportWidth,
      deviceViewportHeight: args.deviceViewportHeight,
      devicePixelRatio: args.devicePixelRatio,
      deviceUserAgent: args.deviceUserAgent,
      deviceLanguage: args.deviceLanguage,
      captureTimestamp: args.captureTimestamp,
      createdAt: now,
      expiresAt: expiresAt,
      shareToken: shareToken,
      isPublic: true,
      viewCount: 0,
      viewerTokens: [],
    });

    return {
      id: screenshotId,
      shareToken: shareToken,
      publicUrl: storageUrl,
      htmlPublicUrl: htmlPublicUrl,
      consoleLogsUrl: consoleLogsUrl,
      networkLogsUrl: networkLogsUrl,
      expiresAt: expiresAt,
    };
  },
});

// Get screenshot by share token (public access) — mutation version (increments views)
export const getScreenshotByToken = mutation({
  args: { shareToken: v.string() },
  handler: async (ctx, args) => {
    const screenshot = await ctx.db
      .query("screenshots")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!screenshot) {
      return null;
    }

    // Check if expired
    if (screenshot.expiresAt < Date.now()) {
      return null;
    }

    // Increment view count
    await ctx.db.patch(screenshot._id, {
      viewCount: screenshot.viewCount + 1,
      lastViewedAt: Date.now(),
    });

    return screenshot;
  },
});

// Get screenshot by share token (public, read-only query for the web app)
export const getScreenshotByShareToken = query({
  args: { shareToken: v.string() },
  handler: async (ctx, args) => {
    const screenshot = await ctx.db
      .query("screenshots")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!screenshot) {
      return null;
    }

    if (screenshot.expiresAt < Date.now()) {
      return null;
    }

    return screenshot;
  },
});

export const getSnapshotViewerState = query({
  args: { shareToken: v.string() },
  handler: async (ctx, args) => {
    const screenshot = await ctx.db
      .query("screenshots")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!screenshot || screenshot.expiresAt < Date.now()) {
      return null;
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        screenshot,
        canEdit: false,
      };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    return {
      screenshot,
      canEdit: Boolean(user && screenshot.userId === user._id),
    };
  },
});

// Increment view count (public mutation for the web app)
export const incrementViewCount = mutation({
  args: {
    shareToken: v.string(),
    viewerToken: v.string(),
  },
  handler: async (ctx, args) => {
    const screenshot = await ctx.db
      .query("screenshots")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!screenshot) return;

    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
        .first();

      if (user && screenshot.userId === user._id) {
        return;
      }
    }

    const existingViewerTokens = screenshot.viewerTokens ?? [];
    if (existingViewerTokens.includes(args.viewerToken)) {
      return;
    }

    const nextViewCount =
      Math.max(screenshot.viewCount, existingViewerTokens.length) + 1;

    await ctx.db.patch(screenshot._id, {
      viewCount: nextViewCount,
      viewerTokens: [...existingViewerTokens, args.viewerToken],
      lastViewedAt: Date.now(),
    });
  },
});

export const updateScreenshotTitle = mutation({
  args: {
    shareToken: v.string(),
    title: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const screenshot = await ctx.db
      .query("screenshots")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!screenshot || screenshot.expiresAt < Date.now()) {
      throw new Error("Snapshot not found");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user || screenshot.userId !== user._id) {
      throw new Error("Not authorized");
    }

    const nextTitle = normalizeScreenshotTitle(args.title);
    await ctx.db.patch(screenshot._id, {
      title: nextTitle,
    });

    return nextTitle ?? null;
  },
});

export const saveMarkedView = mutation({
  args: {
    shareToken: v.string(),
    markedView: markedViewValidator,
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const screenshot = await ctx.db
      .query("screenshots")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!screenshot || screenshot.expiresAt < Date.now()) {
      throw new Error("Snapshot not found");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user || screenshot.userId !== user._id) {
      throw new Error("Not authorized");
    }

    const normalizedItems = [...args.markedView.items]
      .sort((a, b) => a.order - b.order)
      .map((item, index) => ({
        ...item,
        entryIndex: Math.max(0, Math.floor(item.entryIndex)),
        order: index + 1,
        xPercent: Math.min(100, Math.max(0, item.xPercent)),
        yPercent: Math.min(100, Math.max(0, item.yPercent)),
      }));

    const nextMarkedView =
      normalizedItems.length === 0
        ? undefined
        : {
            version: 1 as const,
            updatedAt: Date.now(),
            items: normalizedItems,
          };

    await ctx.db.patch(screenshot._id, {
      markedView: nextMarkedView,
    });

    return nextMarkedView ?? null;
  },
});

// Get user's screenshots
export const getUserScreenshots = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return [];
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      return [];
    }

    const limit = args.limit ?? 100;
    const screenshots = await ctx.db
      .query("screenshots")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(limit);

    return screenshots;
  },
});

async function deleteScreenshotRecord(
  ctx: MutationCtx,
  screenshot: Doc<"screenshots">
) {
  await ctx.storage.delete(screenshot.storageId);

  if (screenshot.htmlStorageId) {
    await ctx.storage.delete(screenshot.htmlStorageId).catch(() => {});
  }
  if (screenshot.consoleLogsStorageId) {
    await ctx.storage.delete(screenshot.consoleLogsStorageId).catch(() => {});
  }
  if (screenshot.networkLogsStorageId) {
    await ctx.storage.delete(screenshot.networkLogsStorageId).catch(() => {});
  }

  await ctx.db.delete(screenshot._id);
}

// Delete screenshot
export const deleteScreenshot = mutation({
  args: { id: v.id("screenshots") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const screenshot = await ctx.db.get(args.id);
    if (!screenshot) {
      throw new Error("Screenshot not found");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user || screenshot.userId !== user._id) {
      throw new Error("Not authorized");
    }

    await deleteScreenshotRecord(ctx, screenshot);
  },
});

export const deleteScreenshots = mutation({
  args: { ids: v.array(v.id("screenshots")) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const uniqueIds = Array.from(new Set(args.ids));
    if (uniqueIds.length === 0) {
      return { deleted: 0 };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      throw new Error("Not authorized");
    }

    const screenshots = await Promise.all(uniqueIds.map((id) => ctx.db.get(id)));
    const invalidScreenshot = screenshots.find(
      (screenshot) => !screenshot || screenshot.userId !== user._id
    );

    if (invalidScreenshot) {
      throw new Error("Not authorized");
    }

    const ownedScreenshots = screenshots.filter(
      (screenshot): screenshot is Doc<"screenshots"> => screenshot !== null
    );

    for (const screenshot of ownedScreenshots) {
      await deleteScreenshotRecord(ctx, screenshot);
    }

    return { deleted: ownedScreenshots.length };
  },
});

// Clean up expired screenshots (should be run as a cron job)
export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("screenshots")
      .withIndex("by_expiresAt")
      .filter((q) => q.lt(q.field("expiresAt"), now))
      .collect();

    for (const screenshot of expired) {
      await deleteScreenshotRecord(ctx, screenshot);
    }

    return { deleted: expired.length };
  },
});

function normalizeScreenshotTitle(title: string | undefined) {
  const trimmed = title?.trim();
  return trimmed ? trimmed : undefined;
}
