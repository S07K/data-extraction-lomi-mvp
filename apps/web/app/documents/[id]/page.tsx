"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentDetail, ValueDto } from "@lomi/contracts";
import { StatusText } from "@/components/Status";
import { UploadDialog } from "@/components/UploadDialog";
import { ValueCard } from "@/components/ValueCard";
import { api, IN_FLIGHT } from "@/lib/api";
import { fieldLabel, STATUS_TEXT, timeAgo, TYPE_LABEL } from "@/lib/format";

/** Order inside "Needs review": what changed first, then new values, then gaps. */
function pendingRank(v: ValueDto) {
  if (v.carryStatus === "changed") return 0;
  if (v.isGap) return 2;
  return 1;
}

export default function DocumentPage() {
  const { id } = useParams<{ id: string }>();
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [activeId, setActiveId] = useState<string | null>(null);

  const doc = useQuery({
    queryKey: ["document", id, version ?? "default"],
    queryFn: () => api.getDocument(id, version),
    refetchInterval: (q) => {
      const d = q.state.data;
      return d && (IN_FLIGHT.has(d.status) || IN_FLIGHT.has(d.shownVersion.status)) ? 2000 : false;
    },
  });

  if (doc.isLoading) return <div className="content"><p className="muted">Loading…</p></div>;
  if (doc.error || !doc.data) {
    return (
      <div className="content">
        <p className="error-note">{(doc.error as Error | null)?.message ?? "Document not found."}</p>
        <Link href="/">Back to the overview</Link>
      </div>
    );
  }
  return <DocumentView d={doc.data} setVersion={setVersion} activeId={activeId} setActiveId={setActiveId} />;
}

function DocumentView({
  d,
  setVersion,
  activeId,
  setActiveId,
}: {
  d: DocumentDetail;
  setVersion: (v: number | undefined) => void;
  activeId: string | null;
  setActiveId: (id: string | null) => void;
}) {
  const shown = d.shownVersion;
  const pending = d.values.filter((v) => v.reviewState === "pending").sort((a, b) => pendingRank(a) - pendingRank(b));
  const done = d.values.filter((v) => v.reviewState !== "pending");
  const changed = pending.filter((v) => v.carryStatus === "changed").length;
  const carried = done.filter((v) => v.reviewState === "carried_over").length;
  const readOnly = !shown.reviewable;

  return (
    <div className="content">
      <header className="doc-head">
        <div className="doc-head-main">
          <h1>{d.title}</h1>
          <div className="doc-meta">
            <span className="type-chip">{TYPE_LABEL[d.type] ?? d.type}</span>
            <StatusText status={d.status} />
            <span className="faint">
              Latest is version {d.currentVersion.versionNumber}, uploaded {timeAgo(d.currentVersion.createdAt)}
            </span>
          </div>
        </div>
        <DocTools d={d} setVersion={setVersion} />
      </header>
      <Headline d={d} pending={pending.length} changed={changed} carried={carried} />

      <Banners d={d} onShowLatest={() => setVersion(undefined)} />

      {shown.status === "extracted" && (
        <div className="workspace">
          <section aria-label="Extracted values">
            {pending.length > 0 && (
              <div className="group">
                <div className="group-title">
                  <h2>Needs review</h2>
                  <span className="faint">{pending.length}</span>
                </div>
                {pending.map((v) => (
                  <ValueCard key={v.id} v={v} documentId={d.id} active={activeId === v.id} onSelect={() => setActiveId(v.id)} readOnly={readOnly} />
                ))}
              </div>
            )}
            {done.length > 0 && (
              <div className="group">
                <div className="group-title">
                  <h2>Reviewed</h2>
                  <span className="faint">{done.length}</span>
                </div>
                {done.map((v) => (
                  <ValueCard key={v.id} v={v} documentId={d.id} active={activeId === v.id} onSelect={() => setActiveId(v.id)} readOnly={readOnly} />
                ))}
              </div>
            )}
          </section>
          <SourceSheet d={d} activeId={activeId} onSelect={setActiveId} />
        </div>
      )}
    </div>
  );
}

function Headline({ d, pending, changed, carried }: { d: DocumentDetail; pending: number; changed: number; carried: number }) {
  const s = d.shownVersion;
  if (s.status !== "extracted") return null;
  if (!s.reviewable) return null;
  if (pending === 0) return <p className="headline headline-done">Every value in version {s.versionNumber} is reviewed.</p>;
  return (
    <p className="headline">
      <strong>
        {pending} {pending === 1 ? "value needs" : "values need"} your review
      </strong>
      {changed > 0 && s.versionNumber > 1 && ` — ${changed} changed since the previous version`}
      {carried > 0 && `; ${carried} kept their earlier review`}.
    </p>
  );
}

