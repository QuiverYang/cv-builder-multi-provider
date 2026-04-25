# Tasks: cv-builder-multi-provider
**Input**: Design documents from `.prospec/changes/cv-builder-multi-provider/`
**Prerequisites**: plan.md, delta-spec.md, **v1 (`projects/cv-builder-web-app`) in `verification-passed` state**

## Format: `[ID] [P?] Description (~lines)`
- **[P]**: 可並行執行（不同檔案，無相互依賴）
- **~N lines**: 預估變更行數
- 每個 task 結尾標 `Source:` 對應 delta-spec.md 的 REQ ID

---

## Phase 0: Bootstrap from v1

- [x] T1 Copy v1 source tree from `projects/cv-builder-web-app/` to `projects/cv-builder-multi-provider/` (exclude v1 `.git/`, `node_modules/`, `tmp-renders/`, `verification-*.md`, `IMPLEMENTATION.md`, `smoke.log`, v1 `.prospec/`, `.prospec.yaml`, v1 `prospec/` — v2 prospec docs already exist); fresh `git init` already done at design start so DO NOT re-init; bump `package.json` `name` → `cv-builder-multi-provider`, `version` → `2.0.0`; reset `README.md` to a 1-line stub (full README rewritten in T17); refresh `.gitignore` to cover `node_modules/`, `tmp-renders/`, `*.log`, `.env`. ~30 lines. Source: REQ-MIGRATE-001.
- [x] T2 Update `package.json` deps: add `openai` (latest minor), `@google/genai` (latest minor), keep `@anthropic-ai/sdk` and `hono`; run `npm install`; commit lockfile. ~15 lines. Source: REQ-ADAPTER-001, REQ-HEALTH-001.

## Phase 1: Server foundations (provider-agnostic)

- [x] T3 [P] Create `server/error-taxonomy.js`: export 6 codes (`INVALID_KEY`, `RATE_LIMITED`, `OVERLOADED`, `TIMEOUT`, `MODEL_NOT_FOUND`, `UPSTREAM_ERROR`); helper `mapHttpStatus(status, defaultCode='UPSTREAM_ERROR')` covering 401→INVALID_KEY / 402→RATE_LIMITED / 404→MODEL_NOT_FOUND / 429→RATE_LIMITED / 503,529→OVERLOADED; factory `makeErrorEvent(code, message_zh)`; per-provider mapper helpers `mapAnthropicError`, `mapOpenAIError`, `mapGeminiError`, `mapGithubError`. ~80 lines. Source: REQ-ERROR-001.
- [x] T4 [P] Create `server/redact.js`: export `redact(str)` applying 4 regex patterns (`sk-ant-[A-Za-z0-9_\-]+`, `sk-[A-Za-z0-9_\-]+`, `AIza[A-Za-z0-9_\-]{35}`, `(ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})`) replaced with `***REDACTED***`; export `redactObject(o)` (handles Errors + nested objects via JSON round-trip) and `redactingLogger(base)` wrapper. ~50 lines. Source: REQ-REDACT-001.
- [x] T5 [P] Create `server/redact.test.mjs`: one positive fixture per pattern (4) + one mixed-string fixture + one no-match fixture + 2–3 negative fixtures (bare `sk-ant-`, short `AIza`, random `sk-` short string); runnable via `node --test`. ~60 lines. Source: REQ-REDACT-002.

## Phase 2: Provider adapters (each independent — all [P])

