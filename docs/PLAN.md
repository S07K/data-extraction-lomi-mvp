# Plan — Lomi Labs take-home (PDF → LLM extraction → human review)

Deadline: **Sat 28 Nov 2026, 23:59 UTC**. Status: **draft for review — no code yet.**

## 1. Decisions locked with the user

| Decision | Choice | One-line reason |
|---|---|---|
| Monorepo | Turborepo + pnpm workspaces | Required |
| API | Fastify + zod | Small API, schema validation built in, multipart support |
| DB layer | Prisma on Postgres | Lomi's stack; typed client + `migrate deploy` in compose |
| Queue | BullMQ on Redis | Required; Redis only *coordinates* |
| Frontend | Next.js (App Router), client-side polling | Matches JD |
| LLM | Anthropic, Sonnet 5.5 (`ANTHROPIC_MODEL` env), forced tool-use output | Reliable structured output + verbatim quoting |
| LLM provider adapter | `LLM_PROVIDER = anthropic \| claude-code \| fake` (see §5a) | Reviewers use an API key; the author has no API credits, so dev runs use a Claude Code subscription token |
| Corrections | **Annotation model**: extracted value is immutable; review rows hold `corrected_value`, `note`, `tags[]` | Provenance + free eval dataset (model output vs human truth) |
| Correction tags | Fixed enum: `wrong_value`, `wrong_format`, `wrong_evidence`, `should_be_gap`, `missed_field`, `other` | Queryable, consistent for evals |
| Version arrives mid-extraction | **Supersede**: N+1 accepted, N marked `superseded`, N's result discarded | No LLM spend on a stale version, no ambiguity about the carry-over base |
| "Evidence unchanged" | **Option A**: normalized quote + normalized value equal, **or** old quote still appears verbatim in new text with the same value | Position-independent; on the fixture it yields exactly `due_date` + `total_amount` |
| UI freshness | Poll every 2s only while something is `queued`/`extracting` | Extractions take seconds; survives restarts with zero infra |
| Deploy | None (local only) | Explained in the README |
| Repo | Private GitHub repo, made public later | — |

## 2. Decisions I made inside those choices (flag any you disagree with)

