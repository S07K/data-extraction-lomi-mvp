"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { DOCUMENT_TYPES, type DocumentListItem } from "@lomi/contracts";
import { ProgressBar, StatusText } from "@/components/Status";
import { api, IN_FLIGHT } from "@/lib/api";
import { TYPE_LABEL, timeAgo } from "@/lib/format";

function needsAttention(d: DocumentListItem) {
  return (d.progress?.pending ?? 0) > 0 || d.currentVersion.status === "failed";
}

export default function DocumentsPage() {
  const docs = useQuery({
    queryKey: ["documents"],
    queryFn: api.listDocuments,
    // Poll only while something is being extracted; idle pages make no requests.
    refetchInterval: (q) => (q.state.data?.some((d) => IN_FLIGHT.has(d.currentVersion.status)) ? 2000 : false),
  });

  const sorted = [...(docs.data ?? [])].sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)));
  const attention = sorted.filter(needsAttention).length;

  return (
    <>
      <div className="list-head">
        <div>
          <h1>Documents</h1>
          <p className="muted" style={{ margin: 0 }}>
            {docs.isLoading
              ? "Loading…"
              : attention > 0
                ? `${attention} ${attention === 1 ? "document needs" : "documents need"} your review.`
                : "Nothing is waiting for review."}
          </p>
        </div>
        <UploadForm />
      </div>

      {docs.error && <p className="error-note">{(docs.error as Error).message}</p>}

      {docs.data && docs.data.length === 0 ? (
        <div className="empty">
          <h2>No documents yet</h2>
          <p className="muted">Upload a PDF to extract its values for review.</p>
        </div>
      ) : (
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
            {sorted.map((d) => (
              <tr key={d.id} className={needsAttention(d) ? "attention" : undefined}>
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
                    <div className="faint" style={{ maxWidth: 320 }}>{d.currentVersion.failureReason}</div>
                  )}
                  {d.reviewableVersionNumber !== null && d.reviewableVersionNumber !== d.currentVersion.versionNumber && (
                    <div className="faint">v{d.reviewableVersionNumber} still reviewable</div>
                  )}
                </td>
                <td>
                  <ProgressBar progress={d.progress} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function UploadForm() {
  const qc = useQueryClient();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<string>("invoice");
  const upload = useMutation({
    mutationFn: (form: FormData) => api.upload(form),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["documents"] });
      router.push(`/documents/${res.documentId}`);
    },
  });

  return (
    <form
      className="upload"
      onSubmit={(e) => {
        e.preventDefault();
        const file = fileRef.current?.files?.[0];
        if (!file) return;
        const form = new FormData();
        form.set("type", type);
        form.set("file", file);
        upload.mutate(form);
      }}
    >
      <select aria-label="Document type" value={type} onChange={(e) => setType(e.target.value)}>
        {DOCUMENT_TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <input ref={fileRef} type="file" accept="application/pdf" aria-label="PDF file" required />
      <button className="btn" type="submit" disabled={upload.isPending}>
        {upload.isPending ? "Uploading…" : "Upload PDF"}
      </button>
      {upload.error && <p className="error-note" style={{ flexBasis: "100%" }}>{(upload.error as Error).message}</p>}
    </form>
  );
}