- [x] T6 [P] Create `server/providers/anthropic.js`: export `streamChat({apiKey, systemPrompt, messages, model, maxTokens, abortSignal})`; resolve model from arg → `process.env.ANTHROPIC_MODEL` → `claude-sonnet-4-6`; pass `systemPrompt` as top-level `system` field; consume `client.messages.stream()`; emit `{type:'text_delta', delta}` per `content_block_delta` via `TextDecoder({stream:true})` (UTF-8 boundary buffering); track `lastByteAt` and run a 2s-interval idle watchdog that aborts upstream + emits `TIMEOUT` after 60s no-byte; on natural close with `bytesEmitted===0` synthesize `UPSTREAM_ERROR` with the canonical zh message; on error map via `mapAnthropicError`; honour `abortSignal` (pass to SDK + close stream). ~140 lines. Source: REQ-ADAPTER-001/002/004/005/007/008/009, REQ-ERROR-001.
- [x] T7 [P] Create `server/providers/openai.js`: same interface + same UTF-8 buffering + 60s watchdog + empty-stream synthesis + abort handling; default `gpt-4o-mini`, env `OPENAI_MODEL`; prepend `{role:"system", content: systemPrompt}` to messages; use `client.chat.completions.create({stream:true})` with `{signal: abortSignal}`; emit `text_delta` per non-empty `chunk.choices[0].delta.content`; error map via `mapOpenAIError`. ~140 lines. Source: REQ-ADAPTER-001/002/004/005/007/008/009, REQ-ERROR-001.
- [x] T8 [P] Create `server/providers/gemini.js`: same interface + UTF-8 buffering + 60s watchdog + empty-stream synthesis + abort handling; default `gemini-2.0-flash`, env `GEMINI_MODEL`; rewrite incoming `{role:'assistant'}` → `{role:'model'}`; **pad empty `messages` with `[{role:'user', parts:[{text:' '}]}]`** (Gemini SDK rejects empty); pass `systemPrompt` via `systemInstruction`; on `systemInstruction` size-limit error fall back to prepending it as a `user` turn and `console.warn` a redacted line containing literal `systemInstruction overflow`; use `@google/genai` `generateContentStream`; emit `text_delta` per `chunk.text` getter; error map via `mapGeminiError`; AbortSignal via SDK option + manual close. ~170 lines. Source: REQ-ADAPTER-001/002/004/005/006/007/008/009, REQ-ERROR-001.
- [x] T9 [P] Create `server/providers/github.js`: reuse `openai` SDK with `baseURL: 'https://models.github.ai/inference'`; same envelope + UTF-8 buffering + 60s watchdog + empty-stream synthesis + abort handling; default model `gpt-4o-mini`, env `GITHUB_MODELS_MODEL`; same system-message handling as OpenAI; error map via `mapGithubError` (401 → INVALID_KEY with hint `models:read`; message_zh explicitly mentions GitHub PAT). ~120 lines. Source: REQ-ADAPTER-001/002/004/005/007/008/009, REQ-ERROR-001.

## Phase 3: Registry, dispatch, health

- [x] T10 Create `server/providers/index.js`: registry mapping `'anthropic'|'openai'|'gemini'|'github'` → loader + SDK package name; export `loadAdapter(name)` (lazy `await import()` of the adapter module — catches load errors → returns single-event UPSTREAM_ERROR stream); export `probeProviders()` which dynamic-`import()`s each underlying SDK once, catches BOTH module-load errors AND post-call invocation errors, **memoises a Promise** so concurrent first-callers `await` the same probe, returns `{anthropic, openai, gemini, github}` booleans cached for process lifetime. ~100 lines. Source: REQ-HEALTH-001, REQ-ONBOARD-002.
- [x] T11 Update `server/server.js`: read `provider` from `/api/chat` body (validate against registry — reject HTTP 400 with `code:'UPSTREAM_ERROR'` + `message_zh` naming bad value), key from `X-Provider-Key` header (reject as `INVALID_KEY` if missing); dispatch via `loadAdapter(provider).streamChat(...)`; preserve `/api/parse` + CSP middleware + body-size limits untouched; upgrade `/api/health` to return `{ok, python, providers: await probeProviders()}`; route every `console.*` through `redactingLogger`; pass request `AbortSignal` to adapter; remove `import Anthropic` + `lib/anthropic-errors.js` import. ~100 lines. Source: REQ-ADAPTER-001/003, REQ-HEALTH-001, REQ-REDACT-001, REQ-ERROR-002. **Sequential after T3–T10.**

## Phase 4: Frontend onboarding & migration

