import {
  buildExtractionPrompt,
  ExtractionError,
  llmOutputSchema,
  PROMPT_VERSION,
  validateExtraction,
  type DocumentType,
  type ValidatedValue,
} from "@lomi/core";
import type { LlmProvider } from "./providers/types.js";

export interface ExtractionOutcome {
  values: ValidatedValue[];
  log: {
    model: string;
    promptVersion: string;
    prompt: { system: string; user: string; schema: Record<string, unknown> };
    rawResponse: unknown;
    inputTokens: number | null;
    outputTokens: number | null;
    latencyMs: number;
  };
}

/**
 * One LLM extraction for one version's text: prompt → provider → schema check →
 * evidence validation against THIS text. On error, the ExtractionError carries a
 * partial log (prompt, and raw response when we got one) for the run record.
 */
export async function runExtraction(
  provider: LlmProvider,
  docType: DocumentType,
  documentText: string,
  signal?: AbortSignal,
): Promise<ExtractionOutcome> {
  const prompt = buildExtractionPrompt(docType, documentText);
  const started = Date.now();
  const result = await provider.extract({ docType, documentText, ...prompt }, signal);
  const latencyMs = Date.now() - started;
  const log = {
    model: result.model,
    promptVersion: PROMPT_VERSION,
    prompt,
    rawResponse: result.raw,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    latencyMs,
  };

  const parsed = llmOutputSchema.safeParse(result.output);
  if (!parsed.success) {
    throw Object.assign(
      new ExtractionError(`Model output did not match the schema: ${parsed.error.issues[0]?.message ?? "invalid"}`, "transient"),
      { log },
    );
  }
  return { values: validateExtraction(docType, documentText, parsed.data), log };
}
