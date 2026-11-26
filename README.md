# Extraction review

Upload a PDF. An LLM extracts its key values. Every value then has to be approved or corrected by a reviewer, who sees it beside the exact passage it came from. When a revised version of the document arrives, reviews whose evidence didn't change carry over, and only what actually changed goes back to the reviewer.

## Run it

```sh
cp .env.example .env        # then set ANTHROPIC_API_KEY (or LLM_PROVIDER=fake to run without an LLM)
docker compose up
```

`docker compose up` starts Postgres and Redis. It then runs migrations and seeds **version 1** of the three fixture documents, and finally starts the API (`:4000`), the worker and the web UI (`:3000`). The seeded documents go through the real extraction pipeline, so they show as *Extracting* for a few seconds.

**What to click first**
1. Open http://localhost:3000. All three documents should say they need review.
2. Open the invoice. Approve a few values and correct one (pick a tag such as "Wrong value").
3. Approve the rest, then use **Upload new version** with `fixtures/documents/invoice-001.v2.pdf`.
4. When it finishes, the page says *"2 values need your review — 2 changed since the previous version; 3 kept their earlier review"*. Due date and total are shown in red with their v1 value and review. The other three show *Kept from v1*.
5. Open the market report. *Median household income* is a **gap**: the document doesn't state it, and the reason is shown.

**LLM providers** (`LLM_PROVIDER` in `.env`)

| Value | Credential | Use |
|---|---|---|
| `anthropic` (default) | `ANTHROPIC_API_KEY` | Messages API with structured outputs, `claude-sonnet-5-5` |
| `claude-code` | `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` | **Development only.** I had no API credits, so I ran the real pipeline on my Claude subscription through the Agent SDK. Not for production: apps may not offer claude.ai login to their users. |
| `fake` | none | Deterministic regex extractor for tests and demos. `FAKE_LLM_DELAY_MS=15000` makes extractions slow enough to kill. |

Without a credential, documents end up visibly **failed** with the reason (for example *"ANTHROPIC_API_KEY is not set"*). Fix `.env`, run `docker compose up -d worker`, and click **Retry extraction**.

**Failure drills:** `./scripts/chaos.sh restart | flushall | supersede | all` runs the brief's scenarios against the running stack. With the fake provider, start the stack with `FAKE_LLM_DELAY_MS=15000`.

**Tests:** `pnpm install && pnpm test` runs the unit tests (no Docker needed). `pnpm test:integration` runs the integration tests against real Postgres and Redis, which Testcontainers starts, so Docker must be running. CI runs both.

## Layout

```
apps/
  api/          Fastify HTTP API. Writes Postgres and rings the queue. Never calls the LLM.
  worker/       BullMQ consumer + reconciler. Claims a version, parses, extracts, commits.
  web/          Next.js review UI. A same-origin /api proxy, so the API URL is a runtime setting.
packages/
  core/         Pure domain logic, no IO: field specs, value normalization, verbatim-evidence
                validation, carry-over rules, review/progress rules. Most unit tests live here.
  db/           Prisma schema + migrations, and every transactional operation
                (upload/supersede, claim/heartbeat/commit/fail, reconcile, review, read models).
  extraction/   IO adapters: PDF → text (unpdf), LLM providers, and the one runExtraction step.
  queue/        The Redis side: queue name, job payload ({versionId}), deterministic job ids.
  contracts/    zod request schemas + response DTOs shared by api and web.
  config/       Shared tsconfig and ESLint.
```

The boundaries follow what changes for different reasons:
- **Correctness rules** live in `core` and are pure, so the rules the brief tests (verbatim evidence, gaps, "unchanged") are unit-tested without a database.
- **Every invariant that needs a transaction** lives in `db`, so the API and worker can't each re-implement it differently.
- **The apps are thin.** No package imports an app, and `web` sees only `contracts`, never Prisma.

`turbo.json` wires `build`, `typecheck`, `lint`, `test` and `test:integration` through the dependency graph. `db:generate` runs before anything compiles against Prisma, and builds are cached by inputs.

## Schema

```
documents 1─* document_versions 1─1 version_files (PDF bytes)
                     │ 1─* extraction_runs (one per attempt: prompt, raw response, tokens, outcome)
                     │ 1─* extracted_values ──previous_value_id──▶ same field in the base version
                                   1─* reviews (append-only) ──carried_from_review_id──▶ review it was copied from
```

