import type { DocumentType } from "@lomi/core";

export interface LlmRequest {
  docType: DocumentType;
  documentText: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

export interface LlmResult {
  /** The structured object the model returned (validated by the caller). */
  output: unknown;
  /** Full raw provider response, stored on the extraction run for debugging. */
  raw: unknown;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/**
 * Providers only move bytes and classify errors (throwing ExtractionError with
 * kind transient|permanent). Prompting, schema and validation are shared.
 */
export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  extract(req: LlmRequest, signal?: AbortSignal): Promise<LlmResult>;
}
