import "./Changelog.css";

type ChangeCategory = "feature" | "fix" | "stability" | "wip";

interface ChangelogEntry {
  hash: string;
  date: string;
  title: string;
  category: ChangeCategory;
  summary: string;
  highlights: string[];
  stats: { files: number; added: number; removed: number };
}

const CATEGORY_META: Record<ChangeCategory, { label: string; icon: string }> = {
  feature: { label: "Feature", icon: "✨" },
  fix: { label: "Fixes", icon: "🐛" },
  stability: { label: "Stability", icon: "🛡️" },
  wip: { label: "In progress", icon: "🚧" },
};

const ENTRIES: ChangelogEntry[] = [
  {
    hash: "e18a41b",
    date: "Jul 2, 2026",
    title: "Seven bugs fixed after an adversarial review of the refactor",
    category: "fix",
    summary:
      "A dedicated review pass over the whole refactor caught real bugs before they shipped — including one that silently killed the entire video preview page.",
    highlights: [
      "Video preview page was dead on arrival from a broken import — fixed",
      "Offscreen recorder no longer intercepts popup messages meant for the service worker (could kill a live recording)",
      "Annotation editor stays open if saving fails, so your edits are never destroyed",
      "Library batch delete counts and deletes exactly what you selected, even with a search filter active",
    ],
    stats: { files: 7, added: 40, removed: 24 },
  },
  {
    hash: "de0947d",
    date: "Jul 2, 2026",
    title: "Library search, load more, and backend guardrails",
    category: "feature",
    summary:
      "The library is no longer silently capped at 100 items, and you can finally find things in it.",
    highlights: [
      "Search captures by title, filename, or source URL",
      "“Load more” paging replaces the invisible 100-item cap",
      "Viewer-dedupe lists capped at 500 entries so documents can't grow unbounded",
    ],
    stats: { files: 6, added: 80, removed: 9 },
  },
  {
    hash: "17889f0",
    date: "Jul 2, 2026",
    title: "Video recording, front and center — with snap-to-annotate",
    category: "feature",
    summary:
      "The recording pipeline existed but had no buttons. Now it has a UI, one unified engine, and a review flow: record → scrub → snap → annotate → share.",
    highlights: [
      "Record Tab / Record Screen / Stop controls in the popup",
      "One recorder for tab and desktop (the duplicate pinned-tab implementation is gone)",
      "Video review page with a thumbnail filmstrip and click-to-seek",
      "“Snap frame” grabs any moment into a slideshow you can annotate frame by frame",
      "Microphone narration is best-effort — recording proceeds without it if denied",
    ],
    stats: { files: 11, added: 523, removed: 361 },
  },
  {
    hash: "fd44d68",
    date: "Jul 2, 2026",
    title: "Vector annotations: draw lines, move anything, edit after upload",
    category: "feature",
    summary:
      "Annotations are no longer burned into pixels. Every shape is a live object you can select, move, resize, restyle, or delete — even after the capture is shared.",
    highlights: [
      "New tools: line and freehand pen, alongside rectangle, arrow, and text",
      "Select tool with drag-to-move and corner/endpoint resize handles",
      "Annotations persist with the capture and stay editable after upload",
      "One shared engine across the extension editor, slideshow editor, and web viewer (~700 duplicated lines deleted)",
      "Non-destructive crop and a proper object-based undo/redo",
      "Verified with 22 in-browser interaction tests",
    ],
    stats: { files: 16, added: 1769, removed: 1084 },
  },
  {
    hash: "3e4b84e",
    date: "Jul 2, 2026",
    title: "Log cleanup: shift-select console & network entries, then hide them",
    category: "feature",
    summary:
      "Shared snapshots with noisy logs can now be tidied up — reversibly, without touching the underlying log files.",
    highlights: [
      "“Clean up” mode with checkboxes and shift-click range selection",
      "Hide selected, unhide selected, unhide all, and a show-hidden toggle for owners",
      "Highlights pointing at hidden entries are pruned automatically",
      "Log fetch failures now show an error banner instead of an empty panel",
    ],
    stats: { files: 4, added: 495, removed: 54 },
  },
  {
    hash: "3e54ee8",
    date: "Jul 2, 2026",
    title: "Stability sweep: no more silent failures",
    category: "stability",
    summary:
      "The root causes of “it feels flaky” — fire-and-forget messages, leaked recorders, expiring auth tokens, and page-freezing log capture — all addressed in one pass.",
    highlights: [
      "Every extension message is awaited with a timeout; failures surface as popup toasts",
      "Recorder refuses double-starts and releases mic/tab/audio resources on stop or failure",
      "Network log capture capped at 64 KB per body — huge responses no longer freeze the page",
      "Uploads longer than Clerk's 60-second token no longer die mid-flight (fresh token per request, retry on 401)",
      "Full-page capture always restores your scroll position, even when it fails",
    ],
    stats: { files: 9, added: 502, removed: 301 },
  },
  {
    hash: "6a83dda",
    date: "Mar 24, 2026",
    title: "Popup restyle and smarter log saving",
    category: "feature",
    summary:
      "The extension popup got its current tile-and-row look, and log saving moved into the editor flow.",
    highlights: [
      "New popup layout with capture tiles and action rows",
      "Console/network logs are attached from the editor at upload time",
    ],
    stats: { files: 5, added: 145, removed: 35 },
  },
  {
    hash: "f151b3e",
    date: "Mar 21, 2026",
    title: "Slideshow capture is complete",
    category: "feature",
    summary:
      "Multi-frame capture sessions land: collect frames one after another, then annotate and upload them as a single shareable slideshow.",
    highlights: [
      "Finish flow wires the capture session into the slideshow editor and uploader",
    ],
    stats: { files: 2, added: 122, removed: 7 },
  },
  {
    hash: "f65da04",
    date: "Mar 21, 2026",
    title: "Slideshow work continues",
    category: "wip",
    summary: "Frame management and session plumbing for the slideshow feature.",
    highlights: [],
    stats: { files: 5, added: 215, removed: 2 },
  },
  {
    hash: "e8f43b9",
    date: "Mar 21, 2026",
    title: "Slideshow groundwork",
    category: "wip",
    summary:
      "The first big slice of the slideshow feature: session storage, the frame editor page, and the shared viewer.",
    highlights: [],
    stats: { files: 20, added: 3172, removed: 555 },
  },
];