- [x] T12 [P] Update `web/index.html`: replace single key-input modal with 2-step structure — radio group of 4 providers (Anthropic / OpenAI / Google Gemini / GitHub Models) each with helper link `(取得金鑰 ↗)` to its console / token page; `免費額度可用` badge on Gemini + GitHub Models radios; permanent GitHub Models disclaimer block (`GitHub Models（不是 GitHub Copilot）— 使用 GitHub Personal Access Token，需要 models:read 權限。`) under that radio; dynamic key input below with `data-provider` driven placeholder; helper text under input; always-visible trust line (`金鑰僅儲存於本機瀏覽器…`); `切換提供者` button at top-right of chat header (replaces v1 `forget-key`). ~80 lines. Source: REQ-ONBOARD-001/003, REQ-DOCS-002.
- [x] T13 [P] Update `web/styles.css`: styles for radio group (selected/disabled/hover states), free-tier badge pill, helper-text typography, disclaimer block, trust-line treatment, top-right `切換提供者` button, migration toast (3s auto-dismiss). ~60 lines. Source: REQ-ONBOARD-001/002, REQ-MIGRATE-002.
- [x] T14 Update `web/app.js`: implement state machine `{provider, key}`; on boot, `migrateV1IfNeeded()` — check `localStorage['cv-builder.provider']` (v2 JSON) → if valid (provider ∈ 4 known, key non-empty) use directly; else check `localStorage['cv-builder.anthropic-key']` (v1) → if non-empty/non-whitespace, write v2 `{provider:'anthropic', key}`, delete v1, show 3s dismissible toast `已自動沿用你之前的 Anthropic 設定，可隨時於右上角「切換提供者」更換。`; if empty/whitespace v1 just delete v1 and fall through to onboarding; if both v1 + v2 present, v2 wins, v1 deleted, no toast; wrap `localStorage.setItem` in try/catch — on `QuotaExceededError` fall back to in-memory `sessionState` and show banner `本機儲存空間不足，本次設定不會被記住。`; on radio change, live-update placeholder + helper text + provider-link without reload; fetch `/api/health` on modal open with 3s timeout — disable radios where `providers[id]===false` with `(SDK 未安裝)` note; **fail-open** if health errors/times out (all radios stay enabled, log `console.warn`); on submit write v2 JSON, close modal, enable chat; "切換提供者" handler: abort in-flight fetch via `controller.abort()` and `await` reader unwind BEFORE wiping localStorage, then re-open modal in place; `sendChat()` snapshots `{provider, key}` into closure once at start (no localStorage re-read during stream — multi-tab safety); outgoing `/api/chat` requests send `provider` in JSON body and key in `X-Provider-Key` header; SSE consumer unchanged (still reads `text_delta` + final `[DONE]`); on `code:'INVALID_KEY'` re-open onboarding; render `ERROR_MESSAGES_ZH` constant (the 6 zh-TW strings spec'd in REQ-ERROR-002). ~180 lines. Source: REQ-MIGRATE-001/002/003, REQ-ONBOARD-001/002/003, REQ-ADAPTER-003/010, REQ-ERROR-002. **Sequential after T12, T13.**

## Phase 5: Verification scripts & adapter tests

- [x] T15 [P] Create `scripts/smoke.mjs` (replacing `scripts/smoke.sh`): boot server in subprocess capturing stdout/stderr to a buffer; hit `/api/health` and assert all 4 keys are booleans; for each of 4 providers POST `/api/chat` with deliberately-invalid key (`sk-ant-XXX`, `sk-XXX`, `AIzaXXX`, `ghp_XXX`), assert streamed `error` event has `code === 'INVALID_KEY'`; preserve existing v1 parse/render checks; final step grep captured log for the 4 key patterns and fail if any survives redaction; add `--integration` flag (read real keys from env `ANTHROPIC_API_KEY_INTEGRATION` / `OPENAI_API_KEY_INTEGRATION` / `GEMINI_API_KEY_INTEGRATION` / `GITHUB_PAT_INTEGRATION`) running real-key happy path against ≥2 providers; default run never bills upstream. Update `package.json` `scripts.smoke` → `node scripts/smoke.mjs`. ~150 lines. Source: REQ-SMOKE-001/002, REQ-REDACT-002.
- [x] T16 [P] Create `server/providers/*.test.mjs` (one per adapter, runnable via `node --test`): each asserts (a) streaming envelope shape `{type:'text_delta', delta:string}` via mocked SDK with canned native chunks; (b) UTF-8 boundary — split `中` across 2 chunks → adapter emits a `text_delta` whose concatenation equals `中` (no `�`); (c) AbortSignal aborts within 200ms at three points (pre-byte, mid-stream, pre-DONE) all yielding `TIMEOUT`; (d) idle watchdog — feed one chunk then halt → exactly one `TIMEOUT` within 60–62s; (e) empty-stream synthesis — mock 0-chunk close → exactly one synthesized `UPSTREAM_ERROR` with the canonical zh message; (f) error mapping table (24 fixtures: 4 providers × 6 codes including 402→RATE_LIMITED). Gemini test additionally covers role-rewrite, empty-messages padding, systemInstruction overflow fallback. ~250 lines (across 4 files). Source: REQ-ADAPTER-005/006/007/008/009, REQ-ERROR-001.

## Phase 6: Docs

- [x] T17 [P] Rewrite `README.md`: "## Supported Providers" section with 4 subsections (Anthropic / OpenAI / Google Gemini / GitHub Models in that order), each containing — key source (live link), key format example, default model, env override var, free-tier note; explicit `GitHub Models ≠ GitHub Copilot` paragraph linking to `models.github.ai/inference` and noting `models:read` PAT scope; default-model upgrade path note; BYOK + redaction guarantees section; v1→v2 migration FAQ; quickstart updated for 4-provider onboarding. ~150 lines. Source: REQ-DOCS-001/002.
- [x] T18 [P] Review `system-prompt.md` for provider-agnostic phrasing (remove any "Claude" / "Anthropic" hard-coding); if no change needed, append a 1-line comment explaining why. ~5 lines. Source: REQ-DOCS-001.

## Phase 7: Wire-up & green-light

- [x] T19 Run `node --test server/redact.test.mjs server/providers/*.test.mjs` and `node scripts/smoke.mjs` (fake-key path × 4 + redaction-leak grep); fix any failures before proceeding. **Sequential after T1–T18.**
- [x] T20 Run `node scripts/smoke.mjs --integration` locally against ≥2 providers using real keys from env; record outcome (model used, latency, total tokens) in `IMPLEMENTATION.md`. Source: REQ-SMOKE-002. **Sequential after T19.**
- [x] T21 Write `IMPLEMENTATION.md`: summarise diff vs v1 (provider abstraction layer, error taxonomy, redaction, onboarding rewrite, migration, edge-case defenses); record key decisions (degradation strategy A — disabled radio, lazy SDK probe with Promise memoisation, Gemini systemInstruction fallback, 60s idle watchdog, UTF-8 buffering, multi-tab credential closure, no client-side prefix sniffing); list verification run results from T19/T20; tick all tasks above. ~100 lines. **Sequential after T20.**

---

## Summary

| Item | Count |
|---|---|
| Total tasks | 21 |
| Parallelizable | 13 |
| Sequential | 8 |
| Estimated lines | ~1700 lines |

Parallel cohorts:
- Phase 1: T3, T4, T5
- Phase 2: T6, T7, T8, T9
- Phase 4: T12, T13
- Phase 5: T15, T16
- Phase 6: T17, T18

## Notes

- **Precondition**: v1 (`projects/cv-builder-web-app`) MUST be in `verification-passed` state before T1 begins. Implement phase aborts and re-queues itself if v1 status is anything else.
- **Phase ordering is strict**: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7. Within a phase, tasks marked [P] may run concurrently; non-[P] tasks block subsequent tasks in the same phase.
- **Commit cadence**: commit at the end of each phase (≈ 7–8 commits) plus one final commit after T21. Each commit message references its phase ("Phase 2: provider adapters").
- **Missing SDK detection**: never `require()`/`import` SDKs at module top-level in `server/server.js` — only adapters import their SDK, and only when `loadAdapter(name)` is called. `probeProviders()` uses `await import(pkg)` inside try/catch; cached as a Promise per process. Frontend driven solely by `/api/health` response.
- **No frontend SDK imports**: SDKs live server-side only; frontend talks to `/api/chat` and `/api/health` exclusively.
- **Redaction discipline**: every `console.*` call in `server/server.js` and adapters MUST go through `redactingLogger`. CI/reviewer greps for raw `console.log` / `console.error` outside `redact.js` test fixtures and fails on hits.
- **AbortSignal contract**: each adapter must yield `{type:'error', code:'TIMEOUT'}` and close upstream within 200ms of `abortSignal.aborted`. Verified by T16.
- **Idle watchdog (60s)**: independent of frontend abort; covers laptop-sleep / VPN-reconnect; cleared on natural close.
- **UTF-8 boundary safety**: all adapters use `TextDecoder({stream:true})`; never emit empty `text_delta` for buffer-only transitions.
- **Empty-stream synthesis**: 200 with 0 chunks → `UPSTREAM_ERROR` with canonical message; never silent close.
- **localStorage migration is silent + 3s toast**: never prompt the user. Empty-string v1 key counts as absent. Both-present case: v2 wins, v1 deleted.
- **localStorage quota fallback**: try/catch + in-memory `sessionState` + dismissible banner; chat still works.
- **No client-side key-prefix validation**: pasting wrong key for picked provider returns `INVALID_KEY` from upstream; future key formats won't silently break.
- **Multi-tab safety**: `sendChat()` snapshots credentials into a closure once; never re-reads localStorage during the stream; no `storage` event listener for cross-tab credential sync.
- **402 → RATE_LIMITED**: `mapHttpStatus` and per-provider mappers MUST treat HTTP 402 as `RATE_LIMITED` (UX choice — quota exhaustion is the user-meaningful framing).
- **GitHub Models 401 message**: `message_zh` MUST explicitly mention "GitHub PAT" + `models:read` scope so users who pasted a wrong-slot key understand which slot they were in.
- **Default model env override**: if env var is set but names a non-existent model, adapter MUST surface `MODEL_NOT_FOUND` (not silently fall back to default).
- **Smoke billing safety**: default `node scripts/smoke.mjs` MUST NOT incur upstream cost beyond auth-probe round-trips; `--integration` is the only path that uses real keys for completion.
- **CI never sets `--integration`**: lint step asserts the substring `--integration` is absent from CI workflow files.
- **Out of scope reminders** (do not creep): no 5th provider, no fallback chaining, no token counter, no tool calling, no local LLM, no client-side prefix sniff, no multi-provider concurrent use, no cross-tab storage sync.
