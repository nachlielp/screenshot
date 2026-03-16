import {
  SignInButton,
  SignedIn,
  SignedOut,
  UserButton,
  useUser,
} from "@clerk/clerk-react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@convex/_generated/api";
import { useState, useEffect, useCallback } from "react";
import type { Id } from "@convex/_generated/dataModel";
import ConfirmDialog from "../components/ConfirmDialog";
import { buildAppUrl } from "../lib/routes";
import "./Library.css";

export default function Library() {
  return (
    <>
      <SignedOut>
        <UnauthenticatedView />
      </SignedOut>
      <SignedIn>
        <AuthenticatedLibrary />
      </SignedIn>
    </>
  );
}

function UnauthenticatedView() {
  return (
    <div className="lib-unauth">
      <div className="lib-unauth-card">
        <h1>📸 Screenshot</h1>
        <p>Sign in to view your capture library</p>
        <SignInButton mode="modal">
          <button className="lib-signin-btn">Sign in with Google</button>
        </SignInButton>
      </div>
    </div>
  );
}

interface Screenshot {
  _id: Id<"screenshots">;
  filename: string;
  title?: string;
  mimeType: string;
  fileSize: number;
  publicUrl: string;
  htmlPublicUrl?: string;
  consoleLogsUrl?: string;
  networkLogsUrl?: string;
  sourceUrl?: string;
  type: "screenshot" | "tab-recording" | "screen-recording";
  createdAt: number;
  viewCount: number;
  shareToken: string;
}

interface ConfirmState {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
}

const LIBRARY_GROUPING_STORAGE_KEY = "library-grouping";

function getStoredLibraryGrouping(): "none" | "date" | "domain" {
  if (typeof window === "undefined") return "none";

  const stored = window.localStorage.getItem(LIBRARY_GROUPING_STORAGE_KEY);
  if (stored === "date" || stored === "domain" || stored === "none") {
    return stored;
  }

  return "none";
}

