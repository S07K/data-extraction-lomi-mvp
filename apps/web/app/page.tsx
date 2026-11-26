"use client";
import Link from "next/link";
import { useState } from "react";
import { ProgressBar, StatusText } from "@/components/Status";
import { UploadDialog } from "@/components/UploadDialog";
import { IN_FLIGHT } from "@/lib/api";
import { TYPE_LABEL, timeAgo } from "@/lib/format";
import { queueGroup, useDocuments } from "@/lib/queries";

export default function OverviewPage() {
  const docs = useDocuments();
  const [uploadOpen, setUploadOpen] = useState(false);
  const list = docs.data ?? [];

  const valuesToReview = list.reduce((n, d) => n + (d.progress?.pending ?? 0), 0);
  const docsToReview = list.filter((d) => queueGroup(d) === "review").length;
  const extracting = list.filter((d) => IN_FLIGHT.has(d.currentVersion.status)).length;
  const failed = list.filter((d) => d.currentVersion.status === "failed").length;
  const done = list.filter((d) => queueGroup(d) === "done").length;
  const rank = { attention: 0, review: 1, extracting: 2, done: 3 } as const;
  const sorted = [...list].sort((a, b) => rank[queueGroup(a)] - rank[queueGroup(b)]);

  return (
    <div className="content">
      <header className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">
            {docs.isLoading
              ? "Loading…"
              : valuesToReview > 0
                ? `${valuesToReview} ${valuesToReview === 1 ? "value is" : "values are"} waiting for review across ${docsToReview} ${docsToReview === 1 ? "document" : "documents"}.`
                : list.length > 0
                  ? "Nothing is waiting for review."
                  : "Upload a PDF to get started."}
          </p>
        </div>
      </header>

      {docs.error && <p className="error-note">{(docs.error as Error).message}</p>}

      <dl className="stats">
        <div className={valuesToReview > 0 ? "stat stat-review" : "stat"}>
          <dt>Values to review</dt>
          <dd>{valuesToReview}</dd>
        </div>
        <div className={extracting > 0 ? "stat stat-extracting" : "stat"}>
          <dt>Extracting now</dt>
          <dd>{extracting}</dd>
        </div>
        <div className={failed > 0 ? "stat stat-failed" : "stat"}>
          <dt>Failed extractions</dt>
          <dd>{failed}</dd>
        </div>
        <div className="stat">
          <dt>Fully reviewed</dt>
          <dd>
            {done}
            <small> of {list.length}</small>
          </dd>
        </div>
      </dl>

      {docs.data && list.length === 0 ? (
        <div className="empty">
          <h2>No documents yet</h2>
          <p className="muted">Upload an invoice, lease or market report and its values will be extracted for review.</p>
          <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
            Upload document
          </button>
        </div>
      ) : (
        <div className="panel">
          <table className="doc-table">
            <thead>
              <tr>
                <th>Document</th>
                <th>Version</th>
                <th>Extraction</th>
                <th>Review</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((d) => {
                const g = queueGroup(d);
                return (
                  <tr key={d.id} className={g === "attention" || g === "review" ? "attention" : undefined}>
                    <td>
                      <Link className="doc-title" href={`/documents/${d.id}`}>
                        {d.title}
                      </Link>
                      <div className="faint">{TYPE_LABEL[d.type] ?? d.type}</div>
                    </td>
                    <td>
                      v{d.currentVersion.versionNumber}
                      <div className="faint">{timeAgo(d.currentVersion.createdAt)}</div>
                    </td>
                    <td>
                      <StatusText status={d.currentVersion.status} />
                      {d.currentVersion.status === "failed" && d.currentVersion.failureReason && (
                        <div className="faint clamp">{d.currentVersion.failureReason}</div>
                      )}
                    </td>
                    <td>
                      <ProgressBar progress={d.progress} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <UploadDialog mode={{ kind: "new" }} open={uploadOpen} onClose={() => setUploadOpen(false)} />
    </div>
  );
}
