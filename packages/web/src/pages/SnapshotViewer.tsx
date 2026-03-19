import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefCallback } from "react";
import { ImageEditor } from "../components/ImageEditor";
import { buildAppUrl } from "../lib/routes";
import "./SnapshotViewer.css";

type ViewMode = "info" | "console" | "network";
type MarkedSource = "console" | "network";

interface ConsoleEntry {
  ts: number;
  level: string;
  args?: string[];
}

interface NetworkEntry {
  method: string;
  url: string;
  status: number;
  type?: string;
  duration?: number;
  size?: number;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  requestBody?: string;
  responseBody?: string;
  responsePreview?: string;
  error?: string;
}

interface MarkedItem {
  id: string;
  source: MarkedSource;
  entryIndex: number;
  order: number;
  xPercent: number;
  yPercent: number;
}

interface MarkedView {
  version: 1;
  updatedAt: number;
  items: MarkedItem[];
}

interface HighlightItem extends MarkedItem {
  summary: string;
  subtitle: string;
}

const EMPTY_MARKED_VIEW: MarkedView = {
  version: 1,
  updatedAt: 0,
  items: [],
};

export default function SnapshotViewer() {
  const { shareToken } = useParams<{ shareToken: string }>();
  const navigate = useNavigate();
  const snapshotViewerState = useQuery(
    api.screenshots.getSnapshotViewerState,
    shareToken ? { shareToken } : "skip"
  );
  const screenshot = useQuery(
    api.screenshots.getScreenshotByShareToken,
    shareToken ? { shareToken } : "skip"
  );
  const incrementView = useMutation(api.screenshots.incrementViewCount);
  const persistMarkedView = useMutation(api.screenshots.saveMarkedView);
  const updateScreenshotTitle = useMutation(api.screenshots.updateScreenshotTitle);
  const viewIncremented = useRef(false);
  const initialViewSetRef = useRef(false);
  const lastShareTokenRef = useRef<string | undefined>(undefined);
  const canEdit = Boolean(snapshotViewerState?.canEdit);

  const [currentView, setCurrentView] = useState<ViewMode>("info");
  const [htmlContent, setHtmlContent] = useState("");
  const [consoleLogs, setConsoleLogs] = useState<ConsoleEntry[]>([]);
  const [networkLogs, setNetworkLogs] = useState<NetworkEntry[]>([]);
  const [consoleFilter, setConsoleFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [editMode, setEditMode] = useState(false);
  const [markMode, setMarkMode] = useState(false);
  const [displayImageUrl, setDisplayImageUrl] = useState<string | null>(null);
  const [editorSaveRequestToken, setEditorSaveRequestToken] = useState(0);
  const [savedMarkedView, setSavedMarkedView] = useState<MarkedView>(
    EMPTY_MARKED_VIEW
  );
  const [draftMarkedView, setDraftMarkedView] = useState<MarkedView>(
    EMPTY_MARKED_VIEW
  );
  const [activeMarkedId, setActiveMarkedId] = useState<string | null>(null);
  const [isSavingMarkedView, setIsSavingMarkedView] = useState(false);
  const [markNotice, setMarkNotice] = useState<string | null>(null);
  const [showAllConsoleEntries, setShowAllConsoleEntries] = useState(true);
  const [showAllNetworkEntries, setShowAllNetworkEntries] = useState(true);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [isSavingTitle, setIsSavingTitle] = useState(false);
  const [shareCopyState, setShareCopyState] = useState<"idle" | "copied" | "error">(
    "idle"
  );
  const [imageCopyState, setImageCopyState] = useState<"idle" | "copied" | "error">(
    "idle"
  );
  const [imagePaneRatio, setImagePaneRatio] = useState(() => {
    if (typeof window === "undefined") return 0.66;
    const stored = window.localStorage.getItem("snapshot-horizontal-split-ratio");
    const parsed = stored ? Number.parseFloat(stored) : NaN;
    return Number.isFinite(parsed) ? parsed : 0.66;
  });
  const [isResizing, setIsResizing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const localImageUrlRef = useRef<string | null>(null);

  const effectiveMarkedView = markMode ? draftMarkedView : savedMarkedView;
  const highlightItems = useMemo(
    () => buildHighlightItems(effectiveMarkedView, consoleLogs, networkLogs),
    [effectiveMarkedView, consoleLogs, networkLogs]
  );
  const savedHighlightItems = useMemo(
    () => buildHighlightItems(savedMarkedView, consoleLogs, networkLogs),
    [savedMarkedView, consoleLogs, networkLogs]
  );
  const consoleMarks = useMemo(
    () =>
      new Map(
        highlightItems
          .filter((item) => item.source === "console")
          .map((item) => [item.entryIndex, item] as const)
      ),
    [highlightItems]
  );
  const networkMarks = useMemo(
    () =>
      new Map(
        highlightItems
          .filter((item) => item.source === "network")
          .map((item) => [item.entryIndex, item] as const)
      ),
    [highlightItems]
  );
  const activeHighlight =
    highlightItems.find((item) => item.id === activeMarkedId) ?? null;
  const hasDraftChanges =
    markedViewSignature(savedMarkedView) !== markedViewSignature(draftMarkedView);
  const hasHighlights = highlightItems.length > 0;

  useEffect(() => {
    if (!shareToken) return;

    if (lastShareTokenRef.current !== shareToken) {
      lastShareTokenRef.current = shareToken;
      viewIncremented.current = false;
      initialViewSetRef.current = false;
    }

    if (viewIncremented.current) return;

    viewIncremented.current = true;
    incrementView({ shareToken, viewerToken: getSnapshotViewerToken() });
  }, [shareToken, incrementView]);

  useEffect(() => {
    if (!screenshot) return;
    setLoading(true);

    const fetches: Promise<void>[] = [];

    if (screenshot.htmlPublicUrl) {
      fetches.push(
        fetch(screenshot.htmlPublicUrl)
          .then((r) => (r.ok ? r.text() : ""))
          .then((t) => setHtmlContent(t))
          .catch(() => setHtmlContent(""))
      );
    } else {
      setHtmlContent("");
    }

    if (screenshot.consoleLogsUrl) {
      fetches.push(
        fetch(screenshot.consoleLogsUrl)
          .then((r) => (r.ok ? r.json() : []))
          .then((d) => setConsoleLogs(Array.isArray(d) ? d : []))
          .catch(() => setConsoleLogs([]))
      );
    } else {
      setConsoleLogs([]);
    }

    if (screenshot.networkLogsUrl) {
      fetches.push(
        fetch(screenshot.networkLogsUrl)
          .then((r) => (r.ok ? r.json() : []))
          .then((d) =>
            setNetworkLogs(Array.isArray(d) ? normalizeNetworkLogs(d) : [])
          )
          .catch(() => setNetworkLogs([]))
      );
    } else {
      setNetworkLogs([]);
    }

    Promise.all(fetches).finally(() => setLoading(false));
  }, [screenshot]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (event: MouseEvent) => {
      if (!contentRef.current) return;
      if (window.innerWidth <= 960) return;

      const rect = contentRef.current.getBoundingClientRect();
      const nextRatio = (event.clientX - rect.left) / rect.width;
      const clampedRatio = Math.min(0.8, Math.max(0.35, nextRatio));

      setImagePaneRatio(clampedRatio);
      window.localStorage.setItem(
        "snapshot-horizontal-split-ratio",
        clampedRatio.toString()
      );
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  useEffect(() => {
    if (!screenshot?.publicUrl) return;

    setDisplayImageUrl(screenshot.publicUrl);

    if (localImageUrlRef.current) {
      URL.revokeObjectURL(localImageUrlRef.current);
      localImageUrlRef.current = null;
    }
  }, [screenshot?.publicUrl]);

  useEffect(() => {
    return () => {
      if (localImageUrlRef.current) {
        URL.revokeObjectURL(localImageUrlRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!screenshot) return;
    const nextMarkedView = normalizeMarkedView(screenshot.markedView);
    setDraftTitle(screenshot.title ?? deriveSnapshotTitle(screenshot.filename, htmlContent));
    setIsEditingTitle(false);
    setIsSavingTitle(false);
    setSavedMarkedView(nextMarkedView);
    setDraftMarkedView(nextMarkedView);
    setMarkMode(false);
    setIsSavingMarkedView(false);
    setShowAllConsoleEntries(true);
    setShowAllNetworkEntries(true);
    setActiveMarkedId(nextMarkedView.items[0]?.id ?? null);
  }, [
    screenshot?._id,
    screenshot?.markedView?.updatedAt,
    screenshot?.title,
    screenshot?.filename,
    htmlContent,
  ]);

  useEffect(() => {
    if (!markNotice) return;
    const timeout = window.setTimeout(() => setMarkNotice(null), 2800);
    return () => window.clearTimeout(timeout);
  }, [markNotice]);

  useEffect(() => {
    if (shareCopyState === "idle") return;
    const timeout = window.setTimeout(() => setShareCopyState("idle"), 2000);
    return () => window.clearTimeout(timeout);
  }, [shareCopyState]);

  useEffect(() => {
    if (canEdit) return;

    setEditMode(false);
    setMarkMode(false);
  }, [canEdit]);

  useEffect(() => {
    if (!screenshot || loading || initialViewSetRef.current) return;

    const initialHighlight = savedHighlightItems[0];
    if (initialHighlight) {
      setCurrentView(initialHighlight.source === "console" ? "console" : "network");
      setActiveMarkedId(initialHighlight.id);
      initialViewSetRef.current = true;
      return;
    }

    const hasInfoData =
      Boolean(htmlContent) ||
      Boolean(screenshot.sourceUrl) ||
      Boolean(screenshot.deviceBrowser) ||
      Boolean(screenshot.deviceBrowserVersion) ||
      Boolean(screenshot.deviceOs) ||
      Boolean(screenshot.deviceNetworkSpeed) ||
      Boolean(screenshot.deviceCharging) ||
      Boolean(screenshot.deviceScreenWidth) ||
      Boolean(screenshot.deviceScreenHeight) ||
      Boolean(screenshot.captureTimestamp);

    if (hasInfoData) {
      setCurrentView("info");
    } else if (consoleLogs.length > 0) {
      setCurrentView("console");
    } else if (networkLogs.length > 0) {
      setCurrentView("network");
    }
    initialViewSetRef.current = true;
  }, [loading, screenshot, htmlContent, consoleLogs, networkLogs, savedHighlightItems]);

  if (screenshot === undefined || snapshotViewerState === undefined) {
    return (
      <div className="sv-loading-screen">
        <div className="sv-spinner" />
        <span>Loading snapshot…</span>
      </div>
    );
  }

  if (screenshot === null) {
    return (
      <div className="sv-error-screen">
        <h2>Snapshot not found</h2>
        <p>This snapshot may have expired or the link is invalid.</p>
      </div>
    );
  }

  const pageTitle = screenshot.title ?? deriveSnapshotTitle(screenshot.filename, htmlContent);

  const errorCount = consoleLogs.filter((log) => log.level === "error").length;
  const hasInfoData =
    Boolean(htmlContent) ||
    Boolean(screenshot.sourceUrl) ||
    Boolean(screenshot.deviceBrowser) ||
    Boolean(screenshot.deviceBrowserVersion) ||
    Boolean(screenshot.deviceOs) ||
    Boolean(screenshot.deviceNetworkSpeed) ||
    Boolean(screenshot.deviceCharging) ||
    Boolean(screenshot.deviceScreenWidth) ||
    Boolean(screenshot.deviceScreenHeight) ||
    Boolean(screenshot.captureTimestamp);
  const hasDiagnosticsPanel =
    Boolean(screenshot.consoleLogsUrl) ||
    Boolean(screenshot.networkLogsUrl) ||
    consoleLogs.length > 0 ||
    networkLogs.length > 0;

  const views: { key: ViewMode; label: string; disabled: boolean; badge?: number }[] =
    [
      {
        key: "info",
        label: "Info",
        disabled: !hasInfoData,
      },
      {
        key: "console",
        label: "Console",
        disabled: consoleLogs.length === 0,
        badge: errorCount > 0 ? errorCount : undefined,
      },
      {
        key: "network",
        label: "Network",
        disabled: networkLogs.length === 0,
        badge: networkLogs.length > 0 ? networkLogs.length : undefined,
      },
    ];

  const contentStyle = {
    "--sv-image-pane": `${imagePaneRatio * 100}%`,
  } as CSSProperties;

  const handleEditorSave = (blob: Blob) => {
    const nextUrl = URL.createObjectURL(blob);

    if (localImageUrlRef.current) {
      URL.revokeObjectURL(localImageUrlRef.current);
    }

    localImageUrlRef.current = nextUrl;
    setDisplayImageUrl(nextUrl);
    setEditMode(false);
  };

  const handleCopyImage = async () => {
    try {
      const imageUrl = displayImageUrl ?? screenshot?.publicUrl;
      if (!imageUrl) return;

      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error("Failed to fetch image");
      }

      const blob = await response.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type || "image/png"]: blob }),
      ]);
      setImageCopyState("copied");
    } catch (error) {
      console.error("Failed to copy image:", error);
      setImageCopyState("error");
    }
  };

  const handleActivateHighlight = (item: HighlightItem) => {
    setActiveMarkedId(item.id);
    setCurrentView(item.source === "console" ? "console" : "network");
  };

  async function handleSaveTitle() {
    if (!shareToken || !screenshot || !canEdit || isSavingTitle) return;

    const trimmedTitle = draftTitle.trim();
    const fallbackTitle = deriveSnapshotTitle(screenshot.filename, htmlContent);
    const normalizedTitle = trimmedTitle === fallbackTitle ? undefined : trimmedTitle;

    try {
      setIsSavingTitle(true);
      await updateScreenshotTitle({
        shareToken,
        title: normalizedTitle,
      });
      setDraftTitle(normalizedTitle ?? fallbackTitle);
      setIsEditingTitle(false);
      setMarkNotice("Title updated.");
    } catch (error) {
      console.error("Failed to update title:", error);
      setMarkNotice("We couldn’t update the title. Please try again.");
    } finally {
      setIsSavingTitle(false);
    }
  }

  const handleToggleMarkMode = () => {
    if (editMode || !canEdit) return;

    if (markMode && hasDraftChanges) {
      handleCancelMarkedView();
      return;
    }

    setMarkMode((current) => !current);
    setMarkNotice(null);
  };

  const handleMarkItem = (source: MarkedSource, entryIndex: number) => {
    const id = buildMarkedItemId(source, entryIndex);
    const existing = draftMarkedView.items.find((item) => item.id === id);

    if (existing) {
      setActiveMarkedId(existing.id);
      setCurrentView(source === "console" ? "console" : "network");
      return;
    }

    const nextItem: MarkedItem = {
      id,
      source,
      entryIndex,
      order: draftMarkedView.items.length + 1,
      xPercent: 0,
      yPercent: 0,
    };

    setMarkMode(true);
    setEditMode(false);
    setDraftMarkedView((current) =>
      normalizeMarkedView({
        ...current,
        items: [...current.items, nextItem],
      })
    );
    setActiveMarkedId(nextItem.id);
    setCurrentView(source === "console" ? "console" : "network");
    setMarkNotice(`Marked ${source === "console" ? "log" : "request"} #${entryIndex + 1}.`);
  };

  const handleRemoveMarkedItem = (itemId: string) => {
    setDraftMarkedView((current) =>
      normalizeMarkedView({
        ...current,
        items: current.items.filter((item) => item.id !== itemId),
      })
    );

    if (activeMarkedId === itemId) {
      const nextItem = highlightItems.find((item) => item.id !== itemId) ?? null;
      setActiveMarkedId(nextItem?.id ?? null);
    }
  };

  async function handleSaveMarkedView() {
    if (!shareToken || !canEdit) return;

    try {
      setIsSavingMarkedView(true);
      const result = await persistMarkedView({
        shareToken,
        markedView: normalizeMarkedView({
          ...draftMarkedView,
          updatedAt: Date.now(),
        }),
      });
      const nextView = normalizeMarkedView(result);
      setSavedMarkedView(nextView);
      setDraftMarkedView(nextView);
      setMarkMode(false);
      setActiveMarkedId(nextView.items[0]?.id ?? null);
      setShowAllConsoleEntries(true);
      setShowAllNetworkEntries(true);
      setMarkNotice(
        nextView.items.length > 0
          ? "Highlights saved."
          : "Highlights cleared from this shared snapshot."
      );
    } catch (error) {
      console.error("Failed to save marked view:", error);
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      setMarkNotice(
        message.includes("Could not find public function")
          ? "Highlights need the latest Convex functions deployed before they can be saved."
          : "We couldn’t save those highlights. Please try again."
      );
    } finally {
      setIsSavingMarkedView(false);
    }
  }

  function handleCancelMarkedView() {
    setDraftMarkedView(savedMarkedView);
    setMarkMode(false);
    setActiveMarkedId(savedMarkedView.items[0]?.id ?? null);
    setMarkNotice(null);
  }

  async function handleCopyShareLink() {
    if (!shareToken) return;

    try {
      await navigator.clipboard.writeText(buildAppUrl(`/snapshot/${shareToken}`));
      setShareCopyState("copied");
    } catch {
      setShareCopyState("error");
    }
  }

  return (
    <div className="sv-container">
      <div className="sv-toolbar">
        <div className="sv-toolbar-left">
          <div className="sv-toolbar-title">
            <div className="sv-title-row">
              {isEditingTitle ? (
                <>
                  <input
                    className="sv-title-input"
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
                    placeholder="Snapshot title"
                    autoFocus
                  />
                  <button
                    className="sv-title-action"
                    onClick={() => void handleSaveTitle()}
                    disabled={isSavingTitle}
                  >
                    {isSavingTitle ? "Saving..." : "Save"}
                  </button>
                  <button
                    className="sv-title-action sv-title-action-secondary"
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
                  <h1
                    onClick={() => navigate("/library")}
                    style={{ cursor: "pointer" }}
                    title="Go to Library"
                  >
                    📸 {pageTitle}
                  </h1>
                  {canEdit && (
                    <button
                      className="sv-title-edit"
                      onClick={() => {
                        setDraftTitle(pageTitle);
                        setIsEditingTitle(true);
                      }}
                    >
                      Edit title
                    </button>
                  )}
                </>
              )}
            </div>
            {screenshot.sourceUrl && (
              <div className="sv-subtitle">{screenshot.sourceUrl}</div>
            )}
          </div>
        </div>
        <div className="sv-toolbar-right">
          {markNotice && <span className="sv-inline-notice">{markNotice}</span>}
          <button
            className={`sv-share-btn${shareCopyState === "copied" ? " copied" : ""}${
              shareCopyState === "error" ? " error" : ""
            }`}
            onClick={() => void handleCopyShareLink()}
            type="button"
          >
            {shareCopyState === "copied"
              ? "Copied link"
              : shareCopyState === "error"
                ? "Copy failed"
                : "Share"}
          </button>
          <span className="sv-view-count">
            👁 {screenshot.viewCount} viewer{screenshot.viewCount !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div
        className={`sv-content${isResizing ? " is-resizing" : ""}${
          hasHighlights ? " has-highlights" : ""
        }${hasDiagnosticsPanel ? "" : " no-data-pane"}`}
        ref={contentRef}
        style={contentStyle}
      >
        <section className="sv-screenshot-card">
          <div className="sv-image-section">
            <div className={`sv-image-controls${editMode ? " is-inline" : ""}`}>
              {canEdit && (
                <>
                  <button
                    className={`sv-control-btn ${markMode ? "active" : ""}`}
                    onClick={handleToggleMarkMode}
                    disabled={editMode || isSavingMarkedView}
                  >
                    {markMode ? "Cancel Marking" : "🏷 Mark Mode"}
                  </button>
                  {markMode && (
                    <>
                      <button
                        className="sv-control-btn"
                        onClick={handleSaveMarkedView}
                        disabled={isSavingMarkedView}
                      >
                        {isSavingMarkedView ? "Saving..." : "💾 Save Highlights"}
                      </button>
                      <button
                        className="sv-control-btn"
                        onClick={handleCancelMarkedView}
                        disabled={isSavingMarkedView}
                      >
                        Cancel
                      </button>
                    </>
                  )}
                </>
              )}
              {canEdit && (
                <button
                  className={`sv-control-btn ${editMode ? "active" : ""}`}
                  onClick={() => {
                    if (markMode || !canEdit) return;

                    if (editMode) {
                      setEditorSaveRequestToken((token) => token + 1);
                      return;
                    }

                    setEditMode(true);
                  }}
                  disabled={markMode}
                >
                  {editMode ? "✓ Done Editing" : "✏️ Edit"}
                </button>
              )}
              <button
                className={`sv-control-btn${imageCopyState === "copied" ? " copied" : ""}${
                  imageCopyState === "error" ? " error" : ""
                }`}
                onClick={handleCopyImage}
              >
                {imageCopyState === "copied"
                  ? "📋 Copied"
                  : imageCopyState === "error"
                    ? "⚠️ Copy Failed"
                    : "📋 Copy Image"}
              </button>
              <a
                href={displayImageUrl ?? screenshot.publicUrl}
                download={screenshot.filename}
                className="sv-control-btn"
              >
                ⬇️ Download Image
              </a>
            </div>

            {editMode ? (
              <ImageEditor
                imageUrl={displayImageUrl ?? screenshot.publicUrl}
                onSave={handleEditorSave}
                onCancel={() => setEditMode(false)}
                showSaveButton={false}
                saveRequestToken={editorSaveRequestToken}
              />
            ) : (
              <div className="sv-image-viewer">
                <div className="sv-image-stage">
                  <img
                    src={displayImageUrl ?? screenshot.publicUrl}
                    alt="Screenshot"
                  />
                </div>
              </div>
            )}
          </div>
        </section>

        {hasDiagnosticsPanel && (
          <>
            <div
              className="sv-splitter"
              onMouseDown={() => setIsResizing(true)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize snapshot layout"
            >
              <div className="sv-splitter-handle" />
            </div>

            <section className="sv-data-card">
              {(hasHighlights || markMode) && (
                <HighlightsPanel
                  items={highlightItems}
                  activeMarkedId={activeMarkedId}
                  onActivate={handleActivateHighlight}
                />
              )}

              <div className="sv-view-controls">
                <div className="sv-view-toggle">
                  {views.map((view) => (
                    <button
                      key={view.key}
                      className={`sv-view-btn${currentView === view.key ? " active" : ""}`}
                      disabled={view.disabled}
                      onClick={() => setCurrentView(view.key)}
                    >
                      {view.label}
                      {view.badge && view.key === "console" && (
                        <span className="sv-tab-badge sv-tab-badge-error">
                          {view.badge}
                        </span>
                      )}
                      {view.badge && view.key === "network" && (
                        <span className="sv-tab-badge">{view.badge}</span>
                      )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sv-tab-content">
                {currentView === "info" && (
                  <InfoPanel
                    htmlContent={htmlContent}
                    sourceUrl={screenshot.sourceUrl}
                    deviceMeta={{
                      browser: screenshot.deviceBrowser,
                      browserVersion: screenshot.deviceBrowserVersion,
                      os: screenshot.deviceOs,
                      networkSpeed: screenshot.deviceNetworkSpeed,
                      charging: screenshot.deviceCharging,
                      browserMode: screenshot.deviceBrowserMode,
                      screenWidth: screenshot.deviceScreenWidth,
                      screenHeight: screenshot.deviceScreenHeight,
                      timestamp: screenshot.captureTimestamp,
                    }}
                    createdAt={screenshot._creationTime}
                  />
                )}
                {currentView === "console" && (
                  <ConsolePanel
                    logs={consoleLogs}
                    filter={consoleFilter}
                    onFilterChange={setConsoleFilter}
                    markedEntries={consoleMarks}
                    activeMarkedId={activeMarkedId}
                    activeEntryIndex={
                      activeHighlight?.source === "console"
                        ? activeHighlight.entryIndex
                        : null
                    }
                    showAllEntries={showAllConsoleEntries}
                    onToggleShowAll={() =>
                      setShowAllConsoleEntries((current) => !current)
                    }
                    markMode={markMode}
                    canEdit={canEdit}
                    onMark={handleMarkItem}
                    onUnmark={handleRemoveMarkedItem}
                    onActivateMarkedId={setActiveMarkedId}
                  />
                )}
                {currentView === "network" && (
                  <NetworkPanel
                    logs={networkLogs}
                    markedEntries={networkMarks}
                    activeMarkedId={activeMarkedId}
                    activeEntryIndex={
                      activeHighlight?.source === "network"
                        ? activeHighlight.entryIndex
                        : null
                    }
                    showAllEntries={showAllNetworkEntries}
                    onToggleShowAll={() =>
                      setShowAllNetworkEntries((current) => !current)
                    }
                    markMode={markMode}
                    canEdit={canEdit}
                    onMark={handleMarkItem}
                    onUnmark={handleRemoveMarkedItem}
                    onActivateMarkedId={setActiveMarkedId}
                  />
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function HighlightsPanel({
  items,
  activeMarkedId,
  onActivate,
}: {
  items: HighlightItem[];
  activeMarkedId: string | null;
  onActivate: (item: HighlightItem) => void;
}) {
  return (
    <div className="sv-highlights-panel">
      <div className="sv-highlights-header">
        <div>
          <strong>Highlights</strong>
          <span className="sv-highlights-count">
            {items.length} linked item{items.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="sv-highlights-empty">
          Mark a console log or network request to pin it in this list.
        </div>
      ) : (
        <div className="sv-highlights-list">
          {items.map((item) => (
            <button
              key={item.id}
              className={`sv-highlight-chip${
                activeMarkedId === item.id ? " active" : ""
              }`}
              onClick={() => onActivate(item)}
            >
              <span className="sv-highlight-order">{item.order}</span>
              <span className="sv-highlight-copy">
                <span className="sv-highlight-summary">{item.summary}</span>
                <span className="sv-highlight-subtitle">{item.subtitle}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function InfoPanel({
  htmlContent,
  sourceUrl,
  deviceMeta,
  createdAt,
}: {
  htmlContent: string;
  sourceUrl?: string;
  deviceMeta?: {
    browser?: string;
    browserVersion?: string;
    os?: string;
    networkSpeed?: string;
    charging?: string;
    browserMode?: string;
    screenWidth?: number;
    screenHeight?: number;
    timestamp?: string;
  };
  createdAt?: number;
}) {
  let pageTitle = "—";
  let pageUrl: string | null = null;
  let domain = "—";
  let description = "—";
  let ogImage: string | null = null;
  let siteName: string | null = null;

  if (htmlContent) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, "text/html");
    const getMeta = (attr: string, value: string) => {
      const el = doc.querySelector(`meta[${attr}="${value}"]`);
      return el?.getAttribute("content") ?? null;
    };

    pageTitle =
      doc.querySelector("title")?.textContent?.trim() ||
      getMeta("property", "og:title") ||
      "—";
    pageUrl = getMeta("property", "og:url") || getMeta("name", "url") || null;
    description =
      getMeta("name", "description") ||
      getMeta("property", "og:description") ||
      "—";
    ogImage = getMeta("property", "og:image");
    siteName = getMeta("property", "og:site_name");
  }

  if (!pageUrl && sourceUrl) pageUrl = sourceUrl;
  if (pageUrl) {
    try {
      domain = new URL(pageUrl).hostname;
    } catch {
      domain = pageUrl;
    }
  }

  const items: {
    label: string;
    value: string;
    visible?: boolean;
    icon?: string;
  }[] = [
    { label: "Title", value: pageTitle, icon: "🪪" },
    { label: "URL", value: pageUrl ?? "—", icon: "🌐" },
    { label: "Domain", value: domain, icon: "🏠" },
    { label: "Timestamp", value: formatDateTime(deviceMeta?.timestamp || createdAt), icon: "📅" },
    { label: "Description", value: description, icon: "📝" },
    { label: "Site Name", value: siteName ?? "N/A", icon: "🏷️" },
    { label: "OG Image", value: ogImage ?? "N/A", icon: "🖼️" },
    { label: "Network Speed", value: deviceMeta?.networkSpeed ?? "N/A", icon: "📡" },
    { label: "OS", value: deviceMeta?.os ?? "N/A", icon: "💻" },
    {
      label: "Browser",
      value:
        deviceMeta?.browser && deviceMeta?.browserVersion
          ? `${deviceMeta.browser} ${deviceMeta.browserVersion}`
          : deviceMeta?.browser ?? "N/A",
      icon: "🌍",
    },
    {
      label: "Screen Width",
      value:
        deviceMeta?.screenWidth != null ? `${deviceMeta.screenWidth}px` : "N/A",
      icon: "↔️",
    },
    {
      label: "Screen Height",
      value:
        deviceMeta?.screenHeight != null
          ? `${deviceMeta.screenHeight}px`
          : "N/A",
      icon: "↕️",
    },
    { label: "Browser Mode", value: deviceMeta?.browserMode ?? "Normal", icon: "🔒" },
    { label: "Charging Status", value: deviceMeta?.charging ?? "N/A", icon: "🔋" },
  ];

  return (
    <div className="sv-panel">
      <div className="sv-panel-content" style={{ padding: 0 }}>
        <div className="sv-info-banner">
          <span className="sv-info-banner-text">
            Hover fields to copy details. Logs and network requests can now be
            marked directly in mark mode without changing the screenshot image.
          </span>
        </div>

        <div className="sv-info-rows">
          {items
            .filter((item) => item.visible !== false)
            .map((item) => (
              <div className="sv-info-row" key={item.label}>
                <div className="sv-info-row-label">
                  {item.icon && <span className="sv-info-icon">{item.icon}</span>}
                  {item.label}
                </div>
                <CopyButton text={item.value} />
                <div className="sv-info-row-value">{item.value}</div>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

function ConsolePanel({
  logs,
  filter,
  onFilterChange,
  markedEntries,
  activeMarkedId,
  activeEntryIndex,
  showAllEntries,
  onToggleShowAll,
  markMode,
  canEdit,
  onMark,
  onUnmark,
  onActivateMarkedId,
}: {
  logs: ConsoleEntry[];
  filter: string;
  onFilterChange: (f: string) => void;
  markedEntries: Map<number, HighlightItem>;
  activeMarkedId: string | null;
  activeEntryIndex: number | null;
  showAllEntries: boolean;
  onToggleShowAll: () => void;
  markMode: boolean;
  canEdit: boolean;
  onMark: (source: MarkedSource, entryIndex: number) => void;
  onUnmark: (itemId: string) => void;
  onActivateMarkedId: (itemId: string) => void;
}) {
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const filters = ["all", "log", "warn", "error", "info", "debug"];
  const markedCount = markedEntries.size;

  const filtered = useMemo(() => {
    const entries = logs
      .map((entry, entryIndex) => ({
        entry,
        entryIndex,
        markedItem: markedEntries.get(entryIndex) ?? null,
      }))
      .filter(({ entry }) => filter === "all" || entry.level === filter);

    if (markedCount === 0) {
      return entries;
    }

    if (!showAllEntries) {
      return entries
        .filter(({ markedItem }) => markedItem !== null)
        .sort((a, b) => (a.markedItem!.order ?? 0) - (b.markedItem!.order ?? 0));
    }

    return entries.sort((a, b) => {
      if (a.markedItem && b.markedItem) return a.markedItem.order - b.markedItem.order;
      if (a.markedItem) return -1;
      if (b.markedItem) return 1;
      return a.entryIndex - b.entryIndex;
    });
  }, [logs, filter, markedEntries, markedCount, showAllEntries]);

  useEffect(() => {
    if (activeEntryIndex == null) return;
    rowRefs.current.get(activeEntryIndex)?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeEntryIndex]);

  const setRowRef = (entryIndex: number): RefCallback<HTMLDivElement> => (node) => {
    if (node) rowRefs.current.set(entryIndex, node);
    else rowRefs.current.delete(entryIndex);
  };

  return (
    <div className="sv-panel">
      <div className="sv-console-toolbar">
        {filters.map((currentFilter) => (
          <button
            key={currentFilter}
            className={`sv-console-filter${filter === currentFilter ? " active" : ""}`}
            onClick={() => onFilterChange(currentFilter)}
          >
            {currentFilter.charAt(0).toUpperCase() + currentFilter.slice(1)}
          </button>
        ))}
        {markedCount > 0 && (
          <button className="sv-console-focus-toggle" onClick={onToggleShowAll}>
            {showAllEntries ? "Show highlights" : `Show all ${logs.length}`}
          </button>
        )}
        <span className="sv-console-count">
          {filtered.length} of {logs.length} entries
        </span>
      </div>
      <div className="sv-panel-content">
        <div className="sv-console-entries">
          {filtered.length === 0 ? (
            <div className="sv-empty-msg">No console entries captured.</div>
          ) : (
            filtered.map(({ entry, entryIndex, markedItem }) => {
              const consoleText = (entry.args ?? []).join(" ");

              return (
                <div
                  key={`${entryIndex}-${entry.ts}`}
                  ref={setRowRef(entryIndex)}
                  className={`sv-console-entry level-${entry.level}${
                    markedItem ? " is-marked" : ""
                  }${markedItem?.id === activeMarkedId ? " is-active" : ""}`}
                  onClick={() => {
                    if (markedItem) {
                      onActivateMarkedId(markedItem.id);
                    }
                  }}
                >
                  <div className="sv-row-actions">
                    {consoleText && (
                      <IconCopyButton
                        text={consoleText}
                        className="sv-floating-icon-btn"
                        label={`Copy console entry ${entryIndex + 1}`}
                      />
                    )}
                    {markMode && canEdit && (
                      <button
                        className={`sv-mark-row-btn${markedItem ? " marked" : ""}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (markedItem) {
                            onUnmark(markedItem.id);
                            return;
                          }
                          onMark("console", entryIndex);
                        }}
                      >
                        {markedItem ? "Unmark" : "Mark"}
                      </button>
                    )}
                  </div>
                  <div className="sv-console-leading">
                    {markedItem ? (
                      <span className="sv-inline-badge">{markedItem.order}</span>
                    ) : (
                      <span className="sv-console-index">{entryIndex + 1}</span>
                    )}
                  </div>
                  <span className="sv-console-ts">{formatTimestamp(entry.ts)}</span>
                  <span className="sv-console-level">{entry.level}</span>
                  <span className="sv-console-args">{consoleText}</span>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

function NetworkPanel({
  logs,
  markedEntries,
  activeMarkedId,
  activeEntryIndex,
  showAllEntries,
  onToggleShowAll,
  markMode,
  canEdit,
  onMark,
  onUnmark,
  onActivateMarkedId,
}: {
  logs: NetworkEntry[];
  markedEntries: Map<number, HighlightItem>;
  activeMarkedId: string | null;
  activeEntryIndex: number | null;
  showAllEntries: boolean;
  onToggleShowAll: () => void;
  markMode: boolean;
  canEdit: boolean;
  onMark: (source: MarkedSource, entryIndex: number) => void;
  onUnmark: (itemId: string) => void;
  onActivateMarkedId: (itemId: string) => void;
}) {
  const [expandedEntryIndex, setExpandedEntryIndex] = useState<number | null>(null);
  const [detailTab, setDetailTab] = useState<Record<number, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [typeFilter, setTypeFilter] = useState("All");
  const [methodFilter, setMethodFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const rowRefs = useRef(new Map<number, HTMLTableRowElement>());
  const markedCount = markedEntries.size;

  useEffect(() => {
    if (activeEntryIndex == null) return;
    setExpandedEntryIndex(activeEntryIndex);
    rowRefs.current.get(activeEntryIndex)?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [activeEntryIndex]);

  const getResourceName = (url: string) => {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const filename = pathname.split("/").pop() || pathname || urlObj.hostname;
      return filename || url;
    } catch {
      return url;
    }
  };

  const getResourceType = (entry: NetworkEntry) => {
    const url = entry.url.toLowerCase();
    const contentType =
      entry.responseHeaders?.["content-type"]?.toLowerCase() || "";

    if (entry.type === "xhr" || entry.type === "fetch") return "xmlhttprequest";
    if (url.endsWith(".js") || contentType.includes("javascript")) return "script";
    if (url.endsWith(".css") || contentType.includes("css")) return "stylesheet";
    if (url.match(/\.(jpg|jpeg|png|gif|svg|webp|ico)$/i) || contentType.includes("image")) return "image";
    if (url.match(/\.(woff|woff2|ttf|otf|eot)$/i) || contentType.includes("font")) return "font";
    if (url.endsWith(".json") || contentType.includes("json")) return "fetch";
    if (url.includes(".mp4") || url.includes(".webm") || contentType.includes("video")) return "media";
    if (url.includes("manifest.json")) return "manifest";
    if (contentType.includes("html")) return "document";
    return "other";
  };

  const getInitiator = (entry: NetworkEntry) => {
    const referer =
      entry.requestHeaders?.referer || entry.requestHeaders?.Referer;
    if (referer) {
      try {
        return new URL(referer).origin;
      } catch {
        return referer;
      }
    }
    try {
      return new URL(entry.url).origin;
    } catch {
      return "Unknown";
    }
  };

  const filteredLogs = useMemo(() => {
    const rows = logs
      .map((entry, entryIndex) => ({
        entry,
        entryIndex,
        markedItem: markedEntries.get(entryIndex) ?? null,
        resourceName: getResourceName(entry.url),
        resourceType: getResourceType(entry),
        initiator: getInitiator(entry),
      }))
      .filter(({ entry, resourceType }) => {
        if (
          searchQuery &&
          !entry.url.toLowerCase().includes(searchQuery.toLowerCase())
        ) {
          return false;
        }
        if (errorsOnly && entry.status < 400 && entry.status !== 0) {
          return false;
        }
        if (typeFilter !== "All") {
          if (
            typeFilter === "Fetch/XHR" &&
            resourceType !== "xmlhttprequest" &&
            resourceType !== "fetch"
          ) {
            return false;
          }
          if (typeFilter === "JS" && resourceType !== "script") return false;
          if (typeFilter === "CSS" && resourceType !== "stylesheet") return false;
          if (
            typeFilter === "Media" &&
            resourceType !== "media" &&
            resourceType !== "image"
          ) {
            return false;
          }
          if (typeFilter === "Font" && resourceType !== "font") return false;
          if (typeFilter === "Doc" && resourceType !== "document") return false;
          if (typeFilter === "Manifest" && resourceType !== "manifest") {
            return false;
          }
          if (
            typeFilter === "Others" &&
            !["other", "ws"].includes(resourceType)
          ) {
            return false;
          }
        }
        if (methodFilter !== "All" && entry.method !== methodFilter) {
          return false;
        }
        if (statusFilter !== "All") {
          const statusCode = entry.status;
          if (statusFilter === "2xx" && (statusCode < 200 || statusCode >= 300)) {
            return false;
          }
          if (statusFilter === "3xx" && (statusCode < 300 || statusCode >= 400)) {
            return false;
          }
          if (statusFilter === "4xx" && (statusCode < 400 || statusCode >= 500)) {
            return false;
          }
          if (statusFilter === "5xx" && statusCode < 500) return false;
        }
        return true;
      });

    if (markedCount === 0) {
      return rows;
    }

    if (!showAllEntries) {
      return rows
        .filter(({ markedItem }) => markedItem !== null)
        .sort((a, b) => (a.markedItem!.order ?? 0) - (b.markedItem!.order ?? 0));
    }

    return rows.sort((a, b) => {
      if (a.markedItem && b.markedItem) return a.markedItem.order - b.markedItem.order;
      if (a.markedItem) return -1;
      if (b.markedItem) return 1;
      return a.entryIndex - b.entryIndex;
    });
  }, [
    logs,
    markedEntries,
    searchQuery,
    errorsOnly,
    typeFilter,
    methodFilter,
    statusFilter,
    markedCount,
    showAllEntries,
  ]);

  const totalSize = filteredLogs.reduce((sum, row) => sum + (row.entry.size ?? 0), 0);
  const avgDuration = filteredLogs.length
    ? Math.round(
        filteredLogs.reduce((sum, row) => sum + (row.entry.duration ?? 0), 0) /
          filteredLogs.length
      )
    : 0;

  const typeOptions = [
    "All",
    "Fetch/XHR",
    "WS",
    "JS",
    "CSS",
    "Media",
    "Font",
    "Doc",
    "Manifest",
    "Others",
  ];
  const methodOptions = ["All", ...Array.from(new Set(logs.map((log) => log.method)))];
  const statusOptions = ["All", "2xx", "3xx", "4xx", "5xx"];
  const columnSpan = markMode && canEdit ? 8 : 7;

  const setRowRef =
    (entryIndex: number): RefCallback<HTMLTableRowElement> =>
    (node) => {
      if (node) rowRefs.current.set(entryIndex, node);
      else rowRefs.current.delete(entryIndex);
    };

  return (
    <div className="sv-panel">
      <div className="sv-network-toolbar">
        <input
          type="text"
          placeholder="Search"
          className="sv-network-search"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />
        <label className="sv-network-checkbox">
          <input
            type="checkbox"
            checked={errorsOnly}
            onChange={(event) => setErrorsOnly(event.target.checked)}
          />
          Errors only
        </label>
        <div className="sv-network-filters">
          {typeOptions.map((type) => (
            <button
              key={type}
              data-label={type}
              className={`sv-filter-btn${typeFilter === type ? " active" : ""}`}
              onClick={() => setTypeFilter(type)}
            >
              <span>{type}</span>
            </button>
          ))}
        </div>
        <select
          className="sv-network-select"
          value={methodFilter}
          onChange={(event) => setMethodFilter(event.target.value)}
        >
          <option value="All">Method</option>
          {methodOptions.slice(1).map((method) => (
            <option key={method} value={method}>
              {method}
            </option>
          ))}
        </select>
        <select
          className="sv-network-select"
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
        >
          <option value="All">Status</option>
          {statusOptions.slice(1).map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
        {markedCount > 0 && (
          <button className="sv-console-focus-toggle" onClick={onToggleShowAll}>
            {showAllEntries ? "Show highlights" : `Show all ${logs.length}`}
          </button>
        )}
      </div>

      <div className="sv-network-summary-bar">
        <span className="sv-network-summary">
          {filteredLogs.length} requests • {formatSize(totalSize)} transferred •
          avg {formatDuration(avgDuration)}
        </span>
      </div>

      <div className="sv-panel-content">
        <table className="sv-network-table">
          <thead>
            <tr>
              <th style={{ width: "52px" }}>#</th>
              <th>Name</th>
              <th style={{ width: "80px" }}>Load Time</th>
              <th style={{ width: "80px" }}>Status</th>
              <th style={{ width: "80px" }}>Method</th>
              <th style={{ width: "120px" }}>Type</th>
              <th>Initiator</th>
              {markMode && canEdit && (
                <th className="sv-network-mark-col" style={{ width: "90px" }}>
                  Mark
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {filteredLogs.map(
              ({ entry, entryIndex, markedItem, resourceName, resourceType, initiator }) => {
                const isError = entry.status >= 400 || entry.status === 0;
                const isOpen = expandedEntryIndex === entryIndex;
                const activeTab = detailTab[entryIndex] ?? "headers";

                return (
                  <NetworkRow
                    key={`${entryIndex}-${entry.url}`}
                    rowRef={setRowRef(entryIndex)}
                    entry={entry}
                    entryIndex={entryIndex}
                    isError={isError}
                    isOpen={isOpen}
                    activeTab={activeTab}
                    resourceName={resourceName}
                    resourceType={resourceType}
                    initiator={initiator}
                    markedItem={markedItem}
                    isActive={markedItem?.id === activeMarkedId}
                    canMark={markMode && canEdit}
                    columnSpan={columnSpan}
                    onToggle={() =>
                      setExpandedEntryIndex(isOpen ? null : entryIndex)
                    }
                    onTabChange={(tab) =>
                      setDetailTab((current) => ({
                        ...current,
                        [entryIndex]: tab,
                      }))
                    }
                    onActivateMarkedId={onActivateMarkedId}
                    onMark={onMark}
                    onUnmark={onUnmark}
                  />
                );
              }
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function NetworkRow({
  rowRef,
  entry,
  entryIndex,
  isError,
  isOpen,
  activeTab,
  resourceName,
  resourceType,
  initiator,
  markedItem,
  isActive,
  canMark,
  columnSpan,
  onToggle,
  onTabChange,
  onActivateMarkedId,
  onMark,
  onUnmark,
}: {
  rowRef: RefCallback<HTMLTableRowElement>;
  entry: NetworkEntry;
  entryIndex: number;
  isError: boolean;
  isOpen: boolean;
  activeTab: string;
  resourceName: string;
  resourceType: string;
  initiator: string;
  markedItem: HighlightItem | null;
  isActive: boolean;
  canMark: boolean;
  columnSpan: number;
  onToggle: () => void;
  onTabChange: (tab: string) => void;
  onActivateMarkedId: (itemId: string) => void;
  onMark: (source: MarkedSource, entryIndex: number) => void;
  onUnmark: (itemId: string) => void;
}) {
  const getTypeIcon = (type: string) => {
    switch (type) {
      case "document":
        return "📄";
      case "script":
        return "📜";
      case "stylesheet":
        return "🎨";
      case "image":
        return "🖼️";
      case "font":
        return "🔤";
      case "media":
        return "🎬";
      case "xmlhttprequest":
      case "fetch":
        return "🌐";
      case "manifest":
        return "📋";
      case "ws":
        return "🔌";
      default:
        return "📦";
    }
  };

  const requestBody = entry.requestBody ? formatJsonContent(entry.requestBody) : null;
  const responseBody = getResponseBody(entry)
    ? formatJsonContent(getResponseBody(entry)!)
    : null;

  return (
    <>
      <tr
        ref={rowRef}
        className={`sv-network-row${isError ? " status-error" : ""}${
          markedItem ? " is-marked" : ""
        }${isActive ? " is-active" : ""}`}
        onClick={() => {
          if (markedItem) {
            onActivateMarkedId(markedItem.id);
          }
          onToggle();
        }}
      >
        <td style={{ textAlign: "center" }}>
          {markedItem ? (
            <span className="sv-inline-badge">{markedItem.order}</span>
          ) : (
            <span className="sv-network-index">{entryIndex + 1}</span>
          )}
        </td>
        <td className="sv-network-url" title={entry.url}>
          <span className="sv-network-type-icon">{getTypeIcon(resourceType)}</span>
          {resourceName}
        </td>
        <td>{formatDuration(entry.duration)}</td>
        <td>
          <span className={`sv-network-status ${statusClass(entry.status)}`}>
            {entry.status || "ERR"}
          </span>
        </td>
        <td>
          <span className="sv-network-method">{entry.method}</span>
        </td>
        <td>
          <span className="sv-network-type">{resourceType}</span>
        </td>
        <td className="sv-network-initiator" title={initiator}>
          {truncateUrl(initiator)}
        </td>
        {canMark && (
          <td className="sv-network-mark-col">
            <button
              className={`sv-mark-row-btn${markedItem ? " marked" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                if (markedItem) {
                  onUnmark(markedItem.id);
                  return;
                }
                onMark("network", entryIndex);
              }}
            >
              {markedItem ? "Unmark" : "Mark"}
            </button>
          </td>
        )}
      </tr>
      {isOpen && (
        <tr className="sv-network-detail open">
          <td colSpan={columnSpan}>
            <div className="sv-network-detail-content">
              <div className="sv-network-detail-tabs">
                {["headers", "request", "response"].map((tab) => (
                  <button
                    key={tab}
                    className={`sv-network-detail-tab${
                      activeTab === tab ? " active" : ""
                    }`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onTabChange(tab);
                    }}
                  >
                    {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  </button>
                ))}
              </div>
              <div className="sv-network-detail-section">
                {activeTab === "headers" && (
                  <>
                    <strong>Request Headers</strong>
                    {renderHeaders(entry.requestHeaders)}
                    <br />
                    <strong>Response Headers</strong>
                    {renderHeaders(entry.responseHeaders)}
                  </>
                )}
                {activeTab === "request" && (
                  <>
                    {requestBody && (
                      <IconCopyButton
                        text={requestBody}
                        className="sv-floating-icon-btn sv-network-detail-copy"
                        label={`Copy request body for ${resourceName}`}
                      />
                    )}
                    <pre>{requestBody ?? "No request body"}</pre>
                  </>
                )}
                {activeTab === "response" && (
                  <>
                    {responseBody && (
                      <IconCopyButton
                        text={responseBody}
                        className="sv-floating-icon-btn sv-network-detail-copy"
                        label={`Copy response body for ${resourceName}`}
                      />
                    )}
                    <pre>{responseBody ?? entry.error ?? "No response"}</pre>
                  </>
                )}
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* noop */
    }
  };

  return (
    <button
      className={`sv-copy-btn${copied ? " copied" : ""}`}
      onClick={handleCopy}
    >
      {copied ? "✓ Copied" : "Copy"}
    </button>
  );
}

function IconCopyButton({
  text,
  label,
  className = "",
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();

    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* noop */
    }
  };

  return (
    <button
      type="button"
      className={`sv-icon-copy-btn${copied ? " copied" : ""}${className ? ` ${className}` : ""}`}
      onClick={handleCopy}
      aria-label={copied ? `${label} copied` : label}
      title={copied ? "Copied" : "Copy"}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M7 3.75A2.25 2.25 0 0 1 9.25 1.5h6A2.25 2.25 0 0 1 17.5 3.75v8.5a2.25 2.25 0 0 1-2.25 2.25h-6A2.25 2.25 0 0 1 7 12.25z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M4.75 5.5h-.5A2.25 2.25 0 0 0 2 7.75v8A2.25 2.25 0 0 0 4.25 18h6.5A2.25 2.25 0 0 0 13 15.75v-.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      <path
        d="M4.75 10.5 8.5 14.25 15.25 5.75"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function normalizeMarkedView(markedView?: MarkedView | null): MarkedView {
  const items = [...(markedView?.items ?? [])]
    .sort((a, b) => a.order - b.order)
    .filter((item) => Number.isFinite(item.entryIndex))
    .reduce<MarkedItem[]>((accumulator, item) => {
      if (accumulator.some((existing) => existing.id === item.id)) {
        return accumulator;
      }
      accumulator.push({
        ...item,
        entryIndex: Math.max(0, Math.floor(item.entryIndex)),
        order: accumulator.length + 1,
        xPercent: clampPercent(item.xPercent),
        yPercent: clampPercent(item.yPercent),
      });
      return accumulator;
    }, []);

  return {
    version: 1,
    updatedAt: markedView?.updatedAt ?? 0,
    items,
  };
}

function buildHighlightItems(
  markedView: MarkedView,
  consoleLogs: ConsoleEntry[],
  networkLogs: NetworkEntry[]
): HighlightItem[] {
  return normalizeMarkedView(markedView).items.flatMap((item) => {
    if (item.source === "console") {
      const entry = consoleLogs[item.entryIndex];
      if (!entry) return [];
      const summary = truncateText((entry.args ?? []).join(" ") || "Console entry", 120);
      return [
        {
          ...item,
          summary,
          subtitle: `Console • ${entry.level.toUpperCase()} • ${formatTimestamp(
            entry.ts
          )}`,
        },
      ];
    }

    const entry = networkLogs[item.entryIndex];
    if (!entry) return [];
    return [
      {
        ...item,
        summary: `${entry.method} ${truncateUrl(entry.url)}`,
        subtitle: `Network • ${entry.status || "ERR"} • ${formatDuration(
          entry.duration
        )}`,
      },
    ];
  });
}

function deriveSnapshotTitle(filename: string, htmlContent: string) {
  if (htmlContent) {
    const htmlTitle = htmlContent.match(/<title>(.*?)<\/title>/i)?.[1]?.trim();
    if (htmlTitle) return htmlTitle;
  }

  return filename;
}

function getSnapshotViewerToken() {
  if (typeof window === "undefined") {
    return "server";
  }

  const storageKey = "snapshot-viewer-token";
  const existingToken = window.localStorage.getItem(storageKey);
  if (existingToken) return existingToken;

  const nextToken =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `viewer-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  window.localStorage.setItem(storageKey, nextToken);
  return nextToken;
}

function markedViewSignature(markedView: MarkedView) {
  return JSON.stringify(
    normalizeMarkedView(markedView).items.map((item) => ({
      id: item.id,
      source: item.source,
      entryIndex: item.entryIndex,
      order: item.order,
      xPercent: item.xPercent,
      yPercent: item.yPercent,
    }))
  );
}

function buildMarkedItemId(source: MarkedSource, entryIndex: number) {
  return `${source}:${entryIndex}`;
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function formatTimestamp(ts: number) {
  const date = new Date(ts);
  return (
    date.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }) +
    "." +
    String(date.getMilliseconds()).padStart(3, "0")
  );
}

function formatDateTime(ts?: string | number) {
  if (!ts) return "—";
  try {
    const date = typeof ts === "string" ? new Date(ts) : new Date(ts);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
  } catch {
    return "—";
  }
}

function formatSize(bytes?: number) {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function formatDuration(ms?: number) {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function statusClass(status: number) {
  if (!status || status === 0) return "s0";
  if (status < 300) return "s2xx";
  if (status < 400) return "s3xx";
  if (status < 500) return "s4xx";
  return "s5xx";
}

function truncateUrl(url: string) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    return path.length > 80
      ? parsed.host + path.slice(0, 77) + "…"
      : parsed.host + path;
  } catch {
    return url.length > 80 ? url.slice(0, 77) + "…" : url;
  }
}

function truncateText(text: string, maxLength: number) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function renderHeaders(headers?: Record<string, string>) {
  if (!headers || Object.keys(headers).length === 0) {
    return <em style={{ color: "#999" }}>None</em>;
  }

  return (
    <div>
      {Object.entries(headers).map(([key, value]) => (
        <div key={key} className="sv-header-line">
          <span className="sv-header-name">{key}</span>:{" "}
          <span className="sv-header-value">{value}</span>
        </div>
      ))}
    </div>
  );
}

function formatJsonContent(content: string) {
  try {
    return JSON.stringify(JSON.parse(content), null, 2);
  } catch {
    return content;
  }
}

function normalizeNetworkLogs(logs: unknown[]): NetworkEntry[] {
  return logs.map((entry) => {
    if (!entry || typeof entry !== "object") {
      return entry as NetworkEntry;
    }

    const typedEntry = entry as NetworkEntry;
    return {
      ...typedEntry,
      responseBody: typedEntry.responseBody ?? typedEntry.responsePreview,
    };
  });
}

function getResponseBody(entry: NetworkEntry) {
  return entry.responseBody ?? entry.responsePreview;
}
