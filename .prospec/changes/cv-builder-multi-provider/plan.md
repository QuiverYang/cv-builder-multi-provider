# Implementation Plan: cv-builder-multi-provider

## Overview

CV Builder v2 expands v1's Anthropic-only BYOK chat into a multi-provider BYOK chat that supports **4 LLM providers** (Anthropic, OpenAI, Google Gemini, GitHub Models) without changing the resume-parsing / rendering / privacy / SSE-consumption pipeline that v1 already verified. The product driver is reach: Gemini and GitHub Models both have free tiers, which converts the user base from "people who pay Anthropic" to "anyone with any one of four common LLM credentials." We treat v1 as the trusted baseline and treat all v2 work as additive on top of it.

The chosen strategy is a **server-side provider-abstraction adapter pattern**: each provider lives behind a uniform `streamChat({ apiKey, systemPrompt, messages, model, maxTokens, abortSignal })` interface that returns a `ReadableStream` of typed events `{type:'text_delta', delta} | {type:'error', code, message_zh}`. A thin **registry** (`server/providers/index.js`) handles dynamic-`import()` SDK probing (cached process-wide) so that a missing optional dep degrades to "provider disabled in onboarding" (degradation scheme A from idea Notes #10) instead of crashing boot. The frontend SSE consumer is **completely unchanged in shape** — it still reads `data: {chunk}` lines and a `[DONE]` sentinel — because the adapter layer guarantees a single envelope across all providers (satisfies AC C8–C11).

Key design decisions:

1. Adapters do all SDK-specific work — translating Anthropic `content_block_delta`, OpenAI `chunk.choices[0].delta.content`, Gemini `chunk.text()`, and GitHub Models (= OpenAI SDK with custom `baseURL`) into the unified `text_delta` shape.
2. Every adapter funnels failures through a single **6-code error taxonomy** (`INVALID_KEY` / `RATE_LIMITED` / `OVERLOADED` / `TIMEOUT` / `MODEL_NOT_FOUND` / `UPSTREAM_ERROR`) with per-provider mapper helpers. HTTP 402 (Payment Required) maps to `RATE_LIMITED` (UX choice — user understands "額度用完" better than "未知錯誤").
3. **Front-end never imports any LLM SDK** (idea Notes #8 hard rule). Onboarding only asks "which provider + key"; `POST /api/chat` carries `provider` in body and the key in `X-Provider-Key` header.
4. **localStorage migration is silent** with a brief 3s confirmatory toast: if `cv-builder.anthropic-key` from v1 is present and `cv-builder.provider` from v2 is absent, boot rewrites it as `{provider:"anthropic", key}` and deletes the v1 key without prompting; a 3s dismissible toast `已自動沿用你之前的 Anthropic 設定…` discloses the new "切換提供者" affordance.
5. Default models locked per provider (`claude-sonnet-4-6` / `gpt-4o-mini` / `gemini-2.0-flash` / `gpt-4o-mini`) with env-var overrides; if an override names a non-existent model, adapter emits `MODEL_NOT_FOUND`.
6. **Streaming envelope is the one true contract** — adapters buffer multi-byte UTF-8 across upstream chunks via `TextDecoder({stream:true})`, watchdog idle streams (60s no-byte → `TIMEOUT`), and synthesize `UPSTREAM_ERROR` if a 200 response yields zero bytes (policy block / content filter).

**Hard prerequisite**: v1 (`projects/cv-builder-web-app`) must be in `verification-passed` state before implement starts. v2 begins by **copying v1 source into its own project directory** and evolving from there — v1 stays frozen as the rollback target. Implement phase MUST verify v1 status as its first action; if v1 is not verified, implement aborts and re-queues itself.

## Affected Modules

| Module | Impact | Changes |
|---|---|---|
| `server/server.js` | Med | Replace direct `Anthropic` import with provider dispatch; read `provider` from POST body and key from `X-Provider-Key` header; upgrade `/api/health` to call `probeProviders()` and return `{ok, python, providers:{anthropic,openai,gemini,github}}`; remove direct `mapError` import (now per-adapter). Keep `/api/parse`, CSP middleware, body-size limits untouched. Pass request `AbortSignal` to adapter. |
| `server/providers/index.js` | High (NEW) | Registry of `{ id, label, sdkAvailable, streamChat }`. Lazy `probeProviders()` uses `await import()` per SDK once, **memoised as a Promise** (concurrent callers `await` the same probe), caches the result for the process lifetime; safe to call from `/api/health`. Exports `loadAdapter(name)` that lazy-imports the adapter module, returning a single-event `MODEL_NOT_FOUND`/`UPSTREAM_ERROR` envelope if the id is unknown. Catches both pre-call SDK import errors and post-call SDK invocation errors → `false` in availability map. |
| `server/providers/anthropic.js` | High (NEW) | Wraps `@anthropic-ai/sdk`. Maps `content_block_delta` → `text_delta`. Default model `claude-sonnet-4-6`, env override `ANTHROPIC_MODEL`. Uses adapter-local error mapper that absorbs the v1 `lib/anthropic-errors.js` logic and emits the new 6-code taxonomy. UTF-8 boundary buffering + 60s idle-stream watchdog. |
| `server/providers/openai.js` | High (NEW) | Wraps `openai`. Stream via `client.chat.completions.create({stream:true})`, reads `chunk.choices[0]?.delta?.content`, emits `text_delta`. System prompt as `messages[0]={role:"system", content}`. Default `gpt-4o-mini`, env `OPENAI_MODEL`. UTF-8 buffering + 60s watchdog + empty-stream synthesis. |
| `server/providers/gemini.js` | High (NEW) | Wraps `@google/genai`. Translates `assistant`→`model` in history; pads empty `messages` with a 1-char user turn (Gemini SDK rejects `messages:[]`); places `systemPrompt` in `systemInstruction`. If `systemInstruction` exceeds size limit, falls back to prepending it as a synthetic `user` turn and logs a redacted `WARN`. Reads chunk text via `chunk.text` accessor. Default `gemini-2.0-flash`, env `GEMINI_MODEL`. UTF-8 buffering + 60s watchdog. |
| `server/providers/github.js` | High (NEW) | Reuses `openai` SDK with `baseURL: 'https://models.github.ai/inference'`. Same envelope translation as `openai.js`. Default `gpt-4o-mini`, env `GITHUB_MODELS_MODEL`. PAT-scope-insufficient errors map to `INVALID_KEY` with `message_zh` mentioning `models:read` scope; 401 messages explicitly identify GitHub PAT (not generic OpenAI) so users who paste the wrong key know which slot they were in. |
| `server/error-taxonomy.js` | Med (NEW) | Exports the 6 codes + 4 per-provider mapper helpers (`mapAnthropicError`, `mapOpenAIError`, `mapGeminiError`, `mapGithubError`). Each helper inspects status codes / SDK-specific error classes / `AbortError` and returns `{code, message_zh, retry_after_s?}`. **402 → RATE_LIMITED** (額度用完 UX). Provider-prefixed `message_zh` so users know which upstream failed. |
| `server/redact.js` | Med (NEW) | Exports `redact(s)` and `redactObject(o)` and `redactingLogger(base)` covering 4 patterns: `sk-ant-[A-Za-z0-9_\-]+`, `sk-[A-Za-z0-9_\-]+`, `AIza[A-Za-z0-9_\-]{35}`, `(ghp_[A-Za-z0-9]{36,}\|github_pat_[A-Za-z0-9_]{20,})`. All adapters and `server/server.js` route logging through this module. Includes test fixtures (one per pattern + one mixed + one no-match). |
| `lib/anthropic-errors.js` | Removed | Logic absorbed into `server/providers/anthropic.js` + `server/error-taxonomy.js`. |
| `web/app.js` | Med | Add provider state (`{provider, key}`); replace `getApiKey()` with `getCredentials()` returning `{provider, key}`. Implement `migrateV1IfNeeded()` on boot. Two-step onboarding modal: provider radios with live-update placeholder/helper-text on change, free-tier badge on Gemini/GitHub, disabled radios for SDK-missing providers (driven by `/api/health`), GitHub-Models-≠-Copilot disclaimer always visible (not only on selection). The "Change provider" button (replaces v1 "忘記 Key", labelled `切換提供者`) wipes storage and re-opens modal. Send `provider` in body + key in `X-Provider-Key` header on `/api/chat`. SSE consumer logic unchanged. **Race-safety**: when "切換提供者" is clicked mid-stream, abort the in-flight fetch and `await` reader unwind before clearing localStorage. **Persistence-safety**: `localStorage.setItem` wrapped in try/catch; on `QuotaExceededError` fall back to in-memory state and show a banner. Each request closes over its own `{provider, key}` so multi-tab last-write-wins doesn't corrupt in-flight requests. |
| `web/index.html` | Low | Replace single `byok-modal` content with two-step structure: step-1 radio group (4 options + free-tier badges + GitHub Models permanent disclaimer), step-2 key input + provider-specific helper text + per-provider 取得金鑰 ↗ link + always-visible BYOK trust message ("金鑰僅儲存於本機瀏覽器…"). `forget-key` button renamed to `change-provider` and moved to top-right of chat header. |
| `web/styles.css` | Low | Styles for radio group (selected/disabled), helper text, free-tier badge, disclaimer block, top-right `切換提供者` button. |
| `scripts/smoke.mjs` | Med (NEW, replaces `smoke.sh`) | Node-based; boots server, hits `/api/health` and asserts the 4 provider booleans report (regardless of value), then for each provider POSTs `/api/chat` with a fake key (`sk-ant-XXX`, `sk-XXX`, `AIzaXXX`, `ghp_XXX`) and asserts the SSE error event is `INVALID_KEY`. `--integration` flag enables real-key smoke against ≥2 providers if env vars `*_API_KEY_INTEGRATION` are set. CI must invoke without `--integration`. Final step greps the captured server log for the 4 key patterns and fails if any survive redaction. Keeps existing v1 parse/render checks. |
| `scripts/smoke.sh` | Removed | Replaced by `smoke.mjs`. `npm run smoke` script repointed. |
| `package.json` | Low | Bump `name` → `cv-builder-multi-provider`, `version` → `2.0.0`. Add deps `openai` (pin minor), `@google/genai` (pin minor). `scripts.smoke` → `node scripts/smoke.mjs`. |
| `README.md` | Low | New "Supported Providers" section with one row per provider: where to get the key (live link), key format, default model, env override var, free-tier summary. Explicit "GitHub Models ≠ GitHub Copilot" callout. v1 → v2 migration FAQ. |
| `system-prompt.md` | No change | Single string; adapters route it to the provider-idiomatic location. (Comment added if any wording shifts to provider-agnostic.) |

## Implementation Steps

1. **Bootstrap v2 from verified v1** (proposal "Related Modules" prerequisite)
   - Hard-check `ideas/cv-builder-web-app.md` frontmatter `status==verification-passed`; abort & re-queue if not.
   - `cp -R projects/cv-builder-web-app/. projects/cv-builder-multi-provider/` excluding `.git/`, `node_modules/`, `tmp-renders/`, `verification-*.md`, `IMPLEMENTATION.md`, `smoke.log`, v1 `.prospec/`, `.prospec.yaml`, `prospec/` (v2 prospec docs already exist).
   - `git init` is already done at design start; do not re-init.
   - Update `package.json`: `name=cv-builder-multi-provider`, `version=2.0.0`.

2. **Add provider SDK dependencies** (REQ-HEALTH-001 prerequisite)
   - `npm install openai@^4 @google/genai@^0.x` (pin to validated minor).
   - Verify `@anthropic-ai/sdk` still works with v1 logic; bump only if needed.
   - Commit lockfile.

3. **Build `server/error-taxonomy.js`** (REQ-ERROR-001, REQ-ERROR-002)
   - Define `ERROR_CODES = {INVALID_KEY, RATE_LIMITED, OVERLOADED, TIMEOUT, MODEL_NOT_FOUND, UPSTREAM_ERROR}` (closed set).
   - 4 mapper helpers: each takes `(provider, error) → {code, message_zh, retry_after_s?}`. Anthropic helper preserves v1's 401/429/503/529 logic; OpenAI/GitHub use `OpenAI.APIError` instanceof checks; Gemini inspects `error.status` / `error.message` for `RESOURCE_EXHAUSTED` / `INVALID_ARGUMENT`. **HTTP 402 → RATE_LIMITED** with `message_zh` mentioning quota/free-tier exhaustion.
   - All `message_zh` values are pre-localized; never include raw upstream JSON.

4. **Build `server/redact.js` + unit fixtures** (REQ-REDACT-001, REQ-REDACT-002)
   - Single combined regex covering all 4 patterns; replacement `***REDACTED***`.
   - Export `redact(string)`, `redactObject(obj)`, `redactingLogger(base)`.
   - Unit tests with one fixture per pattern + one mixed-string + negative fixtures (e.g., `sk-ant-` alone, `AIza` too short — must NOT redact).
   - Replace direct `console.*` calls in server + adapters with redaction-wrapped variants.

5. **Implement `server/providers/anthropic.js`** (REQ-ADAPTER-001/002/004/005, REQ-ERROR-001)
   - Extract streaming logic from v1 `server/server.js` lines ~263–290 into `streamChat`.
   - System prompt → top-level `system` field; messages forwarded as-is.
   - Translate `content_block_delta` → `{type:'text_delta', delta}` via `TextDecoder({stream:true})` to handle multi-byte UTF-8 split across chunks.
   - 60s idle-stream watchdog: tracks `lastByteAt`; `setInterval(2s)` aborts upstream + emits `TIMEOUT` if `Date.now() - lastByteAt > 60_000`. Independent of frontend abort — covers laptop sleep / VPN reconnect.
   - On `abortSignal.aborted` emit `TIMEOUT` and ensure upstream socket closes.
   - Empty-stream guard: if upstream closes 200 with zero `text_delta` emitted and no error captured, synthesize `UPSTREAM_ERROR` with `message_zh:'上游回應為空，可能被內容政策過濾，請改寫提示再試。'`
   - Default model `claude-sonnet-4-6`, env override `ANTHROPIC_MODEL`.

6. **Implement `server/providers/openai.js`** (same suite of REQs)
   - `new OpenAI({apiKey})`; `client.chat.completions.create({model, stream:true, messages:[{role:'system',content:systemPrompt}, ...messages], max_tokens}, {signal:abortSignal})`.
   - `for await (const chunk of response)` → emit `text_delta` for non-empty `chunk.choices[0]?.delta?.content`.
   - Same UTF-8 buffering, 60s watchdog, empty-stream synthesis, abort handling, error mapping.
   - Default `gpt-4o-mini`, env `OPENAI_MODEL`.

7. **Implement `server/providers/gemini.js`** (REQ-ADAPTER-006 + base suite)
   - `new GoogleGenAI({apiKey})`; rewrite each message `role: 'assistant' → 'model'`.
   - **Empty-messages padding**: if `messages.length === 0`, send `[{role:'user', parts:[{text:' '}]}]` (Gemini SDK rejects empty arrays).
   - System prompt → `systemInstruction`; if `systemPrompt.length > GEMINI_SYS_LIMIT` (configurable, default 30k chars), fall back to prepending it as `{role:'user', parts:[{text:systemPrompt}]}` and log `WARN [gemini] systemInstruction overflow fallback applied` (redacted).
   - Stream via `model.generateContentStream(...)`; read each chunk via `chunk.text` getter; same UTF-8 / watchdog / empty-stream / abort logic.
   - Default `gemini-2.0-flash`, env `GEMINI_MODEL`.

8. **Implement `server/providers/github.js`** (REQ-ADAPTER suite + REQ-DOCS-002)
   - `new OpenAI({apiKey, baseURL:'https://models.github.ai/inference'})`.
   - Same envelope translation as openai.js — distinct file for clarity + independent default-model env var.
   - PAT-scope-insufficient (403 with `models:read` hint) maps to `INVALID_KEY` with `message_zh` ending `（請確認 PAT 有 models:read 權限）`.
   - 401 message_zh explicitly mentions "GitHub PAT" so users who pasted an OpenAI key here understand the slot.
   - Default `gpt-4o-mini`, env `GITHUB_MODELS_MODEL`.

9. **Build `server/providers/index.js` registry + lazy SDK probe** (REQ-HEALTH-001, REQ-ONBOARD-002)
   - Export `PROVIDERS = {anthropic, openai, gemini, github}` map.
   - `probeProviders()` runs once: each entry is `await import('@…/sdk').then(()=>true).catch(()=>false)`. The function caches the **Promise** (not just the resolved value) so concurrent first-callers `await` the same probe. Catches BOTH module-load errors AND post-call invocation errors. Never throws.
   - `loadAdapter(name)` returns the adapter module via `await import(...)`; if the registry key is unknown returns a single-event ReadableStream emitting `UPSTREAM_ERROR`.

10. **Wire `POST /api/chat` to provider dispatch + upgrade `/api/health`** (REQ-ADAPTER-001/003, REQ-HEALTH-001, REQ-REDACT-001)
    - Read `provider` from POST body (validate against registry; reject HTTP 400 if missing/unknown).
    - Read API key from `X-Provider-Key` header (replace v1 `x-api-key`); reject as `INVALID_KEY` if absent.
    - Call `loadAdapter(provider).streamChat({apiKey, systemPrompt:SYSTEM_PROMPT, messages, model, maxTokens, abortSignal})`.
    - Pipe returned stream into existing SSE response: `text_delta` → `data: {chunk: delta}`, `error` → `event: error\ndata: {code, message_zh}`, then `data: [DONE]`.
    - Upgrade `/api/health` to `{ok, python, providers: await probeProviders()}`.
    - All log lines via `redactingLogger`.

11. **Frontend onboarding rebuild + v1 migration + provider switcher** (REQ-ONBOARD-001/002/003, REQ-MIGRATE-001/002/003, REQ-ADAPTER-003, REQ-ERROR-002)
    - Boot: `migrateV1IfNeeded()` — if `cv-builder.provider` parses as valid v2, use it; else if `cv-builder.anthropic-key` exists AND non-empty/non-whitespace, write v2 entry `{provider:"anthropic", key}`, `removeItem` v1, show 3s dismissible toast `已自動沿用你之前的 Anthropic 設定，可隨時於右上角「切換提供者」更換。`; else show onboarding. Both-present case → v2 wins, v1 deleted.
    - Onboarding: 2-step modal. Step 1 = 4 radios with **free-tier badges** (`免費額度可用` pill on Gemini/GitHub) and **permanent GitHub Models disclaimer** under that radio (`GitHub Models（不是 GitHub Copilot）— 使用 GitHub Personal Access Token，需要 models:read 權限`). `fetch('/api/health')` on modal open; disable any radio where `providers[id]===false` with note `(SDK 未安裝)`. **Fail-open**: if `/api/health` errors or times out >3s, all radios stay enabled (graceful) and a non-blocking client-side warning logs.
    - Step 2 = key input with provider-specific placeholder + helper text + 取得金鑰 ↗ link, plus always-visible trust line `金鑰僅儲存於本機瀏覽器 (localStorage)，不會送到我們伺服器之外的地方。`. Submit-disabled until non-empty.
    - **No client-side key-prefix sniffing** (explicit non-goal — see below). Wrong key for picked provider surfaces as `INVALID_KEY` from upstream.
    - "切換提供者" button top-right of chat header; clicking it: (a) aborts any in-flight fetch and `await`s reader unwind, (b) wipes both localStorage keys, (c) re-opens onboarding without `location.reload()`.
    - `localStorage.setItem` wrapped in try/catch — on `QuotaExceededError` fall back to in-memory `sessionState` and render banner `本機儲存空間不足，本次設定不會被記住。`.
    - `streamChat` request closes over its own `{provider, key}` snapshot at submit time; never re-reads localStorage during the stream (multi-tab safety).
    - SSE consumer **unchanged** — still reads `data: {chunk}` and `[DONE]`. Error event triggers re-onboarding when `code==='INVALID_KEY'`.

12. **README + smoke.mjs + verify hooks** (REQ-DOCS-001/002, REQ-SMOKE-001/002)
    - README "Supported Providers" — one row/sub-section per provider with key acquisition link, format, default model, env-var override, free-tier note. Explicit GitHub Models vs Copilot disambiguation paragraph. v1 → v2 migration FAQ.
    - `scripts/smoke.mjs`: replaces `smoke.sh`. Boots server, asserts `/api/health` shape, fake-key `INVALID_KEY` per provider, then keeps v1 parse/render checks. `--integration` flag for real-key probes (CI never sets). Final step greps captured log for redaction leaks.
    - `IMPLEMENTATION.md` (written in T21) lists per-provider verification results.

## Non-Goals (explicit out-of-scope reminders)

- **No client-side key-prefix validation.** Future key formats (e.g. OpenAI rotating to `sess-…`, GitHub PATs gaining new prefix) would silently break, and `INVALID_KEY` from upstream is a fine signal anyway. Adapters do exact pattern checks only inside `server/redact.js` (for log scrubbing) — never to gate requests.
- No 5th provider (Cohere / Mistral / xAI / DeepSeek / local LLM) — punted to v3.
- No automatic fallback chaining (provider A fails → switch to B). UX too complex.
- No token counter / cost estimator UI.
- No tool / function calling (v2 is pure chat, like v1).
- No multi-provider concurrent use (one provider per session).
- No cross-tab storage event sync — last-write-wins is acceptable.

## Risk Assessment

| Risk | Impact | Mitigation |
|---|---|---|
| Streaming chunk shape divergence across SDKs produces inconsistent UX | High | Unified `{type:'text_delta', delta:string}` envelope is the **single contract**; each adapter has unit tests with recorded fixtures of its native chunk shape that assert correct translation. Frontend SSE consumer is unchanged from v1 — guarantees backward compat. |
| `AbortSignal` semantics differ across SDKs; orphaned upstream connections drain user quota | Med | Each adapter wraps SDK call with manual try/finally; on abort, explicitly close any underlying response stream + emit `TIMEOUT`. Adapter unit tests simulate abort at three points (before first byte, mid-stream, just before DONE). 60s idle watchdog catches sleep/VPN scenarios where AbortSignal never fires. |
| Multi-byte UTF-8 codepoint split across upstream chunks (Chinese in Gemini binary stream) renders as 亂碼 | Med | All adapters use `TextDecoder({stream:true})` to buffer until valid UTF-8 boundary. Unit-tested with synthetic split fixtures. |
| Upstream returns 200 with empty stream (content filter / policy block) → silent close | Med | Adapter tracks `bytesEmitted`; if 0 on close with no error, synthesize `UPSTREAM_ERROR` with explanatory `message_zh`. |
| Race: user clicks 切換提供者 mid-stream, in-flight chunks land in stale chat | Med | Frontend MUST `controller.abort()` and `await` reader unwind before clearing localStorage. Documented + tested. |
| `localStorage.setItem` throws `QuotaExceededError` (Safari Private, full storage) | Low | Wrap writes in try/catch; in-memory fallback + non-blocking banner. Chat still works for the session. |
| Concurrent first-callers of `/api/health` race the SDK probe | Low | `probeProviders()` memoises a **Promise**, not a value; concurrent callers await the same probe. |
| SDK throws at import time (peer-dep mismatch, ESM/CJS shape break) | Med | `await import()` wrapped in try/catch in BOTH probe and lazy adapter load; provider is reported `false`/disabled rather than crashing boot. |
| Gemini SDK rejects `messages:[]` on first turn before user types | Low | Adapter pads with `{role:'user', parts:[{text:' '}]}` when messages empty. Tested. |
| Gemini `systemInstruction` size limit unknown / version-dependent | Low | Adapter falls back to `user`-turn prepend on first oversize rejection; logs WARN; behaviour tested with synthetically large prompt. |
| SDK version drift breaks chunk fields after `npm install` post-soak | Med | Pin minor versions in `package.json`; lockfile committed. CI smoke (fake-key path) catches dispatch-path breakage. |
| v1 not in `verification-passed` state at implement start | High | Implement phase's first action: hard-check v1 idea frontmatter. If not verified, abort + re-queue v2 design with 1h delay. |
| Adapter API too v2-shaped, hard to evolve to tool-calling/vision in v3 | Low/Med | Keep `streamChat` minimal (apiKey, systemPrompt, messages, model, maxTokens, abortSignal); return ReadableStream of typed events that can be **additively extended** (`{type:'tool_use', ...}`, `{type:'image_block', ...}`) without breaking existing consumers. Documented in `server/providers/index.js` header. |
| Key leak in logs from new code paths (4 SDKs × multiple error shapes) | High | All logging via single `redactingLogger`. Per-pattern unit tests + smoke-final grep step that fails if any of the 4 patterns survives. |
| localStorage v1 key with empty/whitespace value triggers infinite INVALID_KEY loop | Low | Migration treats empty/whitespace as "no v1 key" → falls through to onboarding; if v2 entry exists, v2 wins regardless. Tested with manual seeding. |
| GitHub Models PAT acquisition UX heavier than other providers | Low | README PAT walkthrough; onboarding helper-text mentions `models:read` scope; INVALID_KEY message hints scope check. |
| HTTP 402 (Payment Required) mapped to `UPSTREAM_ERROR` would confuse users hitting free-tier exhaustion | Low | Map 402 → `RATE_LIMITED` (額度用完 — closer UX semantically). Documented in error-taxonomy mapper. |
| `X-Provider-Key` header exceeds Node default 8KB limit (very long PAT + cookies) | Low | Use Hono default header parser; if header limit ever bites in practice, fall back to body field `apiKey` (non-functional change, deferred unless reported). |
