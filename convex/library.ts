import { query } from "./_generated/server";
import { v } from "convex/values";

export const getUserLibraryItems = query({
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

    const [screenshots, slideshows] = await Promise.all([
      ctx.db
        .query("screenshots")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .order("desc")
        .take(limit),
      ctx.db
        .query("slideshows")
        .withIndex("by_userId", (q) => q.eq("userId", user._id))
        .order("desc")
        .take(limit),
    ]);

    return [
      ...screenshots.map((screenshot) => ({
        kind: "screenshot" as const,
        _id: screenshot._id,
        title: screenshot.title,
        filename: screenshot.filename,
        mimeType: screenshot.mimeType,
        publicUrl: screenshot.publicUrl,
        sourceUrl: screenshot.sourceUrl,
        type: screenshot.type,
        createdAt: screenshot.createdAt,
        viewCount: screenshot.viewCount,
        shareToken: screenshot.shareToken,
        fileSize: screenshot.fileSize,
      })),
      ...slideshows.map((slideshow) => ({
        kind: "slideshow" as const,
        _id: slideshow._id,
        title: slideshow.title,
        filename: slideshow.title ?? `Slideshow ${new Date(slideshow.createdAt).toLocaleDateString("en-US")}`,
        mimeType: "image/slideshow",
        publicUrl: slideshow.coverPublicUrl,
        sourceUrl: slideshow.sourceUrl,
        type: "slideshow" as const,
        createdAt: slideshow.createdAt,
        viewCount: slideshow.viewCount,
        shareToken: slideshow.shareToken,
        frameCount: slideshow.frameCount,
        visibleFrameCount: slideshow.visibleFrameCount,
      })),
    ]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit);
  },
});
