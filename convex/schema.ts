import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const markedItem = v.object({
  id: v.string(),
  source: v.union(v.literal("console"), v.literal("network")),
  entryIndex: v.number(),
  order: v.number(),
  xPercent: v.number(),
  yPercent: v.number(),
});

const markedView = v.object({
  version: v.literal(1),
  updatedAt: v.number(),
  items: v.array(markedItem),
});

export default defineSchema({
  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_clerkId", ["clerkId"]),

  screenshots: defineTable({
    userId: v.id("users"),
    filename: v.string(),
    title: v.optional(v.string()),
    mimeType: v.string(),
    fileSize: v.number(),
    storageId: v.id("_storage"),
    publicUrl: v.string(),
    htmlStorageId: v.optional(v.id("_storage")),
    htmlPublicUrl: v.optional(v.string()),
    consoleLogsStorageId: v.optional(v.id("_storage")),
    consoleLogsUrl: v.optional(v.string()),
    networkLogsStorageId: v.optional(v.id("_storage")),
    networkLogsUrl: v.optional(v.string()),
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
    type: v.union(
      v.literal("screenshot"),
      v.literal("tab-recording"),
      v.literal("screen-recording")
    ),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    duration: v.optional(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
    shareToken: v.string(),
    isPublic: v.boolean(),
    viewCount: v.number(),
    viewerTokens: v.optional(v.array(v.string())),
    lastViewedAt: v.optional(v.number()),
    markedView: v.optional(markedView),
  })
    .index("by_userId", ["userId"])
    .index("by_shareToken", ["shareToken"])
    .index("by_expiresAt", ["expiresAt"]),
});
