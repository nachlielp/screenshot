// Temporary seed for verifying the agent API / skill end-to-end. Delete after use.
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export const insertRow = internalMutation({
  args: {
    storageId: v.id("_storage"),
    consoleLogsStorageId: v.id("_storage"),
    networkLogsStorageId: v.id("_storage"),
    publicUrl: v.string(),
    consoleLogsUrl: v.string(),
    networkLogsUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const userId = await ctx.db.insert("users", {
      clerkId: "seed-test-user",
      email: "seed@example.com",
      createdAt: Date.now(),
    });
    await ctx.db.insert("screenshots", {
      userId,
      filename: "checkout-bug.png",
      title: "Checkout button does nothing on click",
      mimeType: "image/png",
      fileSize: 68,
      storageId: args.storageId,
      publicUrl: args.publicUrl,
      consoleLogsStorageId: args.consoleLogsStorageId,
      consoleLogsUrl: args.consoleLogsUrl,
      networkLogsStorageId: args.networkLogsStorageId,
      networkLogsUrl: args.networkLogsUrl,
      sourceUrl: "https://shop.example.com/checkout",
      deviceBrowser: "Chrome",
      deviceBrowserVersion: "126.0",
      deviceOs: "macOS",
      deviceViewportWidth: 1440,
      deviceViewportHeight: 900,
      captureTimestamp: new Date().toISOString(),
      type: "screenshot",
      width: 1,
      height: 1,
      createdAt: Date.now(),
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      shareToken: "seedtoken1234567890abcdef1234567",
      isPublic: true,
      viewCount: 0,
      viewerTokens: [],
      hiddenLogEntries: { console: [1], network: [0] },
    });
  },
});

export const seed = internalAction({
  args: {},
  handler: async (ctx) => {
    const pngBytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
    const storageId = await ctx.storage.store(
      new Blob([pngBytes], { type: "image/png" })
    );
    const consoleLogs = [
      { ts: 1719900001000, level: "log", args: ["cart loaded: 3 items"] },
      { ts: 1719900001500, level: "debug", args: ["HIDDEN: internal noise"] },
      {
        ts: 1719900002000,
        level: "error",
        args: [
          "Uncaught TypeError: Cannot read properties of undefined (reading 'total') at submitOrder (checkout.js:214)",
        ],
      },
      { ts: 1719900002100, level: "warn", args: ["retrying payment intent"] },
    ];
    const networkLogs = [
      { method: "GET", url: "https://shop.example.com/hidden-tracker", status: 200 },
      {
        method: "POST",
        url: "https://api.shop.example.com/v2/payment-intents",
        status: 500,
        duration: 321,
        responsePreview: '{"error":"missing field: cart_total"}',
      },
      { method: "GET", url: "https://shop.example.com/assets/app.js", status: 200, duration: 45 },
    ];
    const consoleLogsStorageId = await ctx.storage.store(
      new Blob([JSON.stringify(consoleLogs)], { type: "application/json" })
    );
    const networkLogsStorageId = await ctx.storage.store(
      new Blob([JSON.stringify(networkLogs)], { type: "application/json" })
    );
    await ctx.runMutation(internal.seedTest.insertRow, {
      storageId,
      consoleLogsStorageId,
      networkLogsStorageId,
      publicUrl: (await ctx.storage.getUrl(storageId))!,
      consoleLogsUrl: (await ctx.storage.getUrl(consoleLogsStorageId))!,
      networkLogsUrl: (await ctx.storage.getUrl(networkLogsStorageId))!,
    });
    return "seeded";
  },
});

export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const screenshot = await ctx.db
      .query("screenshots")
      .withIndex("by_shareToken", (q) =>
        q.eq("shareToken", "seedtoken1234567890abcdef1234567")
      )
      .first();
    if (screenshot) {
      await ctx.storage.delete(screenshot.storageId).catch(() => {});
      if (screenshot.consoleLogsStorageId)
        await ctx.storage.delete(screenshot.consoleLogsStorageId).catch(() => {});
      if (screenshot.networkLogsStorageId)
        await ctx.storage.delete(screenshot.networkLogsStorageId).catch(() => {});
      await ctx.db.delete(screenshot._id);
    }
    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", "seed-test-user"))
      .first();
    if (user) await ctx.db.delete(user._id);
  },
});
