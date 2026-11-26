import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ExtractionError } from "@lomi/core";
import type { LlmProvider, LlmRequest, LlmResult } from "./types.js";

/**
 * DEVELOPMENT-ONLY provider: runs extraction through the Claude Agent SDK
 * authenticated with a Claude subscription token (`claude setup-token` →
 * CLAUDE_CODE_OAUTH_TOKEN). It exists so the author can exercise the real
 * pipeline without API credits. Production / reviewers use the `anthropic`
 * provider with an API key — apps may not offer claude.ai login to their users.
 *
 * Configured as a pure completion: no built-in tools, no filesystem settings,
 * no persisted session, structured output via JSON Schema.
 */
export class ClaudeCodeProvider implements LlmProvider {
  readonly name = "claude-code";

  constructor(
    readonly model: string,
    private readonly oauthToken: string | undefined,
  ) {
    if (!oauthToken) {
      throw new ExtractionError(
        "CLAUDE_CODE_OAUTH_TOKEN is not set (LLM_PROVIDER=claude-code). Run `claude setup-token` in a separate terminal.",
        "permanent",
      );
    }
  }

  async extract(req: LlmRequest, signal?: AbortSignal): Promise<LlmResult> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => abortController.abort(), 120_000);

    let result: SDKResultMessage | undefined;
    try {
      const run = query({
        prompt: req.user,
        options: {
          model: this.model,
          systemPrompt: req.system,
          tools: [],
          settingSources: [],
          persistSession: false,
          maxTurns: 4,
          outputFormat: { type: "json_schema", schema: req.schema },
          abortController,
          // An API key would take precedence over the subscription token — strip it.
          env: {
            ...process.env,
            ANTHROPIC_API_KEY: undefined,
            CLAUDE_CODE_OAUTH_TOKEN: this.oauthToken,
            CLAUDE_AGENT_SDK_CLIENT_APP: "lomi-extraction/0.1",
          },
        },
      });
      for await (const message of run) {
        if (message.type === "result") result = message;
      }
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      const kind = /401|unauthori[sz]ed|invalid.*token|not logged in|authentication/i.test(msg) ? "permanent" : "transient";
      throw new ExtractionError(`Claude Code run failed: ${msg}`, kind, { cause: err });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    if (!result) throw new ExtractionError("Claude Code returned no result", "transient");
    if (result.subtype !== "success" || result.is_error) {
      throw new ExtractionError(`Claude Code run ended with ${result.subtype}`, "transient");
    }
    if (result.structured_output === undefined) {
      throw new ExtractionError("Claude Code returned no structured output", "transient");
    }
    // modelUsage also lists Claude Code's small internal helper calls (e.g. a Haiku call);
    // the extraction is the model that produced the most output.
    const usedModel =
      Object.entries(result.modelUsage ?? {}).sort(([, a], [, b]) => (b.outputTokens ?? 0) - (a.outputTokens ?? 0))[0]?.[0] ?? this.model;
    return {
      output: result.structured_output,
      raw: result,
      model: usedModel,
      inputTokens: result.usage?.input_tokens ?? null,
      outputTokens: result.usage?.output_tokens ?? null,
    };
  }
}
