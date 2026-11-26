"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DOCUMENT_TYPES } from "@lomi/contracts";
import { api } from "@/lib/api";
import { TYPE_LABEL } from "@/lib/format";

type Mode = { kind: "new" } | { kind: "version"; documentId: string; title: string; nextVersion: number };

/** One upload surface for both a new document and a revised version of an existing one. */
export function UploadDialog({ mode, open, onClose }: { mode: Mode; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [type, setType] = useState<string>("invoice");
  const [title, setTitle] = useState("");
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const reset = () => {
    setFile(null);
    setTitle("");
    upload.reset();
  };

  const upload = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.set("file", file!);
      if (mode.kind === "new") {
        form.set("type", type);
        if (title.trim()) form.set("title", title.trim());
        return api.upload(form);
      }
      return api.uploadVersion(mode.documentId, form);
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["documents"] });
      await qc.invalidateQueries({ queryKey: ["document", res.documentId] });
      if (res.deduplicated) return; // keep the dialog open to show the notice
      reset();
      onClose();
      router.push(`/documents/${res.documentId}`);
    },
  });

  const pick = (f: File | undefined) => {
    upload.reset();
    if (f) setFile(f);
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      onClose={() => {
        reset();
        onClose();
      }}
      aria-labelledby="upload-title"
    >
      <form
        method="dialog"
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (file) upload.mutate();
        }}
      >
        <h2 id="upload-title">{mode.kind === "new" ? "Upload a document" : `Upload version ${mode.nextVersion}`}</h2>
        <p className="muted dialog-lede">
          {mode.kind === "new"
            ? "Values are extracted in the background. You can keep working while it runs."
            : `A revised PDF of “${mode.title}”. Values whose evidence is unchanged keep their review; anything that changed comes back to you.`}
        </p>

        {mode.kind === "new" && (
          <>
            <fieldset className="segmented" aria-label="Document type">
              {DOCUMENT_TYPES.map((t) => (
                <label key={t} className={type === t ? "on" : undefined}>
                  <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} />
                  {TYPE_LABEL[t]}
                </label>
              ))}
            </fieldset>
            <label className="field">
              <span>Title (optional)</span>
              <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the file name" />
            </label>
          </>
        )}

        <label
          className={`dropzone ${dragging ? "dragging" : ""} ${file ? "has-file" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            pick(e.dataTransfer.files[0]);
          }}
        >
          <input type="file" accept="application/pdf" onChange={(e) => pick(e.target.files?.[0])} />
          {file ? (
            <>
              <strong>{file.name}</strong>
              <span className="faint">{(file.size / 1024).toFixed(0)} KB. Click to choose a different file.</span>
            </>
          ) : (
            <>
              <strong>Drop a PDF here</strong>
              <span className="faint">or click to choose one</span>
            </>
          )}
        </label>

        {upload.data?.deduplicated && (
          <p className="notice">This file is identical to version {upload.data.versionNumber}, so nothing new was created.</p>
        )}
        {upload.error && <p className="error-note">{(upload.error as Error).message}</p>}

        <div className="dialog-actions">
          <button type="button" className="btn btn-quiet" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!file || upload.isPending}>
            {upload.isPending ? "Uploading…" : "Upload and extract"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
