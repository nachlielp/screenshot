import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "@convex/_generated/api";
import { buildAppUrl } from "../lib/routes";
import "./SlideshowViewer.css";

interface SlideshowFrame {
  publicUrl: string;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
  sourceUrl?: string;
  captureTimestamp?: string;
  hidden: boolean;
  order: number;
}

interface SlideshowData {
  title?: string;
  shareToken: string;
  coverPublicUrl: string;
  sourceUrl?: string;
  frameCount: number;
  visibleFrameCount: number;
  frames: SlideshowFrame[];
  viewCount: number;
  createdAt: number;
}

export default function SlideshowViewer() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const slideshow = useQuery(
    api.slideshows.getSlideshowByShareToken,
    shareToken ? { shareToken } : "skip"
  ) as SlideshowData | null | undefined;
  const viewerState = useQuery(
    api.slideshows.getSlideshowViewerState,
    shareToken ? { shareToken } : "skip"
  );
  const incrementView = useMutation(api.slideshows.incrementSlideshowViewCount);
  const updateSlideshowTitle = useMutation(api.slideshows.updateSlideshowTitle);
  const viewIncrementedRef = useRef(false);
  const lastShareTokenRef = useRef<string | undefined>(undefined);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [shareState, setShareState] = useState<"idle" | "copied" | "error">("idle");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [titleNotice, setTitleNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!shareToken) return;

    if (lastShareTokenRef.current !== shareToken) {
      lastShareTokenRef.current = shareToken;
      viewIncrementedRef.current = false;
    }

    if (viewIncrementedRef.current) return;
    viewIncrementedRef.current = true;
    incrementView({ shareToken, viewerToken: getSlideshowViewerToken() });
  }, [incrementView, shareToken]);

  useEffect(() => {
    setCurrentIndex(0);
  }, [slideshow?.shareToken]);

  const frames = slideshow?.frames ?? [];
  const currentFrame = frames[currentIndex] ?? null;
  const canEdit = Boolean(viewerState?.canEdit);
  const pageTitle = slideshow ? slideshow.title ?? deriveSlideshowTitle(slideshow.createdAt) : "Slideshow";

  const subtitle = useMemo(() => {
    if (!slideshow) return "";
    return `${slideshow.visibleFrameCount} visible frame${slideshow.visibleFrameCount !== 1 ? "s" : ""} • ${slideshow.viewCount} viewer${slideshow.viewCount !== 1 ? "s" : ""}`;
  }, [slideshow]);

  useEffect(() => {
    if (!slideshow) return;
    setDraftTitle(pageTitle);
  }, [pageTitle, slideshow]);

  const copyShareLink = async () => {
    if (!shareToken) return;

    try {
      await navigator.clipboard.writeText(buildAppUrl(`/slideshow/${shareToken}`));
      setShareState("copied");
    } catch {
      setShareState("error");
    } finally {
      window.setTimeout(() => setShareState("idle"), 1800);
    }
  };

  const handleSaveTitle = async () => {
    if (!shareToken || !slideshow || !canEdit || isSavingTitle) return;

    const trimmedTitle = draftTitle.trim();
    const fallbackTitle = deriveSlideshowTitle(slideshow.createdAt);
    const normalizedTitle = trimmedTitle === fallbackTitle ? undefined : trimmedTitle || undefined;

    try {
      setIsSavingTitle(true);
      await updateSlideshowTitle({
        shareToken,
        title: normalizedTitle,
      });
      setDraftTitle(normalizedTitle ?? fallbackTitle);
      setIsEditingTitle(false);
      setTitleNotice("Title updated.");
    } catch (error) {
      console.error("Failed to update slideshow title:", error);
      setTitleNotice("We couldn’t update the title. Please try again.");
    } finally {
      setIsSavingTitle(false);
    }
  };

  if (slideshow === undefined || viewerState === undefined) {
    return (
      <div className="ssv-loading">
        <div className="ssv-spinner" />
        <span>Loading slideshow…</span>
      </div>
    );
  }

  if (slideshow === null) {
    return (
      <div className="ssv-empty">
        <h1>Slideshow not found</h1>
        <p>This slideshow may have expired or the link is invalid.</p>
      </div>
    );
  }

  if (frames.length === 0) {
    return (
      <div className="ssv-empty">
        <h1>{pageTitle}</h1>
        <p>This slideshow has no visible frames.</p>
      </div>
    );
  }

  return (
    <div className="ssv-page">
      <header className="ssv-header">
        <div>
          <div className="ssv-title-row">
            {isEditingTitle ? (
              <>
                <input
                  className="ssv-title-input"
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void handleSaveTitle();
                    }
                    if (event.key === "Escape") {
                      setDraftTitle(pageTitle);
                      setIsEditingTitle(false);
                    }
                  }}
                  placeholder="Slideshow title"
                  autoFocus
                />
                <button
                  type="button"
                  className="ssv-title-action"
                  onClick={() => void handleSaveTitle()}
                  disabled={isSavingTitle}
                >
                  {isSavingTitle ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="ssv-title-action ssv-title-action-secondary"
                  onClick={() => {
                    setDraftTitle(pageTitle);
                    setIsEditingTitle(false);
                  }}
                  disabled={isSavingTitle}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <h1>{pageTitle}</h1>
                {canEdit && (
                  <button
                    type="button"
                    className="ssv-title-edit"
                    onClick={() => {
                      setDraftTitle(pageTitle);
                      setIsEditingTitle(true);
                      setTitleNotice(null);
                    }}
                  >
                    Edit title
                  </button>
                )}
              </>
            )}
          </div>
          <p>{subtitle}</p>
          {titleNotice && <span className="ssv-owner-note">{titleNotice}</span>}
          {canEdit && slideshow.visibleFrameCount < slideshow.frameCount && (
            <span className="ssv-owner-note">Hidden frames are excluded from the shared view.</span>
          )}
        </div>
        <button
          type="button"
          className={`ssv-share-btn${shareState !== "idle" ? ` ${shareState}` : ""}`}
          onClick={copyShareLink}
        >
          {shareState === "copied"
            ? "Copied"
            : shareState === "error"
              ? "Copy failed"
              : "Copy share link"}
        </button>
      </header>

      <main className="ssv-content">
        <div className="ssv-stage">
          <div className="ssv-frame-shell">
            <img
              src={currentFrame?.publicUrl}
              alt={currentFrame?.filename}
              className="ssv-frame"
            />
          </div>
          <div className="ssv-controls">
            <button
              type="button"
              className="ssv-nav-btn"
              onClick={() => setCurrentIndex((index) => Math.max(0, index - 1))}
              disabled={currentIndex === 0}
            >
              Previous
            </button>
            <span className="ssv-index">
              Frame {currentIndex + 1} of {frames.length}
            </span>
            <button
              type="button"
              className="ssv-nav-btn"
              onClick={() => setCurrentIndex((index) => Math.min(frames.length - 1, index + 1))}
              disabled={currentIndex === frames.length - 1}
            >
              Next
            </button>
          </div>
        </div>

        <aside className="ssv-sidebar">
          <div className="ssv-sidebar-card">
            <h2>Frames</h2>
            <div className="ssv-thumbnails">
              {frames.map((frame, index) => (
                <button
                  key={`${frame.order}-${frame.publicUrl}`}
                  type="button"
                  className={`ssv-thumb-btn${index === currentIndex ? " active" : ""}`}
                  onClick={() => setCurrentIndex(index)}
                >
                  <img src={frame.publicUrl} alt={frame.filename} />
                  <span>{index + 1}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="ssv-sidebar-card">
            <h2>Details</h2>
            <dl className="ssv-details">
              <div>
                <dt>Created</dt>
                <dd>{formatDate(slideshow.createdAt)}</dd>
              </div>
              {currentFrame?.captureTimestamp && (
                <div>
                  <dt>Captured</dt>
                  <dd>{formatTimestamp(currentFrame.captureTimestamp)}</dd>
                </div>
              )}
              {currentFrame?.sourceUrl && (
                <div>
                  <dt>Source</dt>
                  <dd>{currentFrame.sourceUrl}</dd>
                </div>
              )}
              {currentFrame?.width && currentFrame?.height && (
                <div>
                  <dt>Size</dt>
                  <dd>
                    {currentFrame.width} × {currentFrame.height}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </aside>
      </main>
    </div>
  );
}

function deriveSlideshowTitle(createdAt: number) {
  return `Slideshow ${new Date(createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  })}`;
}

function getSlideshowViewerToken() {
  if (typeof window === "undefined") return "server";

  const key = "slideshow-viewer-token";
  const existing = window.localStorage.getItem(key);
  if (existing) return existing;

  const viewerToken =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  window.localStorage.setItem(key, viewerToken);
  return viewerToken;
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatTimestamp(timestamp: string) {
  try {
    return new Date(timestamp).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return timestamp;
  }
}