- **`document_versions`** is the unit of work. It holds the status (`queued | extracting | extracted | failed | superseded`), the lease (`lease_owner`, `lease_expires_at`), the attempt budget (`attempts`, `attempt_limit`, `next_attempt_at`) and **its own parsed text**. Evidence for version N is validated, highlighted and compared against N's text forever, even after N+1 exists.
- **`extracted_values` are immutable model output.** A value either has verified evidence (quote + character offsets) or is a **gap** (`value = null` + `gap_reason`). A CHECK constraint enforces "exactly one of the two". `UNIQUE(version_id, field)` is the idempotency backstop.
- **Reviews are annotations, not overwrites.** A correction is a review row with `corrected_value`, an optional `note` and `tags` from a fixed taxonomy (`wrong_value`, `wrong_format`, `wrong_evidence`, `should_be_gap`, `missed_field`, `other`). The UI shows the effective value (correction ?? extracted), with the extracted one struck through. Keeping model output and human truth in separate columns gives a ready-made eval dataset.
- **Reviews are append-only.** The latest row is the effective one. A carried-over review is a new row on the new value with `source = carried_over`, pointing at the original. Old versions keep their reviews untouched.
- **A partial unique index** (`one_inflight_version_per_document`) allows at most one queued/extracting version per document. The supersede policy is therefore enforced by the database, not just by the code.

## How extraction is coordinated

**Postgres is the truth. Redis is a doorbell.** A BullMQ job carries only `{versionId}`, and everything durable is in Postgres: status, attempts, backoff, leases, values, reviews, prompts and raw LLM responses.

```
POST /documents ─tx─▶ version(queued) + PDF bytes ─commit─▶ enqueue (best effort, 1.5s cap) ─▶ 202
worker: claim     UPDATE … SET status='extracting', lease=(token, now+60s), attempts+1
                  WHERE id=? AND status='queued' AND next_attempt_at<=now      (0 rows ⇒ skip the job)
        heartbeat every 15s; a lost lease aborts the LLM call
        parse once (text stored on the version) → LLM → validate evidence → one commit tx:
                  lock document row; still extracting AND lease token still mine?
                  insert values, compute carry-over, copy reviews, status='extracted'
                  (otherwise the result is logged as `discarded`)
reconciler (worker start + every 15s):
        queued & due            → enqueue (deterministic job id ⇒ BullMQ dedupes)
        extracting & lease expired → queued again, or failed once attempts are exhausted
```

| What happens | Why nothing is lost or stuck |
|---|---|
| Upload while Redis is down | The version is committed as `queued`. Enqueue times out after 1.5s and the reconciler enqueues it later. Upload still returns 202 (tested). |
| `docker compose restart` / killed worker mid-extraction | The lease stops being heartbeated. On restart the worker expires its own previous leases immediately (same container hostname + pid); otherwise the TTL runs out. The reconciler re-queues the version and it completes as attempt 2. After 3 lost attempts it becomes `failed` (retryable), never stuck. |
| `FLUSHALL` + restart | No state lives in Redis. The reconciler rebuilds the queue from `queued` rows and expired leases. |
| Same version extracted twice (retry, duplicate job, impatient user) | The conditional claim, the lease token check at commit, and `UNIQUE(version_id, field)` all prevent it. Re-uploading identical bytes returns the existing version (sha256). |
| LLM / parse error | It becomes a state. Transient errors (429, 5xx, network, malformed output) re-queue with exponential backoff stored in `next_attempt_at`. Permanent errors (unreadable PDF, bad credentials, refusal) become `failed` with the reason. **Retry extraction** raises `attempt_limit` instead of resetting `attempts`, so run numbering stays unique. |
| Postgres down | The API returns 500 and the worker's jobs fail. Nothing is half-written, because every transition is a single transaction. Once Postgres is back, the reconciler resumes. |

Every attempt writes an `extraction_runs` row with the prompt, the raw provider response, the model, tokens, latency and outcome. That includes runs that failed or were discarded, so every extraction can be debugged (`GET /documents/:id/versions/:n/runs`).

## Hallucination defense

1. The prompt asks for the **exact passage, including its label** (`Due Date: 2025-10-14`, not `2025-10-14`). It also says never to compute or infer, and to report a missing field as a gap with a reason.
2. **Verbatim check:** the quote must occur in *this version's* parsed text, either as an exact substring or with whitespace differences only (PDF extraction breaks lines inconsistently). Nothing else is fuzzy. A failed check becomes a **gap** whose reason records what the model claimed. The value itself is never stored.
3. **Value-in-quote check:** the canonicalized value must literally appear in its own quote (dates are parsed, numbers compared numerically). A real quote paired with the wrong number becomes a gap.
4. The stored evidence is the slice of the document text, not the model's string, plus offsets for highlighting.

