import type { FailureKind } from "@lomi/core";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCodeProvider } from "./claude-code.js";
import { FakeProvider } from "./fake.js";
import type { LlmProvider } from "./types.js";

export type ProviderName = "anthropic" | "claude-code" | "fake";

/**
 * Selected by LLM_PROVIDER. Construction errors (missing credentials) are thrown
 * as permanent ExtractionErrors at extraction time, so a misconfigured stack shows
 * documents as `failed` with a clear reason instead of crashing the worker.
 */
export function createProvider(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  const name = (env["LLM_PROVIDER"] ?? "anthropic") as ProviderName;
  switch (name) {
    case "anthropic":
      return new AnthropicProvider(env["ANTHROPIC_MODEL"] ?? "claude-sonnet-5-5", env["ANTHROPIC_API_KEY"]);
    case "claude-code":
      return new ClaudeCodeProvider(env["CLAUDE_CODE_MODEL"] ?? "sonnet", env["CLAUDE_CODE_OAUTH_TOKEN"]);
    case "fake":
      return new FakeProvider({
        delayMs: env["FAKE_LLM_DELAY_MS"] ? Number(env["FAKE_LLM_DELAY_MS"]) : 0,
        failWith: (env["FAKE_LLM_FAIL"] as FailureKind | undefined) || undefined,
      });
    default:
      throw new Error(`Unknown LLM_PROVIDER "${name}" (expected anthropic | claude-code | fake)`);
  }
}

export { AnthropicProvider, ClaudeCodeProvider, FakeProvider };
export type { FakeOptions } from "./fake.js";
export type { LlmProvider, LlmRequest, LlmResult } from "./types.js";
