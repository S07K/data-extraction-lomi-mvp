"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import type { DocumentListItem } from "@lomi/contracts";
import { queueGroup, useDocuments, type QueueGroup } from "@/lib/queries";
import { TYPE_LABEL } from "@/lib/format";
import { UploadDialog } from "./UploadDialog";

const GROUPS: { key: QueueGroup; label: string }[] = [
  { key: "attention", label: "Needs attention" },
  { key: "review", label: "Needs review" },
  { key: "extracting", label: "Extracting" },
  { key: "done", label: "Done" },
];

function QueueBadge({ d }: { d: DocumentListItem }) {
  const g = queueGroup(d);
  if (g === "attention") return <span className="q-badge q-failed" title="Extraction failed">Failed</span>;
  if (g === "review") return <span className="q-badge q-count" title="Values to review">{d.progress!.pending}</span>;
  if (g === "extracting") return <span className="q-dot" title="Extracting" />;
  return <span className="q-check" aria-label="All reviewed">✓</span>;
}

export function Sidebar() {
  const pathname = usePathname();
  const docs = useDocuments();
  const [uploadOpen, setUploadOpen] = useState(false);
  const list = docs.data ?? [];

  return (
    <nav className="sidebar" aria-label="Main">
      <Link href="/" className="brand">
        <span className="brand-mark" aria-hidden />
        Review desk
      </Link>

      <button className="btn btn-upload" onClick={() => setUploadOpen(true)}>
        Upload document
      </button>

      <Link href="/" className={`nav-item ${pathname === "/" ? "active" : ""}`}>
        Overview
      </Link>

      <div className="queue">
        {docs.isLoading && <p className="queue-empty">Loading…</p>}
        {docs.error && <p className="queue-empty">Can't reach the API.</p>}
        {GROUPS.map(({ key, label }) => {
          const items = list.filter((d) => queueGroup(d) === key);
          if (items.length === 0) return null;
          return (
            <section key={key} className="queue-group">
              <h3>
                {label} <span>{items.length}</span>
              </h3>
              <ul>
                {items.map((d) => {
                  const href = `/documents/${d.id}`;
                  return (
                    <li key={d.id}>
                      <Link href={href} className={`queue-item ${pathname === href ? "active" : ""}`} aria-current={pathname === href ? "page" : undefined}>
                        <span className="queue-text">
                          <span className="queue-title" title={d.title}>{d.title}</span>
                          <span className="queue-meta">
                            {TYPE_LABEL[d.type] ?? d.type}, v{d.currentVersion.versionNumber}
                          </span>
                        </span>
                        <QueueBadge d={d} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
        {docs.data && list.length === 0 && <p className="queue-empty">No documents yet.</p>}
      </div>

      <UploadDialog mode={{ kind: "new" }} open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </nav>
  );
}