function DocTools({ d, setVersion }: { d: DocumentDetail; setVersion: (v: number | undefined) => void }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const shownNumber = d.shownVersion.versionNumber;
  const latest = d.currentVersion.versionNumber;

  return (
    <div className="doc-tools">
      <div className="version-switch" role="group" aria-label="Version shown">
        <span className="version-switch-label">Version</span>
        {[...d.versions].reverse().map((v) => (
          <button
            key={v.id}
            className={`version-pill status-dot-${v.status}`}
            aria-pressed={v.versionNumber === shownNumber}
            onClick={() => setVersion(v.versionNumber === d.reviewableVersionNumber ? undefined : v.versionNumber)}
            title={`Version ${v.versionNumber}: ${STATUS_TEXT[v.status]}`}
          >
            v{v.versionNumber}
          </button>
        ))}
      </div>
      <a className="btn btn-quiet" href={`/api/documents/${d.id}/versions/${shownNumber}/file`} target="_blank" rel="noreferrer">
        Open PDF
      </a>
      <button className="btn btn-primary" onClick={() => setUploadOpen(true)}>
        Upload version {latest + 1}
      </button>
      <UploadDialog
        mode={{ kind: "version", documentId: d.id, title: d.title, nextVersion: latest + 1 }}
        open={uploadOpen}
        onClose={() => {
          setUploadOpen(false);
          setVersion(undefined);
        }}
      />
    </div>
  );
}

function Banners({ d, onShowLatest }: { d: DocumentDetail; onShowLatest: () => void }) {
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retry(d.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["document", d.id] }),
  });
  const cur = d.currentVersion;
  const s = d.shownVersion;
  const banners: React.ReactNode[] = [];

  if (cur.status === "failed") {
    banners.push(
      <div key="failed" className="banner banner-failed">
        <strong>Version {cur.versionNumber} could not be extracted.</strong> {cur.failureReason}
        <div className="actions">
          <button className="btn" onClick={() => retry.mutate()} disabled={retry.isPending}>
            Retry extraction
          </button>
          {retry.error && <span className="error-note">{(retry.error as Error).message}</span>}
        </div>
      </div>,
    );
  }
  if (IN_FLIGHT.has(cur.status)) {
    const otherShown = s.versionNumber !== cur.versionNumber;
    banners.push(
      <div key="flight" className="banner banner-progress">
        <StatusText status={cur.status} /> version {cur.versionNumber}
        {cur.failureReason ? ` (${cur.failureReason})` : ""}.{" "}
        {otherShown
          ? `You can keep reviewing version ${s.versionNumber}; reviews carry over wherever the evidence is unchanged.`
          : "Values appear here when it finishes."}
      </div>,
    );
  }
  if (!s.reviewable && s.status === "extracted" && d.reviewableVersionNumber !== null) {
    banners.push(
      <div key="ro" className="banner">
        You are viewing version {s.versionNumber}. Reviews are only accepted on version {d.reviewableVersionNumber}.{" "}
        <button className="btn btn-quiet" onClick={onShowLatest}>
          Go to version {d.reviewableVersionNumber}
        </button>
      </div>,
    );
  }
  if (s.status === "superseded") {
    banners.push(
      <div key="sup" className="banner">
        Version {s.versionNumber} was replaced by a newer upload before its extraction finished, so it has no values.
      </div>,
    );
  }
  return <>{banners}</>;
}

/** The parsed text of the shown version, with every evidence quote marked and the active one emphasised. */
function SourceSheet({ d, activeId, onSelect }: { d: DocumentDetail; activeId: string | null; onSelect: (id: string) => void }) {
  const text = d.shownVersion.parsedText ?? "";
  const activeRef = useRef<HTMLElement | null>(null);

  const pieces = useMemo(() => {
    const spans = d.values
      .filter((v) => v.evidenceStart !== null && v.evidenceEnd !== null)
      .map((v) => ({ id: v.id, field: v.field, start: v.evidenceStart!, end: v.evidenceEnd! }))
      .sort((a, b) => a.start - b.start);
    const out: ({ text: string } | { text: string; id: string; field: string })[] = [];
    let cursor = 0;
    for (const s of spans) {
      if (s.start < cursor) continue; // overlapping quotes: keep the first
      out.push({ text: text.slice(cursor, s.start) });
      out.push({ text: text.slice(s.start, s.end), id: s.id, field: s.field });
      cursor = s.end;
    }
    out.push({ text: text.slice(cursor) });
    return out;
  }, [d.values, text]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeId]);

  return (
    <aside className="sheet" aria-label="Document text">
      <div className="sheet-head">
        <span>Text of version {d.shownVersion.versionNumber}</span>
        <span>Highlighted passages are the evidence</span>
      </div>
      <pre className="sheet-text">
        {pieces.map((p, i) =>
          "id" in p ? (
            <mark
              key={i}
              className={p.id === activeId ? "on" : undefined}
              ref={p.id === activeId ? (el) => void (activeRef.current = el) : undefined}
              title={fieldLabel(p.field)}
              onClick={() => onSelect(p.id)}
            >
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </pre>
    </aside>
  );
}