## What "unchanged" means (carry-over)

Revising a document shifts every character offset: the v2 invoice inserts a heading suffix and a paragraph. So offsets are never compared. For each field, compared with the **latest extracted** earlier version:

- **Unchanged:** the canonical values are equal **and** either the whitespace-normalized quotes are equal, **or** the old quote still appears verbatim in the new text. The second rule protects against the model wording its quote differently between runs.
- **Both versions are gaps:** unchanged.
- **Anything else is changed.** The field goes back to pending, with the previous value, its review and its old quote shown in red.

The acceptance test runs the real fixture PDFs through the real parser. It asserts that exactly `due_date` and `total_amount` change, even though every offset moved.

## Decisions the brief left open

| Question | Choice | Why |
|---|---|---|
| Correction model | **Annotation beside the value** (with note + tags) | Model output stays immutable, the audit trail is complete, and evals come for free |
| New version while the previous one is extracting | **Supersede** | No LLM spend on a stale version. The carry-over base is always well defined. Enforced by a partial unique index. |
| Which version can be reviewed | The **latest extracted** version | While v2 extracts, v1 stays reviewable, and v2's commit picks up those reviews (the document row lock serializes them). Older versions are readable but return 409 on review. |
| Parsed text: store or re-parse | **Store per version** | Evidence for version N must always validate against N's text, even if the parser changes |
| UI freshness | **Poll every 2s, only while something is queued/extracting** | Extractions take seconds and pages are small. Polling survives API restarts with no extra infrastructure. SSE would add moving parts for no visible gain. |
| Where PDFs live | **Postgres `bytea`** in a separate table | Upload is one transaction, so there are no orphaned files or rows. Fine for one-page fixtures; at scale they would go to object storage. |
| Retries | **In Postgres** (attempt budget + `next_attempt_at`) | A FLUSHALL can't reset or lose them. BullMQ runs each job once. |
| Framework / ORM / UI | Fastify, Prisma 7 (pg driver adapter), Next.js 16 | Small API with built-in schema validation; Lomi's ORM; App Router |

## What I cut, and what I'd do next

- **Auth and per-reviewer identity.** Reviews record `reviewer = "reviewer"`. Next: Clerk or another auth provider, and the reviewer id on every review.
- **Cancel in-flight LLM calls on supersede.** A superseded v1 finishes its call and is discarded at commit. Next: poll the lease more often, or use LISTEN/NOTIFY to abort sooner.
- **OCR and multi-page layout.** Scanned PDFs fail as `failed: no text layer`.
- **Live deployment.** Local only. The images are production-shaped (standalone Next.js, `pnpm deploy` bundles); Cloud Run (api, web) plus a worker on a VM or Cloud Run jobs, with Cloud SQL and Memorystore, would be next.
- **AI connections.** A per-workspace provider registry: OpenAI via "Sign in with ChatGPT" (partner client ID in production) or bring-your-own API key, encrypted. Anthropic has no OAuth route for subscriptions, so it stays on API keys.
- **UI:** keyboard review (J/K/A/C), bulk approve, and a side-by-side diff of whole version texts.

## At 10,000 documents

- **Read models:** progress is computed from rows on each read. Keep per-version counters, updated in the review/commit transactions (or a materialized view), and paginate `GET /documents`.
- **Storage:** move PDF bytes to object storage (keep the sha256 + key in Postgres). Store parsed text compressed, or move it out of the hot table.
- **Reconciler:** it scans by `(status, next_attempt_at)` and `(status, lease_expires_at)`, which are both indexed. With many workers, run it under a Postgres advisory lock so only one instance sweeps.
- **Throughput:** scale workers horizontally; claims are already exclusive. Respect provider rate limits with a BullMQ rate limiter. Use prompt caching (the system prompt and schema are a stable prefix) and the Batches API for bulk backfills (about 50% cheaper).
- **Quality:** turn correction tags into an eval set per field and per prompt version (`prompt_version` is stored on every run), and track the gap/hallucination rate per model.
- **Operations:** tracing per version id, alerts on `failed` rate and queue age, and retention for `extraction_runs` raw responses.

## Notes

- I built this with Claude Code as a pair. The session logs are linked in the submission. The design decisions above were made explicitly, and `docs/PLAN.md` records the plan we agreed before writing code.
- Host ports are 3000 (web), 4000 (API), 55432 (Postgres) and 56379 (Redis). The last two are non-default to avoid clashing with local installs.