function AuthenticatedLibrary() {
  const { user } = useUser();
  const screenshots = useQuery(api.screenshots.getUserScreenshots, {
    limit: 100,
  }) as Screenshot[] | undefined;
  const deleteScreenshot = useMutation(api.screenshots.deleteScreenshot);
  const deleteScreenshots = useMutation(api.screenshots.deleteScreenshots);

  const [currentGrouping, setCurrentGrouping] = useState<
    "none" | "date" | "domain"
  >(getStoredLibraryGrouping);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const groupedScreenshots = screenshots
    ? groupScreenshots(screenshots, currentGrouping)
    : [];
  const orderedScreenshots = groupedScreenshots.flatMap((group) => group.items);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const closeConfirm = useCallback(() => {
    if (confirmBusy) return;
    setConfirmState(null);
  }, [confirmBusy]);

  const runConfirmAction = useCallback(async () => {
    if (!confirmState) return;
    setConfirmBusy(true);
    try {
      await confirmState.onConfirm();
      setConfirmState(null);
    } finally {
      setConfirmBusy(false);
    }
  }, [confirmState]);

  const handleDelete = (id: Id<"screenshots">) => {
    setConfirmState({
      title: "Delete capture?",
      description:
        "This capture will be removed from your library and can’t be restored.",
      confirmLabel: "Delete capture",
      onConfirm: async () => {
        try {
          await deleteScreenshot({ id });
          showToast("✓ Capture deleted");
        } catch {
          showToast("Failed to delete capture");
        }
      },
    });
  };

  const handleBatchDelete = () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    setConfirmState({
      title: `Delete ${count} capture${count > 1 ? "s" : ""}?`,
      description:
        "This permanently removes the selected captures from your library.",
      confirmLabel: `Delete ${count}`,
      onConfirm: async () => {
        try {
          const ids = Array.from(selectedIds) as Id<"screenshots">[];
          const { deleted } = await deleteScreenshots({ ids });
          setSelectedIds(new Set());
          setSelectMode(false);
          showToast(`✓ Deleted ${deleted} capture${deleted > 1 ? "s" : ""}`);
        } catch {
          showToast("Failed to delete selected captures");
        }
      },
    });
  };

  const toggleSelection = (id: string, shiftKey: boolean = false) => {
    if (shiftKey && lastSelectedId && orderedScreenshots.length > 0) {
      // Find indices of last selected and current item
      const lastIndex = orderedScreenshots.findIndex(
        (s) => s._id === lastSelectedId
      );
      const currentIndex = orderedScreenshots.findIndex((s) => s._id === id);

      if (lastIndex !== -1 && currentIndex !== -1) {
        // Select all items in the range
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const rangeIds = orderedScreenshots
          .slice(start, end + 1)
          .map((s) => s._id);

        setSelectedIds((prev) => {
          const next = new Set(prev);
          rangeIds.forEach((rangeId) => next.add(rangeId));
          return next;
        });
        setLastSelectedId(id);
        return;
      }
    }

    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setLastSelectedId(id);
  };

  const selectAll = () => {
    if (!screenshots) return;
    setSelectedIds(new Set(screenshots.map((s) => s._id)));
  };

  const openSnapshot = (screenshot: Screenshot) => {
    window.open(buildAppUrl(`/snapshot/${screenshot.shareToken}`), "_blank");
  };

  const copyShareLink = async (screenshot: Screenshot) => {
    const url = buildAppUrl(`/snapshot/${screenshot.shareToken}`);
    try {
      await navigator.clipboard.writeText(url);
      showToast("✓ Link copied to clipboard!");
    } catch {
      showToast("Failed to copy link");
    }
  };

  // Close group menu on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!(e.target as Element).closest(".lib-grouping-controls")) {
        setShowGroupMenu(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      LIBRARY_GROUPING_STORAGE_KEY,
      currentGrouping
    );
  }, [currentGrouping]);

  if (screenshots === undefined) {
    return (
      <div className="lib-page">
        <div className="lib-loading">Loading your captures…</div>
      </div>
    );
  }

  return (
    <div className="lib-page">
      {/* Header */}
      <header className="lib-header">
        <div className="lib-header-top">
          <div className="lib-header-left">
            <h1>📸 Capture Library</h1>
            <p className="lib-subtitle">
              {screenshots.length} capture{screenshots.length !== 1 ? "s" : ""}
            </p>
          </div>
          <div className="lib-header-right">
            <div className="lib-user-info">
              <span>{user?.primaryEmailAddress?.emailAddress}</span>
              <UserButton />
            </div>
          </div>
        </div>
        <div className="lib-toolbar">
          <div className="lib-toolbar-left">
            {!selectMode ? (
              <button
                className="lib-btn lib-btn-outline"
                onClick={() => setSelectMode(true)}
              >
                Select
              </button>
            ) : (
              <>
                <button className="lib-btn lib-btn-outline" onClick={selectAll}>
                  Select All
                </button>
                <button
                  className="lib-btn lib-btn-danger"
                  onClick={handleBatchDelete}
                  disabled={selectedIds.size === 0}
                >
                  Delete ({selectedIds.size})
                </button>
                <button
                  className="lib-btn lib-btn-outline"
                  onClick={() => {
                    setSelectMode(false);
                    setSelectedIds(new Set());
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
          <div className="lib-toolbar-right">
            <div className="lib-grouping-controls">
              <button
                className="lib-btn lib-btn-outline"
                onClick={() => setShowGroupMenu((p) => !p)}
              >
                Group: {currentGrouping === "none" ? "None" : currentGrouping}
              </button>
              {showGroupMenu && (
                <div className="lib-grouping-menu">
                  {(["none", "date", "domain"] as const).map((g) => (
                    <button
                      key={g}
                      className={`lib-grouping-option${currentGrouping === g ? " active" : ""}`}
                      onClick={() => {
                        setCurrentGrouping(g);
                        setShowGroupMenu(false);
                      }}
                    >
                      {g === "none" ? "No grouping" : `By ${g}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Content */}
      {screenshots.length === 0 ? (
        <div className="lib-empty">
          <h2>No captures yet</h2>
          <p>
            Install the Screenshot Chrome extension and start recording or taking
            screenshots!
          </p>
        </div>
      ) : (
          <div className="lib-content">
            {groupedScreenshots.map((group, index) => (
              <GroupSection
                key={group.label}
                label={group.label}
                screenshots={group.items}
                selectMode={selectMode}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelection}
                onDelete={handleDelete}
                onOpen={openSnapshot}
                onCopyLink={copyShareLink}
                showLabel={currentGrouping !== "none"}
                groupIndex={index}
              />
            ))}
          </div>
      )}

      {/* Toast */}
      {toast && <div className="lib-toast">{toast}</div>}

      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.title ?? ""}
        description={confirmState?.description ?? ""}
        confirmLabel={confirmState?.confirmLabel ?? "Confirm"}
        cancelLabel="Cancel"
        tone="danger"
        busy={confirmBusy}
        onConfirm={runConfirmAction}
        onCancel={closeConfirm}
      />
    </div>
  );
}

function GroupSection({
  label,
  screenshots,
  selectMode,
  selectedIds,
  onToggleSelect,
  onDelete,
  onOpen,
  onCopyLink,
  showLabel,
  groupIndex,
}: {
  label: string;
  screenshots: Screenshot[];
  selectMode: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string, shiftKey?: boolean) => void;
  onDelete: (id: Id<"screenshots">) => void;
  onOpen: (s: Screenshot) => void;
  onCopyLink: (s: Screenshot) => void;
  showLabel: boolean;
  groupIndex: number;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div
      className={`lib-group${
        showLabel ? ` ${groupIndex % 2 === 0 ? "lib-group-band-light" : "lib-group-band-dark"}` : ""
      }`}
    >
      {showLabel && (
        <div
          className={`lib-group-header${collapsed ? " collapsed" : ""}`}
          onClick={() => setCollapsed((p) => !p)}
        >
          <span className="lib-group-chevron">{collapsed ? "▶" : "▼"}</span>
          {label} ({screenshots.length})
        </div>
      )}
      {!collapsed && (
        <div className="lib-grid">
          {screenshots.map((s) => (
            <ScreenshotCard
              key={s._id}
              screenshot={s}
              selectMode={selectMode}
              selected={selectedIds.has(s._id)}
              onToggleSelect={(shiftKey) => onToggleSelect(s._id, shiftKey)}
              onDelete={() => onDelete(s._id)}
              onOpen={() => onOpen(s)}
              onCopyLink={() => onCopyLink(s)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ScreenshotCard({
  screenshot,
  selectMode,
  selected,
  onToggleSelect,
  onDelete,
  onOpen,
  onCopyLink,
}: {
  screenshot: Screenshot;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (shiftKey?: boolean) => void;
  onDelete: () => void;
  onOpen: () => void;
  onCopyLink: () => void;
}) {
  const isVideo = screenshot.mimeType.startsWith("video/");
  const typeLabel = screenshot.type.replace("-", " ").toUpperCase();

  return (
    <div
      className={`lib-card${selectMode ? " selectable" : ""}${selected ? " selected" : ""}`}
      onClick={(e) => {
        if (selectMode) onToggleSelect(e.shiftKey);
        else onOpen();
      }}
    >
      {selectMode && <div className="lib-card-checkbox">✓</div>}
      <div className="lib-card-image">
        {isVideo ? (
          <video
            className="lib-card-preview"
            src={screenshot.publicUrl}
            muted
          />
        ) : (
          <img
            className="lib-card-preview"
            src={screenshot.publicUrl}
            alt={screenshot.filename}
          />
        )}
      </div>
      <div className="lib-card-body">
        <div className="lib-card-title">
          {screenshot.title ?? screenshot.filename}
          <span
            className={`lib-type-badge ${isVideo ? "badge-video" : "badge-screenshot"}`}
          >
            {typeLabel}
          </span>
        </div>
        <div className="lib-card-meta">
          {formatDate(screenshot.createdAt)} •{" "}
          {formatFileSize(screenshot.fileSize)} • {screenshot.viewCount} viewer{screenshot.viewCount !== 1 ? "s" : ""}
        </div>
        <div className="lib-card-actions">
          <button
            className="lib-btn lib-btn-sm lib-btn-primary"
            onClick={(e) => {
              e.stopPropagation();
              onCopyLink();
            }}
          >
            Share Link
          </button>
          <button
            className="lib-btn lib-btn-sm lib-btn-danger"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Helpers ────────────────────────────────────────────── */

function formatDate(timestamp: number) {
  const diff = Date.now() - timestamp;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days = Math.floor(hours / 24);

  if (days > 30) return new Date(timestamp).toLocaleDateString();
  if (days > 0) return `${days} day${days > 1 ? "s" : ""} ago`;
  if (hours > 0) return `${hours} hour${hours > 1 ? "s" : ""} ago`;
  if (mins > 0) return `${mins} minute${mins > 1 ? "s" : ""} ago`;
  return "Just now";
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function extractDomain(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "Unknown";
  }
}

interface GroupResult {
  label: string;
  items: Screenshot[];
}

function groupScreenshots(
  screenshots: Screenshot[],
  grouping: "none" | "date" | "domain"
): GroupResult[] {
  if (grouping === "none") {
    return [{ label: "All", items: screenshots }];
  }

  const groups: Record<string, Screenshot[]> = {};

  if (grouping === "date") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const s of screenshots) {
      const d = new Date(s.createdAt);
      d.setHours(0, 0, 0, 0);
      const diffDays = Math.floor(
        (today.getTime() - d.getTime()) / 86400000
      );

      let key: string;
      if (diffDays === 0) key = "Today";
      else if (diffDays === 1) key = "Yesterday";
      else if (diffDays < 7) key = "This Week";
      else if (diffDays < 30) key = "This Month";
      else
        key = d.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
        });

      (groups[key] ??= []).push(s);
    }

    const order = ["Today", "Yesterday", "This Week", "This Month"];
    return Object.entries(groups)
      .sort(([a], [b]) => {
        const ai = order.indexOf(a);
        const bi = order.indexOf(b);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return b.localeCompare(a);
      })
      .map(([label, items]) => ({ label, items }));
  }

  // domain
  for (const s of screenshots) {
    const domain = s.sourceUrl ? extractDomain(s.sourceUrl) : "Unknown";
    (groups[domain] ??= []).push(s);
  }

  return Object.entries(groups)
    .sort(
      ([, a], [, b]) =>
        Math.max(...b.map((s) => s.createdAt)) -
        Math.max(...a.map((s) => s.createdAt))
    )
    .map(([label, items]) => ({ label, items }));
}