1. **Reviewable version = the latest *extracted* version.** While v2 is extracting, v1 stays reviewable. v2's commit reads v1's reviews in the same transaction (serialized by a `SELECT … FOR UPDATE` on the document row, which `POST /values/:id/review` also takes). Reviews on older versions return `409` (they stay readable).
2. **PDF bytes are stored in Postgres** (`bytea`, in a separate `version_files` table so they're never loaded by accident). One transaction covers upload + version row, so there are no orphaned files. README notes S3/GCS at scale.
3. **Parsed text is stored per version** (`document_versions.parsed_text`), along with the parser name/version. Evidence validation and highlighting for version N always use N's own stored text.
4. **Reviews are append-only.** A value's current review is the latest row. Re-reviewing a carried-over value replaces its effective review but keeps history.
5. **Gaps are reviewable.** Approve = "confirmed absent". Correct = supply a value (typically tagged `missed_field`).
6. **Duplicate upload guard:** uploading a file whose sha256 equals the current version's returns the existing version (`200`), not a new one.
7. **"Verbatim" tolerates whitespace only.** An exact substring match is tried first, then a match with whitespace collapsed, mapped back to offsets (PDF text extraction adds spacing artifacts). Nothing else is fuzzy.
8. **Value-in-evidence check:** a type-aware normalizer (money/date/percent/number/string) checks the extracted value is actually supported by its quote. If not → gap (`value not supported by evidence`).
9. **Retries live in Postgres, not BullMQ.** BullMQ `attempts: 1`. Transient errors (429/5xx/timeout) → back to `queued` with a delay, up to **3 attempts**. Deterministic errors (unparseable PDF, invalid LLM output after one repair) → `failed` immediately. `POST /documents/:id/retry` resets a failed version.
10. **A fake LLM provider** (`LLM_PROVIDER=fake`, regex-based and deterministic) for tests and for running without an API key. Real runs use Anthropic.
11. **PDF parser: `unpdf`** (maintained pdf.js wrapper, works in Node).
12. **Seeding goes through the real pipeline:** the seed inserts v1 rows as `queued`, and the worker's reconciler enqueues them. Without credentials for the selected provider, they end up visibly `failed` with a clear reason (e.g. "ANTHROPIC_API_KEY missing"), and are retryable.

## 3. Monorepo layout

```
apps/
  api/        Fastify HTTP API. Writes Postgres, enqueues job ids. Never calls the LLM.
  worker/     BullMQ consumer + reconciler. Parse → LLM → validate → commit (+ carry-over).
  web/        Next.js review UI. /api/* rewritten to the api service.
packages/
  core/       PURE domain logic, no IO: field specs, normalizers, evidence validation,
              carry-over diff, status rules. Most unit tests live here.
  db/         Prisma schema, migrations, client, seed (reads fixtures/).
  contracts/  zod DTOs shared by api + web (request/response shapes).
  queue/      Queue name, job payload type, enqueue helper (shared by api + worker).
  config/     Shared tsconfig + ESLint flat config.
fixtures/     Copied from the assignment repo.
```
Boundary rule: `core` imports nothing internal; `contracts` imports only `core` types; apps never import each other.

**turbo.json pipeline:** `build` (dependsOn `^build`, outputs `dist/**`, `.next/**`), `db:generate` (before build/typecheck), `typecheck`, `lint`, `test` (unit, no Docker), `test:integration` (Testcontainers Postgres + Redis). Root scripts: `pnpm build|lint|test|test:integration`.

## 4. Schema (Prisma, simplified)

```
Document          id, type(enum invoice|lease|market_report), title, createdAt
DocumentVersion   id, documentId, versionNumber, sha256, status, failureReason,
                  parsedText?, parserVersion?, attempts, leaseOwner?, leaseExpiresAt?,
                  nextAttemptAt?, supersededById?, createdAt, extractedAt?
                  UNIQUE(documentId, versionNumber)
                  status ∈ queued | extracting | extracted | failed | superseded
VersionFile       versionId (PK/FK), bytes(bytea), mimeType, sizeBytes
ExtractionRun     id, versionId, attempt, model, prompt, rawResponse(json), error?,
                  inputTokens, outputTokens, latencyMs, outcome(succeeded|failed|discarded), createdAt
ExtractedValue    id, versionId, runId, field, fieldType,
                  value?(canonical text), unit?, evidence?, evidenceStart?, evidenceEnd?,
                  gapReason?, carryStatus(new|unchanged|changed), previousValueId?
                  UNIQUE(versionId, field)        ← idempotency
Review            id, valueId, action(approved|corrected), correctedValue?, note?,
                  tags(CorrectionTag[]), source(human|carried_over), carriedFromReviewId?,
                  reviewer, createdAt            (append-only)
```
- The document's displayed status = its latest version's status. Reviewable values = latest `extracted` version.
- Progress buckets (per reviewable version): **pending** (no review), **approved**, **corrected**, **carried_over** (current review has `source = carried_over`).
- Value relations: `previousValueId` links a value to the same field in the base version, so the UI can show "was X, reviewed as Y".

## 5. Extraction coordination (Redis vs Postgres)

**Postgres = truth. Redis = a doorbell.** A BullMQ job carries only `{versionId}` with `jobId = ${versionId}:${attempt}` (BullMQ dedupes).

```
upload ─tx─▶ version(queued) + file ─commit─▶ enqueue(best effort) ─▶ 202
worker: claim   UPDATE … SET status='extracting', leaseOwner, leaseExpiresAt=now()+60s,
                attempts+=1 WHERE id=$1 AND status='queued'      (0 rows → ack & skip)
        heartbeat every 15s extends the lease
        parse (store parsedText once) → LLM (temp 0, forced tool) → log ExtractionRun
        validate evidence (core) → gaps for anything unverifiable
        commit tx:  lock document row; re-check status='extracting' AND leaseOwner=me
                    (else run.outcome=discarded — superseded/stolen)
                    insert values ON CONFLICT DO NOTHING; compute carry-over vs base;
                    copy reviews for unchanged; status='extracted'
reconciler (worker startup + every 30s):
        queued & due & not in Redis           → enqueue
        extracting & leaseExpiresAt < now     → attempts<3 ? queued : failed("worker lost")
```
How each required behaviour is met:
- **Instant upload:** the API only writes a row and pushes a job id.
- **Restart / killed container:** the lease expires → the reconciler requeues the version, or marks it failed after 3 attempts.
- **FLUSHALL:** nothing durable lives in Redis. The reconciler re-enqueues `queued` versions, and expired leases cover `extracting` ones.
- **Double extraction:** the conditional claim, the lease-owner check at commit, and `UNIQUE(versionId, field)` together prevent duplicate values.
- **Failure is a state:** `failed` + `failureReason` + run log, plus a retry endpoint.
- **Supersede:** the upload tx sets older `queued|extracting` versions to `superseded`. Their in-flight commit fails the status check, so the run is logged as `discarded`.

## 5a. LLM providers

One interface: `extract({ system, prompt, schema }) → { output, raw, model, usage }`. The prompt, schema, evidence validation and run logging are shared, so every provider gets the same hallucination defense.

| Provider | Auth (env) | Mechanism | Who |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | `@anthropic-ai/sdk` Messages API, forced tool use | Default; reviewers |
| `claude-code` | `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) | `@anthropic-ai/claude-agent-sdk` `query()` with `outputFormat: json_schema`, tools disabled, `model: "sonnet"` | **Dev only**: the author testing without API credits |
| `fake` | none | Deterministic regex extractor | Unit/integration tests |

Notes:
- The `claude-code` provider is documented in the README as a dev convenience and is not meant for production. Anthropic's terms don't allow apps to offer claude.ai login to their users, and `setup-token` is for your own scripts/CI.
- `ANTHROPIC_API_KEY` takes precedence over the OAuth token in Claude Code, so the worker unsets it when `LLM_PROVIDER=claude-code`.
- Smoke-test the token from inside the worker container before building on it. The docs don't explicitly confirm that the SDK reads `CLAUDE_CODE_OAUTH_TOKEN`.
- **Future (README only):** an OpenAI provider, plus "AI Connections" via OpenAI Sign in with ChatGPT (partner client ID in prod, localhost flow in dev). Cut for time.

## 6. Carry-over algorithm (packages/core, pure)

Base = latest `extracted` version with a lower number. For each field:
- No base value → `new`, pending.
- Both are gaps → `unchanged`.
- Only one is a gap → `changed`.
- `norm(quote_new) == norm(quote_old) && norm(value_new) == norm(value_old)` → `unchanged`.
- Else if `norm(quote_old)` occurs in `norm(parsedText_new)` and the normalized values are equal → `unchanged` (protects against the LLM wording the quote differently between runs).
- Else → `changed`: pending, with `previousValueId` set.
- `unchanged` + the base value has a review → insert a copied review (`source=carried_over`, `carriedFromReviewId`). Corrections carry their `correctedValue` with them.

`norm` = Unicode NFKC, collapse whitespace, trim. Values use the type-aware canonical form. Acceptance test: fixture v1 → v2 gives exactly `due_date` and `total_amount` as `changed`.

## 7. API

| Method | Path | Notes |
|---|---|---|
| POST | `/documents` | multipart `type`, `title?`, `file` → `202 {id, version}` |
| POST | `/documents/:id/versions` | multipart `file` → `202`; supersedes in-flight; sha dedupe → `200` |
| GET | `/documents` | list: type, title, current version + status, progress *(extra, for UI)* |
| GET | `/documents/:id` | current version, status, failureReason, values (+evidence, offsets, carryStatus, current review, previous value + review), reviewable version |
| GET | `/documents/:id/versions/:n` | any historical version + its values/reviews + parsed text *(extra)* |
| GET | `/versions/:id/file` | original PDF *(extra)* |
| POST | `/documents/:id/retry` | failed → queued *(extra)* |
| POST | `/values/:id/review` | `{action:"approve"}` or `{action:"correct", value, note?, tags?}`; 409 if not the reviewable version |
| GET | `/documents/:id/progress` | `{pending, approved, corrected, carriedOver, total}` |
| GET | `/health` | DB + Redis check |

## 8. Review UI

- **`/` list:** title, type, `vN`, status badge (queued/extracting spinner/extracted/failed + Retry), progress bar ("2 need review"), upload button. Polls only while a document is in flight.
- **`/documents/[id]`:**
  - Top banner states what needs attention ("2 values changed in v2 — review them").
  - Values are sorted **changed → pending → gaps → carried-over/approved**.
  - Each row: field, effective value (with a "corrected" badge and the original struck through), evidence quote, carry badge, Approve / Correct (inline form: value, note, tag chips).
  - Changed rows show the previous value and previous review side by side.
  - Right pane: parsed text with the active quote highlighted (using stored offsets).
  - Version switcher gives a read-only view of old versions. Plus an "Upload new version" button.

## 9. Docker compose

`postgres` (healthcheck, volume) · `redis` · `migrate` (one-shot: `prisma migrate deploy` + idempotent seed of v1 fixtures) · `api` · `worker` · `web`. All app services `depends_on: migrate: service_completed_successfully`, with `restart: unless-stopped`. `.env.example` provides `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, and `LLM_PROVIDER`. Multi-stage Dockerfiles use `turbo prune --docker`.

`scripts/chaos.sh`: kill the worker mid-extraction, `FLUSHALL` + restart, upload v2 during v1's extraction. Used for verification and the Loom demo.

## 10. Tests (what's most likely to break)

- **Unit (core):**
  - Verbatim validation: exact, whitespace-tolerant, hallucinated quote → gap, value not in quote → gap.
  - Normalizers: money, dates, percent.
  - Carry-over on the **real fixture texts** (exactly 2 changed); shifted-text and reworded-quote cases.
- **Integration (Testcontainers, fake LLM):**
  - The same version extracted twice → 5 values, not 10.
  - Lease expiry → requeue → completes.
  - FLUSHALL → reconciler recovers queued + extracting.
  - LLM error → `failed` → retry → `extracted`.
  - v2 during v1 extraction → v1 `superseded`, run discarded, v2 carries from the last extracted version.
  - Review on an old version → 409.
  - Correction carried over keeps `correctedValue`.
  - Upload responds fast while the fake LLM sleeps 5s.

## 11. Build order and timeline

- **Thu 26:**
  1. git init + private repo, scaffold turbo/pnpm/config packages, compose with pg/redis
  2. Prisma schema + migration + seed
  3. `core` + unit tests
- **Fri 27:**
  4. worker (claim/lease/commit/reconciler, Anthropic + fake provider)
  5. API
  6. integration tests
  7. UI
- **Sat 28:**
  8. Full `docker compose up` from clean + chaos script
  9. README
  10. Session logs → scrubbed → public gist (with your OK)
  11. Loom talk track
  12. Submit with buffer

**Cut first if short on time:** text highlighting, version switcher UI, `wrong_format` normalizer edge cases. **Never cut:** recovery/idempotency/evidence-validation tests.

## 12. Submission logistics

- **Session logs:** copy `~/.claude/projects/-Users-shubham-personal-lomilabs-assignment/*.jsonl` (one per session), or use `/export`. Scrub API keys/email, then upload with `gh gist create --public` (one file per session). Never commit them to the repo. **Never paste the API key into chat**; it goes into `.env` only.
- **Loom:** I'll write a ~5 min talk track + click path (list → review → upload v2 → 2 changed → FLUSHALL live). Check the link in incognito.
- Before submitting, make the repo public (or grant access) and check every link in incognito.
