import Anthropic from "@anthropic-ai/sdk";
import { ExtractionError } from "@lomi/core";
import type { LlmProvider, LlmRequest, LlmResult } from "./types.js";

/**
 * Messages API with structured outputs (`output_config.format`): the response is
 * constrained to our JSON Schema. (Forced tool_choice is rejected by Sonnet 5.5,
 * so structured outputs is the supported way to get schema-shaped JSON back.)
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(
    readonly model: string,
    apiKey: string | undefined,
  ) {
    if (!apiKey) throw new ExtractionError("ANTHROPIC_API_KEY is not set (LLM_PROVIDER=anthropic)", "permanent");
    // SDK retries cover brief 429/5xx blips inside one attempt; our attempt budget covers the rest.
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 90_000 });
  }

  async extract(req: LlmRequest, signal?: AbortSignal): Promise<LlmResult> {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: 4096,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { effort: "low", format: { type: "json_schema", schema: req.schema } },
        },
        { signal },
      );
    } catch (err) {
      throw classifyAnthropicError(err);
    }

    if (response.stop_reason === "refusal") {
      throw new ExtractionError("Model declined to extract this document (refusal)", "permanent");
    }
    if (response.stop_reason === "max_tokens") {
      throw new ExtractionError("Model output was truncated (max_tokens)", "transient");
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    let output: unknown;
    try {
      output = JSON.parse(text);
    } catch {
      throw new ExtractionError("Model returned non-JSON output", "transient");
    }
    return {
      output,
      raw: response,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}

/** Retryable: 429, 5xx/overloaded, network/timeout. Everything else is a configuration or request problem. */
export function classifyAnthropicError(err: unknown): ExtractionError {
  // APIConnectionError (incl. timeouts) subclasses APIError in the TS SDK — check it first.
  if (err instanceof Anthropic.APIConnectionError) {
    return new ExtractionError(`LLM connection error: ${err.message}`, "transient", { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new ExtractionError("LLM rate limited (429)", "transient", { cause: err });
  }
  if (err instanceof Anthropic.InternalServerError) {
    return new ExtractionError(`LLM server error (${err.status})`, "transient", { cause: err });
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new ExtractionError(`LLM credentials rejected (${err.status}): check ANTHROPIC_API_KEY`, "permanent", { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new ExtractionError(`LLM request rejected (${err.status}): ${err.message}`, "permanent", { cause: err });
  }
  if (err instanceof Error && err.name === "AbortError") {
    return new ExtractionError("LLM call aborted (lease lost)", "transient", { cause: err });
  }
  return new ExtractionError(`Unexpected LLM error: ${(err as Error)?.message ?? String(err)}`, "transient", { cause: err });
}
