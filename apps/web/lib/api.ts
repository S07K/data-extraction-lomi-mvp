import type { ApiErrorBody, DocumentDetail, DocumentListItem, ReviewRequest, UploadResponse } from "@lomi/contracts";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, { cache: "no-store", ...init });
  const body = (await res.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!res.ok) {
    const msg = (body as ApiErrorBody | null)?.error?.message ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, msg);
  }
  return body as T;
}

export const api = {
  listDocuments: () => call<DocumentListItem[]>("/documents"),
  getDocument: (id: string, version?: number) =>
    call<DocumentDetail>(`/documents/${encodeURIComponent(id)}${version ? `?version=${version}` : ""}`),
  upload: (form: FormData) => call<UploadResponse>("/documents", { method: "POST", body: form }),
  uploadVersion: (id: string, form: FormData) =>
    call<UploadResponse>(`/documents/${encodeURIComponent(id)}/versions`, { method: "POST", body: form }),
  retry: (id: string) => call<unknown>(`/documents/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  review: (valueId: string, body: ReviewRequest) =>
    call<unknown>(`/values/${encodeURIComponent(valueId)}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
};

export const IN_FLIGHT = new Set(["queued", "extracting"]);