function StatBar({ added, removed }: { added: number; removed: number }) {
  const total = added + removed;
  const addedShare = total === 0 ? 0 : Math.round((added / total) * 100);
  return (
    <span
      className="cl-statbar"
      title={`+${added} / −${removed} lines`}
      aria-hidden="true"
    >
      <span className="cl-statbar-added" style={{ width: `${addedShare}%` }} />
    </span>
  );
}

export default function Changelog() {
  const totals = ENTRIES.reduce(
    (acc, entry) => ({
      added: acc.added + entry.stats.added,
      removed: acc.removed + entry.stats.removed,
    }),
    { added: 0, removed: 0 }
  );

  return (
    <main className="cl-page">
      <section className="cl-hero">
        <p className="cl-eyebrow">Screenshot</p>
        <h1>Changelog</h1>
        <p className="cl-summary">
          The last {ENTRIES.length} changes to the extension, web viewer, and
          backend — from the slideshow groundwork in March to the annotation
          and recording overhaul in July.
        </p>
        <p className="cl-totals">
          <span className="cl-added">+{totals.added.toLocaleString()}</span>
          {" / "}
          <span className="cl-removed">−{totals.removed.toLocaleString()}</span>
          {" lines across "}
          {ENTRIES.length} commits
        </p>
      </section>

      <section className="cl-timeline">
        {ENTRIES.map((entry) => {
          const meta = CATEGORY_META[entry.category];
          return (
            <article className={`cl-entry cl-${entry.category}`} key={entry.hash}>
              <div className="cl-marker" aria-hidden="true">
                <span className="cl-marker-icon">{meta.icon}</span>
              </div>
              <div className="cl-card">
                <header className="cl-card-header">
                  <span className={`cl-badge cl-badge-${entry.category}`}>
                    {meta.label}
                  </span>
                  <span className="cl-date">{entry.date}</span>
                  <code className="cl-hash">{entry.hash}</code>
                </header>
                <h2>{entry.title}</h2>
                <p className="cl-card-summary">{entry.summary}</p>
                {entry.highlights.length > 0 && (
                  <ul className="cl-highlights">
                    {entry.highlights.map((highlight) => (
                      <li key={highlight}>{highlight}</li>
                    ))}
                  </ul>
                )}
                <footer className="cl-card-footer">
                  <StatBar added={entry.stats.added} removed={entry.stats.removed} />
                  <span className="cl-stats-text">
                    {entry.stats.files} file{entry.stats.files !== 1 ? "s" : ""} ·{" "}
                    <span className="cl-added">+{entry.stats.added.toLocaleString()}</span>{" "}
                    <span className="cl-removed">−{entry.stats.removed.toLocaleString()}</span>
                  </span>
                </footer>
              </div>
            </article>
          );
        })}
      </section>
    </main>
  );
}
