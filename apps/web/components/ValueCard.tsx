"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CORRECTION_TAGS, type ValueDto } from "@lomi/contracts";
import { api } from "@/lib/api";
import { fieldLabel, formatValue, timeAgo } from "@/lib/format";

const TAG_TEXT: Record<(typeof CORRECTION_TAGS)[number], string> = {
  wrong_value: "Wrong value",
  wrong_format: "Wrong format",
  wrong_evidence: "Wrong passage",
  should_be_gap: "Not in document",
  missed_field: "Missed by extraction",
  other: "Other",
};

const FORMAT_HINT: Record<string, string> = {
  date: "e.g. 2025-10-14 or Oct 14, 2025",
  money: "e.g. 5230.29",
  percent: "e.g. 4.2",
  number: "e.g. 24",
  string: "",
};

function StateTags({ v }: { v: ValueDto }) {
  const tags: React.ReactNode[] = [];
  if (v.reviewState === "pending") {
    if (v.carryStatus === "changed") tags.push(<span key="c" className="tag tag-changed">Changed in this version</span>);
    else if (v.carryStatus === "unchanged") tags.push(<span key="u" className="tag tag-new">Unchanged, not yet reviewed</span>);
  }
  if (v.isGap) tags.push(<span key="g" className="tag tag-gap">Not found</span>);
  if (v.reviewState === "approved") tags.push(<span key="a" className="tag tag-approved">Approved</span>);
  if (v.reviewState === "corrected") tags.push(<span key="x" className="tag tag-corrected">Corrected by reviewer</span>);
  if (v.reviewState === "carried_over") {
    tags.push(
      <span key="k" className="tag tag-carried">
        Kept from v{v.previous?.versionNumber ?? "?"} ({v.currentReview?.action === "corrected" ? "corrected" : "approved"})
      </span>,
    );
  }
  return <div className="tags">{tags}</div>;
}

export function ValueCard({
  v,
  documentId,
  active,
  onSelect,
  readOnly,
}: {
  v: ValueDto;
  documentId: string;
  active: boolean;
  onSelect: () => void;
  readOnly: boolean;
}) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"idle" | "correct" | "revisit">("idle");
  const review = useMutation({
    mutationFn: (body: Parameters<typeof api.review>[1]) => api.review(v.id, body),
    onSuccess: async () => {
      setMode("idle");
      await qc.invalidateQueries({ queryKey: ["document", documentId] });
      await qc.invalidateQueries({ queryKey: ["documents"] });
    },
  });

  const pending = v.reviewState === "pending";
  const corrected = v.currentReview?.action === "corrected";
  const showActions = !readOnly && (pending || mode === "revisit");
  const cls = ["value", pending ? "value-pending" : "", v.carryStatus === "changed" ? "changed" : "", v.isGap ? "gap" : "", active ? "active" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={cls} onClick={onSelect} aria-current={active ? "true" : undefined}>
      <div className="value-row">
        <div>
          <div className="field-name">{fieldLabel(v.field)}</div>
          <div className={`field-value ${v.effectiveValue === null ? "is-gap" : ""}`}>
            {v.effectiveValue === null ? "No value" : formatValue(v.effectiveValue, v.fieldType, v.unit)}
            {corrected && v.value !== v.currentReview?.correctedValue && (
              <span className="original" title="Extracted value">
                {formatValue(v.value, v.fieldType, v.unit)}
              </span>
            )}
          </div>
        </div>
        <StateTags v={v} />
      </div>

      {v.evidence && (
        <p className="quote">
          <mark>{v.evidence}</mark>
        </p>
      )}
      {v.isGap && v.gapReason && <p className="gap-reason">{v.gapReason}</p>}

      {v.carryStatus === "changed" && v.previous && (
        <div className="redline">
          Version {v.previous.versionNumber} said <span className="was">{formatValue(v.previous.effectiveValue, v.fieldType, v.previous.unit)}</span>
          {v.previous.review
            ? `, ${v.previous.review.action === "corrected" ? "corrected" : "approved"} by ${v.previous.review.reviewer}`
            : ", not reviewed"}
          {v.previous.evidence && (
            <>
              {" "}
              from <span className="was">“{v.previous.evidence}”</span>
            </>
          )}
          .
        </div>
      )}

      {v.currentReview && !pending && (
        <p className="review-note">
          {v.currentReview.source === "carried_over" ? "Review carried over" : corrected ? "Corrected" : "Approved"} by {v.currentReview.reviewer}{" "}
          {timeAgo(v.currentReview.createdAt)}
          {v.currentReview.tags.length > 0 && ` (${v.currentReview.tags.map((t) => TAG_TEXT[t as keyof typeof TAG_TEXT] ?? t).join(", ")})`}
          {v.currentReview.note && `: “${v.currentReview.note}”`}
          {!readOnly && mode === "idle" && (
            <>
              {" "}
              <button
                className="btn btn-quiet"
                onClick={(e) => {
                  e.stopPropagation();
                  setMode("revisit");
                }}
              >
                Review again
              </button>
            </>
          )}
        </p>
      )}

      {showActions && mode !== "correct" && (
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button className="btn btn-approve" disabled={review.isPending} onClick={() => review.mutate({ action: "approve" })}>
            {v.isGap ? "Confirm it's missing" : "Approve"}
          </button>
          <button className="btn" onClick={() => setMode("correct")}>
            {v.isGap ? "Add value" : "Correct"}
          </button>
          {mode === "revisit" && (
            <button className="btn btn-quiet" onClick={() => setMode("idle")}>
              Cancel
            </button>
          )}
        </div>
      )}

      {mode === "correct" && !readOnly && (
        <CorrectForm v={v} pending={review.isPending} onCancel={() => setMode("idle")} onSubmit={(body) => review.mutate(body)} />
      )}
      {review.error && <p className="error-note">{(review.error as Error).message}</p>}
    </article>
  );
}

function CorrectForm({
  v,
  pending,
  onCancel,
  onSubmit,
}: {
  v: ValueDto;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (body: { action: "correct"; value: string; note?: string; tags: (typeof CORRECTION_TAGS)[number][] }) => void;
}) {
  const [value, setValue] = useState(v.effectiveValue ?? "");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState<(typeof CORRECTION_TAGS)[number][]>([v.isGap ? "missed_field" : "wrong_value"]);
  const toggle = (t: (typeof CORRECTION_TAGS)[number]) => setTags((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]));

  return (
    <form
      className="correct-form"
      onClick={(e) => e.stopPropagation()}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ action: "correct", value, note: note || undefined, tags });
      }}
    >
      <label>
        Correct value {FORMAT_HINT[v.fieldType] && <span className="faint">({FORMAT_HINT[v.fieldType]})</span>}
        <input type="text" value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />
      </label>
      <label>
        Note (optional)
        <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div>
        <div className="faint" style={{ marginBottom: 6 }}>
          What went wrong?
        </div>
        <div className="chips">
          {CORRECTION_TAGS.map((t) => (
            <button type="button" key={t} className="chip" aria-pressed={tags.includes(t)} onClick={() => toggle(t)}>
              {TAG_TEXT[t]}
            </button>
          ))}
        </div>
      </div>
      <div className="actions" style={{ marginTop: 0 }}>
        <button className="btn btn-approve" type="submit" disabled={pending}>
          Save correction
        </button>
        <button className="btn btn-quiet" type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
