import {
  mutation,
  query,
  internalMutation,
  type MutationCtx,
} from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { v } from "convex/values";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const slideshowFrameInput = v.object({
  storageId: v.id("_storage"),
  filename: v.string(),
  mimeType: v.string(),
  width: v.optional(v.number()),
  height: v.optional(v.number()),
  sourceUrl: v.optional(v.string()),
  captureTimestamp: v.optional(v.string()),
  hidden: v.boolean(),
  order: v.number(),
});

function generateShareToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeTitle(title: string | undefined) {
  const trimmed = title?.trim();
  return trimmed ? trimmed : undefined;
}

function withVisibleFrames<T extends { frames: Array<{ hidden: boolean }> }>(slideshow: T) {
  return {
    ...slideshow,
    frames: slideshow.frames.filter((frame) => !frame.hidden),
  };
}

export const uploadSlideshow = mutation({
  args: {
    title: v.optional(v.string()),
    frames: v.array(slideshowFrameInput),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user) {
      throw new Error("User not found");
    }

    if (args.frames.length === 0) {
      throw new Error("Slideshow must include at least one frame");
    }

    const orderedFrames = [...args.frames]
      .sort((a, b) => a.order - b.order)
      .map((frame, index) => ({
        ...frame,
        order: index + 1,
      }));

    const frames = await Promise.all(
      orderedFrames.map(async (frame) => {
        const publicUrl = await ctx.storage.getUrl(frame.storageId);
        if (!publicUrl) {
          throw new Error("Failed to get slideshow frame URL");
        }

        return {
          storageId: frame.storageId,
          publicUrl,
          filename: frame.filename,
          mimeType: frame.mimeType,
          width: frame.width,
          height: frame.height,
          sourceUrl: frame.sourceUrl,
          captureTimestamp: frame.captureTimestamp,
          hidden: frame.hidden,
          order: frame.order,
        };
      })
    );

    const visibleFrames = frames.filter((frame) => !frame.hidden);
    const coverFrame = visibleFrames[0] ?? frames[0];
    const now = Date.now();
    const expiresAt = now + THIRTY_DAYS_MS;
    const shareToken = generateShareToken();
    const derivedTitle =
      normalizeTitle(args.title) ??
      `Slideshow ${new Date(now).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`;

    const slideshowId = await ctx.db.insert("slideshows", {
      userId: user._id,
      title: derivedTitle,
      shareToken,
      coverPublicUrl: coverFrame.publicUrl,
      sourceUrl: coverFrame.sourceUrl,
      frameCount: frames.length,
      visibleFrameCount: visibleFrames.length,
      frames,
      createdAt: now,
      expiresAt,
      isPublic: true,
      viewCount: 0,
      viewerTokens: [],
    });

    return {
      id: slideshowId,
      shareToken,
      coverPublicUrl: coverFrame.publicUrl,
      frameCount: frames.length,
      visibleFrameCount: visibleFrames.length,
      expiresAt,
    };
  },
});

export const getSlideshowByShareToken = query({
  args: { shareToken: v.string() },
  handler: async (ctx, args) => {
    const slideshow = await ctx.db
      .query("slideshows")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!slideshow || slideshow.expiresAt < Date.now()) {
      return null;
    }

    return withVisibleFrames(slideshow);
  },
});

export const getSlideshowViewerState = query({
  args: { shareToken: v.string() },
  handler: async (ctx, args) => {
    const slideshow = await ctx.db
      .query("slideshows")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!slideshow || slideshow.expiresAt < Date.now()) {
      return null;
    }

    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        slideshow: withVisibleFrames(slideshow),
        canEdit: false,
      };
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    return {
      slideshow: withVisibleFrames(slideshow),
      canEdit: Boolean(user && slideshow.userId === user._id),
    };
  },
});

export const incrementSlideshowViewCount = mutation({
  args: {
    shareToken: v.string(),
    viewerToken: v.string(),
  },
  handler: async (ctx, args) => {
    const slideshow = await ctx.db
      .query("slideshows")
      .withIndex("by_shareToken", (q) => q.eq("shareToken", args.shareToken))
      .first();

    if (!slideshow) return;

    const identity = await ctx.auth.getUserIdentity();
    if (identity) {
      const user = await ctx.db
        .query("users")
        .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
        .first();

      if (user && slideshow.userId === user._id) {
        return;
      }
    }

    const existingViewerTokens = slideshow.viewerTokens ?? [];
    if (existingViewerTokens.includes(args.viewerToken)) {
      return;
    }

    const nextViewCount =
      Math.max(slideshow.viewCount, existingViewerTokens.length) + 1;

    await ctx.db.patch(slideshow._id, {
      viewCount: nextViewCount,
      viewerTokens: [...existingViewerTokens, args.viewerToken],
      lastViewedAt: Date.now(),
    });
  },
});

async function deleteSlideshowRecord(
  ctx: MutationCtx,
  slideshow: Doc<"slideshows">
) {
  for (const frame of slideshow.frames) {
    await ctx.storage.delete(frame.storageId).catch(() => {});
  }

  await ctx.db.delete(slideshow._id);
}

export const deleteSlideshow = mutation({
  args: { id: v.id("slideshows") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not authenticated");
    }

    const slideshow = await ctx.db.get(args.id);
    if (!slideshow) {
      throw new Error("Slideshow not found");
    }

    const user = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .first();

    if (!user || slideshow.userId !== user._id) {
      throw new Error("Not authorized");
    }

    await deleteSlideshowRecord(ctx, slideshow);
  },
});

export const cleanupExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("slideshows")
      .withIndex("by_expiresAt")
      .filter((q) => q.lt(q.field("expiresAt"), now))
      .collect();

    for (const slideshow of expired) {
      await deleteSlideshowRecord(ctx, slideshow);
    }

    return { deleted: expired.length };
  },
});
