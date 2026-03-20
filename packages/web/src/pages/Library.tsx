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

type ScreenshotCaptureType = "screenshot" | "tab-recording" | "screen-recording";

interface ScreenshotItem {
  kind: "screenshot";
  _id: Id<"screenshots">;
  filename: string;
  title?: string;
  mimeType: string;
  publicUrl: string;
  sourceUrl?: string;
  type: ScreenshotCaptureType;
  createdAt: number;
  viewCount: number;
  shareToken: string;
  fileSize: number;
}

interface SlideshowItem {
  kind: "slideshow";
  _id: Id<"slideshows">;
  filename: string;
  title?: string;
  mimeType: "image/slideshow";
  publicUrl: string;
  sourceUrl?: string;
  type: "slideshow";
  createdAt: number;
  viewCount: number;
  shareToken: string;
  frameCount: number;
  visibleFrameCount: number;
}

type LibraryItem = ScreenshotItem | SlideshowItem;

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

function getItemKey(item: LibraryItem) {
  return `${item.kind}:${item._id}`;
}

function buildItemPath(item: LibraryItem) {
  return item.kind === "slideshow"
    ? `/slideshow/${item.shareToken}`
    : `/snapshot/${item.shareToken}`;
}

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

function AuthenticatedLibrary() {
  const { user } = useUser();
  const libraryItems = useQuery(api.library.getUserLibraryItems, {
    limit: 100,
  }) as LibraryItem[] | undefined;
  const deleteScreenshot = useMutation(api.screenshots.deleteScreenshot);
  const deleteSlideshow = useMutation(api.slideshows.deleteSlideshow);

  const [currentGrouping, setCurrentGrouping] = useState<
    "none" | "date" | "domain"
  >(getStoredLibraryGrouping);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  const groupedItems = libraryItems
    ? groupLibraryItems(libraryItems, currentGrouping)
    : [];
  const orderedItems = groupedItems.flatMap((group) => group.items);

  const showToast = useCallback((message: string) => {
    setToast(message);
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

  const deleteItem = async (item: LibraryItem) => {
    if (item.kind === "slideshow") {
      await deleteSlideshow({ id: item._id });
      return;
    }

    await deleteScreenshot({ id: item._id });
  };

  const handleDelete = (item: LibraryItem) => {
    const noun = item.kind === "slideshow" ? "slideshow" : "capture";
    setConfirmState({
      title: `Delete ${noun}?`,
      description:
        item.kind === "slideshow"
          ? "This slideshow and all of its frames will be removed from your library."
          : "This capture will be removed from your library and can’t be restored.",
      confirmLabel: `Delete ${noun}`,
      onConfirm: async () => {
        try {
          await deleteItem(item);
          showToast(`✓ ${item.kind === "slideshow" ? "Slideshow" : "Capture"} deleted`);
        } catch {
          showToast(`Failed to delete ${noun}`);
        }
      },
    });
  };

  const handleBatchDelete = () => {
    if (selectedKeys.size === 0) return;
    const selectedItems = orderedItems.filter((item) => selectedKeys.has(getItemKey(item)));
    const count = selectedItems.length;

    setConfirmState({
      title: `Delete ${count} item${count !== 1 ? "s" : ""}?`,
      description:
        "This permanently removes the selected captures and slideshows from your library.",
      confirmLabel: `Delete ${count}`,
      onConfirm: async () => {
        try {
          for (const item of selectedItems) {
            await deleteItem(item);
          }
          setSelectedKeys(new Set());
          setSelectMode(false);
          showToast(`✓ Deleted ${count} item${count !== 1 ? "s" : ""}`);
        } catch {
          showToast("Failed to delete selected items");
        }
      },
    });
  };

  const toggleSelection = (item: LibraryItem, shiftKey = false) => {
    const key = getItemKey(item);

    if (shiftKey && lastSelectedKey && orderedItems.length > 0) {
      const lastIndex = orderedItems.findIndex((entry) => getItemKey(entry) === lastSelectedKey);
      const currentIndex = orderedItems.findIndex((entry) => getItemKey(entry) === key);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const rangeKeys = orderedItems.slice(start, end + 1).map(getItemKey);

        setSelectedKeys((previous) => {
          const next = new Set(previous);
          rangeKeys.forEach((rangeKey) => next.add(rangeKey));
          return next;
        });
        setLastSelectedKey(key);
        return;
      }
    }

    setSelectedKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setLastSelectedKey(key);
  };

  const selectAll = () => {
    if (!libraryItems) return;
    setSelectedKeys(new Set(libraryItems.map(getItemKey)));
  };

  const openItem = (item: LibraryItem) => {
    window.open(buildAppUrl(buildItemPath(item)), "_blank");
  };

  const copyShareLink = async (item: LibraryItem) => {
    const url = buildAppUrl(buildItemPath(item));
    try {
      await navigator.clipboard.writeText(url);
      showToast("✓ Link copied to clipboard!");
    } catch {
      showToast("Failed to copy link");
    }
  };

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (!(event.target as Element).closest(".lib-grouping-controls")) {
        setShowGroupMenu(false);
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(LIBRARY_GROUPING_STORAGE_KEY, currentGrouping);
  }, [currentGrouping]);

  if (libraryItems === undefined) {
    return (
      <div className="lib-page">
        <div className="lib-loading">Loading your captures…</div>
      </div>
    );
  }

  return (
    <div className="lib-page">
      <header className="lib-header">
        <div className="lib-header-top">
          <div className="lib-header-left">
            <h1>📸 Capture Library</h1>
            <p className="lib-subtitle">
              {libraryItems.length} item{libraryItems.length !== 1 ? "s" : ""}
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
                  disabled={selectedKeys.size === 0}
                >
                  Delete ({selectedKeys.size})
                </button>
                <button
                  className="lib-btn lib-btn-outline"
                  onClick={() => {
                    setSelectMode(false);
                    setSelectedKeys(new Set());
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
                onClick={() => setShowGroupMenu((open) => !open)}
              >
                Group: {currentGrouping === "none" ? "None" : currentGrouping}
              </button>
              {showGroupMenu && (
                <div className="lib-grouping-menu">
                  {(["none", "date", "domain"] as const).map((grouping) => (
                    <button
                      key={grouping}
                      className={`lib-grouping-option${currentGrouping === grouping ? " active" : ""}`}
                      onClick={() => {
                        setCurrentGrouping(grouping);
                        setShowGroupMenu(false);
                      }}
                    >
                      {grouping === "none" ? "No grouping" : `By ${grouping}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {libraryItems.length === 0 ? (
        <div className="lib-empty">
          <h2>No captures yet</h2>
          <p>Install the Screenshot extension and start taking screenshots or building slideshows.</p>
        </div>
      ) : (
        <div className="lib-content">
          {groupedItems.map((group, index) => (
            <GroupSection
              key={group.label}
              label={group.label}
              items={group.items}
              selectMode={selectMode}
              selectedKeys={selectedKeys}
              onToggleSelect={toggleSelection}
              onDelete={handleDelete}
              onOpen={openItem}
              onCopyLink={copyShareLink}
              showLabel={currentGrouping !== "none"}
              groupIndex={index}
            />
          ))}
        </div>
      )}

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
  items,
  selectMode,
  selectedKeys,
  onToggleSelect,
  onDelete,
  onOpen,
  onCopyLink,
  showLabel,
  groupIndex,
}: {
  label: string;
  items: LibraryItem[];
  selectMode: boolean;
  selectedKeys: Set<string>;
  onToggleSelect: (item: LibraryItem, shiftKey?: boolean) => void;
  onDelete: (item: LibraryItem) => void;
  onOpen: (item: LibraryItem) => void;
  onCopyLink: (item: LibraryItem) => void;
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
          onClick={() => setCollapsed((open) => !open)}
        >
          <span className="lib-group-chevron">{collapsed ? "▶" : "▼"}</span>
          {label} ({items.length})
        </div>
      )}
      {!collapsed && (
        <div className="lib-grid">
          {items.map((item) => (
            <LibraryCard
              key={getItemKey(item)}
              item={item}
              selectMode={selectMode}
              selected={selectedKeys.has(getItemKey(item))}
              onToggleSelect={(shiftKey) => onToggleSelect(item, shiftKey)}
              onDelete={() => onDelete(item)}
              onOpen={() => onOpen(item)}
              onCopyLink={() => onCopyLink(item)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LibraryCard({
  item,
  selectMode,
  selected,
  onToggleSelect,
  onDelete,
  onOpen,
  onCopyLink,
}: {
  item: LibraryItem;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (shiftKey?: boolean) => void;
  onDelete: () => void;
  onOpen: () => void;
  onCopyLink: () => void;
}) {
  const isVideo = item.kind === "screenshot" && item.mimeType.startsWith("video/");
  const typeLabel =
    item.kind === "slideshow"
      ? "SLIDESHOW"
      : item.type.replace("-", " ").toUpperCase();

  return (
    <div
      className={`lib-card${selectMode ? " selectable" : ""}${selected ? " selected" : ""}`}
      onClick={(event) => {
        if (selectMode) onToggleSelect(event.shiftKey);
        else onOpen();
      }}
    >
      {selectMode && <div className="lib-card-checkbox">✓</div>}
      <div className="lib-card-image">
        {isVideo ? (
          <video className="lib-card-preview" src={item.publicUrl} muted />
        ) : (
          <img className="lib-card-preview" src={item.publicUrl} alt={item.filename} />
        )}
      </div>
      <div className="lib-card-body">
        <div className="lib-card-title">
          {item.title ?? item.filename}
          <span
            className={`lib-type-badge ${
              item.kind === "slideshow"
                ? "badge-slideshow"
                : isVideo
                  ? "badge-video"
                  : "badge-screenshot"
            }`}
          >
            {typeLabel}
          </span>
        </div>
        <div className="lib-card-meta">
          {formatDate(item.createdAt)} •{" "}
          {item.kind === "slideshow"
            ? `${item.frameCount} frame${item.frameCount !== 1 ? "s" : ""}`
            : formatFileSize(item.fileSize)}{" "}
          • {item.viewCount} viewer{item.viewCount !== 1 ? "s" : ""}
        </div>
        <div className="lib-card-actions">
          <button
            className="lib-btn lib-btn-sm lib-btn-primary"
            onClick={(event) => {
              event.stopPropagation();
              onCopyLink();
            }}
          >
            Share Link
          </button>
          <button
            className="lib-btn lib-btn-sm lib-btn-danger"
            onClick={(event) => {
              event.stopPropagation();
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
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  items: LibraryItem[];
}

function groupLibraryItems(
  items: LibraryItem[],
  grouping: "none" | "date" | "domain"
): GroupResult[] {
  if (grouping === "none") {
    return [{ label: "All", items }];
  }

  const groups: Record<string, LibraryItem[]> = {};

  if (grouping === "date") {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const item of items) {
      const date = new Date(item.createdAt);
      date.setHours(0, 0, 0, 0);
      const diffDays = Math.floor((today.getTime() - date.getTime()) / 86400000);

      let key: string;
      if (diffDays === 0) key = "Today";
      else if (diffDays === 1) key = "Yesterday";
      else if (diffDays < 7) key = "This Week";
      else if (diffDays < 30) key = "This Month";
      else {
        key = date.toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
        });
      }

      (groups[key] ??= []).push(item);
    }

    const order = ["Today", "Yesterday", "This Week", "This Month"];
    return Object.entries(groups)
      .sort(([a], [b]) => {
        const aIndex = order.indexOf(a);
        const bIndex = order.indexOf(b);
        if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
        if (aIndex !== -1) return -1;
        if (bIndex !== -1) return 1;
        return b.localeCompare(a);
      })
      .map(([label, groupItems]) => ({ label, items: groupItems }));
  }

  for (const item of items) {
    const domain = item.sourceUrl ? extractDomain(item.sourceUrl) : "Unknown";
    (groups[domain] ??= []).push(item);
  }

  return Object.entries(groups)
    .sort(
      ([, a], [, b]) =>
        Math.max(...b.map((item) => item.createdAt)) -
        Math.max(...a.map((item) => item.createdAt))
    )
    .map(([label, groupItems]) => ({ label, items: groupItems }));
}
