# Delta Spec: cv-builder-multi-provider

> REQ ID 格式：`REQ-{MODULE}-{NUMBER}`（例：REQ-ONBOARD-001）
> Modules: `ONBOARD` / `MIGRATE` / `ADAPTER` / `HEALTH` / `ERROR` / `REDACT` / `DOCS` / `SMOKE`

## ADDED

### REQ-ONBOARD-001: Two-step onboarding modal with provider radio and live key input

**Description:**
On first visit, render a two-step onboarding modal: (1) a 4-option provider radio group (Anthropic / OpenAI / Google Gemini / GitHub Models) and (2) a key input whose placeholder, helper text, and "where to get a key" link update live as the user changes the radio selection — with no page reload. On submit, persist v2 schema to localStorage and enable chat. Free-tier badges appear next to providers with usable free tiers. The modal explicitly disambiguates GitHub Models from GitHub Copilot (always-visible helper text under that radio).

**Acceptance Criteria:**
1. Modal renders four radio options labelled `Anthropic`, `OpenAI`, `Google Gemini`, `GitHub Models`.
2. Switching the radio updates the input `placeholder` to the provider-specific prefix sample (`sk-ant-...`, `sk-...`, `AIza...`, `ghp_... or github_pat_...`) within the same render tick.
3. Helper text below the input names the provider's official console / token page and renders an `<a target="_blank" rel="noopener">` link to it.
4. The submit button is disabled while the key input is empty or whitespace-only.
5. On successful submit, `localStorage['cv-builder.provider']` equals JSON `{"provider":"<picked>","key":"<entered>"}`, the modal closes, and chat input becomes enabled in the same task tick.
6. A `免費額度可用` badge appears next to Google Gemini and GitHub Models radios; not on Anthropic / OpenAI.
7. An always-visible disclaimer under the GitHub Models radio reads `GitHub Models（不是 GitHub Copilot）— 使用 GitHub Personal Access Token，需要 models:read 權限。` (visible regardless of which radio is currently selected).
8. An always-visible trust line under the key input reads `金鑰僅儲存於本機瀏覽器 (localStorage)，不會送到我們伺服器之外的地方。`.
9. **No client-side key-prefix validation** — pasting a `sk-ant-...` key after picking OpenAI is allowed; upstream returns `INVALID_KEY`. (Rationale: future key formats would silently break client validation.)
10. Test asserts placeholder text changes for all four radio selections.

**Priority:** High

**Source AC:** A1, A2, A3, A4

---

### REQ-ONBOARD-002: Disable provider radio when its SDK is not importable; fail-open on health timeout

**Description:**
The onboarding modal queries `GET /api/health` on mount; for any provider whose `providers.<name>` is `false`, the matching radio renders `disabled` with an inline `(SDK 未安裝)` note. If `/api/health` errors or exceeds 3s, all 4 radios remain enabled (fail-open) and a non-blocking client-side warning logs. (Degradation strategy A from idea Notes §10.)

**Acceptance Criteria:**
1. On modal mount, the frontend issues exactly one `GET /api/health` request.
2. For each provider where the response says `false`, the matching `<input type="radio">` has `disabled` set and shows `(SDK 未安裝)` next to it.
3. If `/api/health` fails or times out (>3s), all 4 radios remain enabled and a `console.warn` records the timeout (no user-facing error).
4. A user cannot submit the modal with a disabled provider selected (button stays disabled).
5. `undefined` in the response per-provider field is treated identically to `false` (defensive).

**Priority:** High

**Source AC:** D14, D15, edge case "/api/health probe fails during cold start"

---

### REQ-ONBOARD-003: "切換提供者" affordance with mid-stream race safety

**Description:**
Provide a `切換提供者` button at the top-right of the chat header (replacing v1 "忘記 Key"). Clicking it: (a) aborts any in-flight `/api/chat` fetch and `await`s the reader to fully unwind, (b) wipes both v1 and v2 localStorage entries, (c) re-opens onboarding without `location.reload()`.

**Acceptance Criteria:**
1. Button is visible in the chat header (top-right) at all times when chat is enabled.
2. Clicking the button while a stream is in-flight calls `controller.abort()` and `await`s the reader generator to settle before clearing localStorage.
3. Clicking the button when no stream is in-flight skips the abort step and proceeds directly to wipe + re-open.
4. After completing the new modal flow, chat resumes with the new provider+key — no reload required (verified by checking same JS context).
5. While the modal is open after clicking the button, chat input remains disabled.
6. Test simulates the race: in-flight stream emitting tokens, button click, asserts no stale `text_delta` lands in the new chat.

**Priority:** Medium

**Source AC:** B7, edge case "User clicks Change provider mid-stream"

---

### REQ-MIGRATE-001: Returning user fast-path skips onboarding

**Description:**
On boot, if `localStorage['cv-builder.provider']` exists and parses as a valid v2 record (`provider` ∈ the 4 known values, `key` is non-empty string), the app proceeds straight to chat without rendering the onboarding modal.

**Acceptance Criteria:**
1. Parse `localStorage['cv-builder.provider']` exactly once at app boot.
2. If parse succeeds and the record validates, the modal does not mount.
3. The first outbound `POST /api/chat` uses the stored provider and key.
4. If JSON parse fails or `provider` is not one of the four known values, treat as no v2 entry and fall through to migration logic (REQ-MIGRATE-002).

**Priority:** High

**Source AC:** B5, B7

---

### REQ-MIGRATE-002: Silent v1→v2 schema migration with edge cases

**Description:**
When v2 is absent and v1 (`localStorage['cv-builder.anthropic-key']`) is present and non-empty, silently rewrite to v2 schema with `provider:"anthropic"`, delete the v1 entry, and proceed to chat with a brief 3s dismissible toast disclosing the new affordance. Empty / whitespace-only v1 values are treated as "no v1 key". Both-present case: v2 wins, v1 deleted, no toast.

**Acceptance Criteria:**
1. Given v1=`"sk-ant-abc"` and no v2 → v2 = `{"provider":"anthropic","key":"sk-ant-abc"}`, v1 removed, 3s toast: `已自動沿用你之前的 Anthropic 設定，可隨時於右上角「切換提供者」更換。`.
2. Given v1=`""` (empty) or v1=`"   "` (whitespace) and no v2 → v1 removed, v2 NOT written, onboarding modal renders.
3. Given both v1 and v2 present → v2 retained, v1 removed, no toast.
4. Migration occurs before any `POST /api/chat` request.
5. Migration emits no `alert()` / `confirm()` / blocking modal.
6. Toast is dismissible and auto-hides after 3s.
7. Unit test covers all four cases (only-v1, only-v1-empty, only-v1-whitespace, both-present).

**Priority:** High

**Source AC:** B6, edge cases "v1 key empty string", "Both v1 and v2 entries present"

---

### REQ-MIGRATE-003: localStorage quota fallback

**Description:**
When `localStorage.setItem` throws `QuotaExceededError` (Safari Private Mode, full storage), boot falls back to in-memory `sessionState`, chat still works for the session, and a non-blocking banner displays.

**Acceptance Criteria:**
1. All `localStorage` writes are wrapped in try/catch.
2. On `QuotaExceededError`, the value is held in an in-memory variable readable by `getCredentials()`.
3. A non-blocking banner reads `本機儲存空間不足，本次設定不會被記住。` and is dismissible.
4. Chat fully functions for the session.
5. Test: stub `localStorage.setItem` to throw, assert banner renders and chat still sends requests.

**Priority:** Medium

**Source AC:** Edge case "localStorage quota exceeded"

---

### REQ-ADAPTER-001: Unified `streamChat` interface contract for all 4 providers

**Description:**
All adapters under `server/providers/<provider>.js` expose `streamChat({ apiKey, systemPrompt, messages, model, maxTokens, abortSignal })` returning `ReadableStream<Event>` where `Event = {type:'text_delta', delta:string} | {type:'error', code:string, message_zh:string}`. The dispatcher in `server/server.js` selects the adapter purely by the request body's `provider` field via the registry.

**Acceptance Criteria:**
1. Each of the 4 adapter files exports a function with that exact signature.
2. The dispatcher does not contain any provider-specific branches beyond a registry lookup.
3. Switching `provider` in the request body changes which adapter is invoked, with zero changes to the route handler logic.
4. An unknown `provider` value returns HTTP 400 with `code:'UPSTREAM_ERROR'` and `message_zh` naming the bad value.
5. Contract test runs the same fake-stream test against all 4 adapters and passes identically.

**Priority:** High

**Source AC:** C8, C9

---

### REQ-ADAPTER-002: Per-provider system-prompt routing

**Description:**
The frontend sends `systemPrompt` as a single string. Each adapter routes it to that provider's idiomatic location: Anthropic `system:` field, OpenAI/GitHub `messages[0]={role:"system",content:...}`, Gemini `systemInstruction`. The frontend never knows the difference.

**Acceptance Criteria:**
1. Anthropic adapter passes `systemPrompt` as the top-level `system` parameter.
2. OpenAI adapter prepends a `{role:"system", content: systemPrompt}` element to the upstream `messages` array.
3. GitHub Models adapter behaves identically to OpenAI (same SDK, only `baseURL` differs).
4. Gemini adapter passes `systemPrompt` via `systemInstruction` and never includes a `system` role in `contents`.
5. Empty / undefined `systemPrompt` is allowed: adapter omits the field rather than sending an empty string.
6. Unit test per adapter asserts the upstream payload shape via mocked SDK client.

**Priority:** High

**Source AC:** C11

---

### REQ-ADAPTER-003: Streaming envelope as the single front-end contract

**Description:**
Each adapter normalises its provider's native stream into the envelope `{type:'text_delta', delta:string}` followed by a final `[DONE]` marker. The frontend SSE consumer reads only this envelope and `[DONE]`; it does not branch on provider.

**Acceptance Criteria:**
1. Each adapter emits zero or more `text_delta` events plus exactly one terminal `[DONE]` line.
2. Anthropic `content_block_delta`, OpenAI `chunk.choices[0].delta.content`, Gemini `chunk.text()` are each translated into the envelope without leaking native shapes.
3. Frontend SSE handler contains no `if (provider === ...)` branches.
4. Provider can be swapped at runtime (REQ-ONBOARD-003) and the same SSE consumer continues to render text.
5. Contract test feeds canned native chunks through each adapter and asserts emitted envelope sequence is identical in shape across all 4.

**Priority:** High

**Source AC:** C10

---

### REQ-ADAPTER-004: Default model + env override per provider with `MODEL_NOT_FOUND`

**Description:**
Each adapter ships a hardcoded default model. Env vars override defaults: `ANTHROPIC_MODEL` (default `claude-sonnet-4-6`), `OPENAI_MODEL` (default `gpt-4o-mini`), `GEMINI_MODEL` (default `gemini-2.0-flash`), `GITHUB_MODELS_MODEL` (default `gpt-4o-mini`). Unset → default. Override naming a non-existent model → adapter emits `{type:'error', code:'MODEL_NOT_FOUND'}`.

**Acceptance Criteria:**
1. With env unset, each adapter sends the documented default model upstream.
2. With env set to a non-default-but-valid value, that value is sent upstream verbatim.
3. With env set to a known-invalid value (e.g. `claude-not-real`), upstream rejects → adapter event has `code:'MODEL_NOT_FOUND'` and `message_zh` mentions the offending model name.
4. Default model constants are exported from each adapter for discovery by tests.

**Priority:** Medium

**Source AC:** D12, D13

---

### REQ-ADAPTER-005: AbortSignal propagation closes upstream and emits TIMEOUT

**Description:**
When the caller aborts the request (browser navigation, manual stop, server-side deadline), `abortSignal` propagates to the underlying SDK call so the upstream socket is closed; adapter emits a final `{type:'error', code:'TIMEOUT', message_zh:'已中斷'}` before terminating the stream. No orphaned upstream sockets.

**Acceptance Criteria:**
1. Each adapter passes `abortSignal` to its SDK's documented abort entrypoint (`signal:` for Anthropic/OpenAI; `AbortController` for `@google/genai`).
2. Aborting mid-stream emits exactly one `TIMEOUT` event and then closes the stream.
3. After abort, no outbound HTTP socket to the upstream remains open within 100ms (verified via mock).
4. Test simulates abort at three points: before first byte, mid-stream, immediately before `[DONE]`; all yield `TIMEOUT`.

**Priority:** High

**Source AC:** Edge case "Streaming aborted mid-response", E16

---

### REQ-ADAPTER-006: Gemini-specific quirks (role rewrite, empty messages, systemInstruction overflow)

**Description:**
Gemini requires `model` (not `assistant`) as response role, rejects empty `messages[]`, and may reject oversize `systemInstruction`. The Gemini adapter must rewrite `assistant` → `model`, pad empty messages with a 1-char user turn, and on systemInstruction overflow fall back to prepending the system text as a `user` turn (logging a redacted WARN).

**Acceptance Criteria:**
1. Given a `messages` array containing `{role:'assistant', content:'...'}`, the upstream payload contains that turn as `{role:'model', parts:[...]}`.
2. Given `messages.length === 0`, adapter sends `[{role:'user', parts:[{text:' '}]}]` upstream.
3. Given a `systemPrompt` over the threshold (configurable, default 30k chars), adapter omits `systemInstruction` and prepends the text as `{role:'user', parts:[{text: systemPrompt}]}`; logs a single `WARN`-level line containing literal `systemInstruction overflow`; line passes redaction.
4. Unit test covers all three branches (assistant-rewrite, empty-padding, overflow-fallback).

**Priority:** High

**Source AC:** Edge cases "Gemini message history `assistant` role", "System prompt exceeds Gemini limit", "Gemini SDK rejects empty messages[]"

---

### REQ-ADAPTER-007: UTF-8 boundary buffering across upstream chunks

**Description:**
Multi-byte UTF-8 codepoints (esp. Chinese, emoji) commonly split across two upstream chunks; adapters must buffer until valid UTF-8 boundary before emitting `text_delta`.

**Acceptance Criteria:**
1. Each adapter wraps its native chunk source in `TextDecoder({stream:true})` (or equivalent buffering).
2. Test feeds a synthetic split (`"中".bytes()` split across 2 chunks) through each adapter; emitted `text_delta` strings concatenate to the correct character with no replacement char `�`.
3. Empty intermediate buffers do not produce empty `text_delta` events.

**Priority:** High

**Source AC:** Edge case "Multi-byte UTF-8 split across SSE events"

---

### REQ-ADAPTER-008: Idle-stream watchdog (60s) emits TIMEOUT

**Description:**
Adapters track `lastByteAt`; an interval (≤ every 2s) checks `Date.now() - lastByteAt`; if idle > 60s, adapter aborts upstream and emits `TIMEOUT`. Independent of frontend `abortSignal` — covers laptop sleep / VPN reconnect where TCP keepalive may not fire.

**Acceptance Criteria:**
1. Each adapter starts the watchdog when first byte arrives (or on first read attempt) and clears on stream close.
2. Watchdog interval is at most 2s.
3. Test: feed adapter a stream that emits one chunk then halts; within 60–62s adapter emits exactly one `TIMEOUT` and closes.
4. Watchdog is removed cleanly on normal close (no leaked timers; verified by `process._getActiveHandles()` count).

**Priority:** Medium

**Source AC:** Edge case "Sleep/wake / VPN reconnect mid-stream"

---

### REQ-ADAPTER-009: Empty-stream synthesis to UPSTREAM_ERROR

**Description:**
When upstream returns HTTP 200 but emits zero text events then closes (policy block / content filter), adapter must synthesize `{type:'error', code:'UPSTREAM_ERROR', message_zh:'上游回應為空，可能被內容政策過濾，請改寫提示再試。'}` rather than silent close.

**Acceptance Criteria:**
1. Each adapter tracks `bytesEmitted`; if 0 on natural stream close with no error received, emits the synthesized error event before `[DONE]`.
2. Test: mock SDK to return a stream that closes after 0 chunks; assert the synthesized event is emitted exactly once.
3. The exact `message_zh` is `上游回應為空，可能被內容政策過濾，請改寫提示再試。`.

**Priority:** Medium

**Source AC:** Edge case "Provider returns 200 but empty stream"

---

### REQ-ADAPTER-010: Per-request credential closure (multi-tab safety)

**Description:**
The frontend `sendChat()` snapshot the active `{provider, key}` at submit time and reuses that snapshot for the entire request. It must not re-read localStorage during the stream, so a multi-tab user who flips provider in tab B does not corrupt tab A's in-flight request.

**Acceptance Criteria:**
1. `sendChat()` reads localStorage once at the top of the function, holds the credentials in a closure, and uses them for header + body construction.
2. Test: in-flight stream from tab A; mutate localStorage to a different provider; assert the next chunk (already in flight) still uses tab A's original `{provider, key}` (no cross-tab sync via `storage` event).
3. No `window.addEventListener('storage', ...)` listener is registered for credential sync.

**Priority:** Medium

**Source AC:** Edge case "User opens two tabs simultaneously"

---

### REQ-HEALTH-001: `/api/health` lazy SDK probe with per-process Promise cache

**Description:**
`GET /api/health` returns `{ok, python, providers: {anthropic, openai, gemini, github}}` indicating whether each SDK is importable. Detection uses dynamic `import()` wrapped in try/catch (catches both module-load and ESM-shape errors), runs lazily on first call, **memoises a Promise** so concurrent first-callers `await` the same probe, and caches the resolved value for the process lifetime.

**Acceptance Criteria:**
1. The route never returns 5xx for SDK-related issues; missing/broken SDK ⇒ `false`, never error.
2. First call triggers `import()` for each provider once; subsequent calls reuse the cached value.
3. Concurrent first-callers receive the same Promise (verified by spying on `import` and asserting call count = 4 across N concurrent requests).
4. Removing a package from `node_modules` and restarting flips that provider to `false` on next first call.
5. Response shape contains exactly the four provider keys plus existing `ok`/`python` — no version strings leak.
6. Endpoint p95 latency < 50ms after first call (cached path).
7. SDK module that throws *at import time* (peer-dep mismatch, ESM shape break) is treated as `false`, not propagated.

**Priority:** High

**Source AC:** D14, edge case "SDK throws at import time", edge case "/api/health called before SDKs probed"

---

### REQ-ERROR-001: Six-code error taxonomy mapped uniformly across all 4 adapters

**Description:**
All adapters map upstream errors into exactly one of: `INVALID_KEY` (401-class), `RATE_LIMITED` (429 **and** 402 Payment Required), `OVERLOADED` (503/529), `TIMEOUT` (abort/deadline/idle-watchdog), `MODEL_NOT_FOUND` (404 / unknown-model upstream), `UPSTREAM_ERROR` (catch-all). The mapping lives in `server/error-taxonomy.js` and is reused by every adapter.

**Acceptance Criteria:**
1. A shared `mapError(provider, upstreamErr) → {code, message_zh}` exists; each adapter calls it.
2. Mapping table is unit-tested with at least one fixture per (provider × code) cell — i.e., 4×6 = 24 fixtures minimum.
3. HTTP 402 (Payment Required, e.g. Gemini paid-tier exhausted, OpenAI quota zero) maps to `RATE_LIMITED`, NOT `UPSTREAM_ERROR` (UX choice — user understands quota exhaustion).
4. GitHub Models PAT with insufficient scopes maps to `INVALID_KEY` and `message_zh` includes the substring `models:read`.
5. GitHub Models adapter's 401 `message_zh` mentions GitHub PAT explicitly (so user who pasted an OpenAI key in GitHub slot understands the slot they were in).
6. No upstream JSON / stack trace appears in any `message_zh`.
7. Closed-set assertion: parser test asserts no adapter ever emits a code outside the six.

**Priority:** High

**Source AC:** E16, edge case "GitHub Models PAT insufficient scopes", edge case "Provider returns 402"

---

### REQ-ERROR-002: Frontend renders localized Chinese message per code

**Description:**
The frontend maps each `code` to a fixed Chinese message string and renders it as the chat error bubble. It never displays raw upstream JSON or SDK stack traces, even when `message_zh` is missing.

**Acceptance Criteria:**
1. A frontend constant `ERROR_MESSAGES_ZH` maps all six codes to the following exact strings:
   - `INVALID_KEY → "金鑰格式不符或被拒，請確認你選的 provider 與貼的金鑰一致。"`
   - `RATE_LIMITED → "請求太頻繁或額度已用完，稍候再試或到 provider console 檢查用量。"`
   - `OVERLOADED → "上游服務暫時繁忙，請稍後再試一次。"`
   - `TIMEOUT → "回應逾時或已中斷，請重新送出。"`
   - `MODEL_NOT_FOUND → "找不到指定的 model，請確認環境變數設定或改用預設 model。"`
   - `UPSTREAM_ERROR → "上游服務發生未知錯誤，請稍後再試；若反覆出現請回報。"`
2. If the server emits an unknown code (defensive default), the UI shows the `UPSTREAM_ERROR` message and not the raw payload.
3. Snapshot/visual test covers all six codes.
4. Integration test injects a sentinel string into upstream JSON and asserts it does not appear in the rendered bubble.
5. On `code:'INVALID_KEY'`, the frontend re-opens onboarding (mirrors v1 BYOK_INVALID behavior).

**Priority:** High

**Source AC:** E17, edge case "User pastes Anthropic key after picking OpenAI"

---

### REQ-REDACT-001: Server logger redacts 4 key patterns before any line is written

**Description:**
Server-side logger applies regex-based redaction to every log line before it is written to stdout / stderr / file. The four patterns are: `sk-ant-[A-Za-z0-9_\-]+`, `sk-[A-Za-z0-9_\-]+`, `AIza[A-Za-z0-9_\-]{35}`, and `(ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})`. Replacement is `***REDACTED***`.

**Acceptance Criteria:**
1. All `console.log/info/warn/error` calls (or whatever logger is in use) flow through a single redaction wrapper.
2. Given a log line containing each pattern, emitted output replaces each match with `***REDACTED***` and contains no substring of the original key.
3. Wrapper handles strings, Errors (`.message` and `.stack`), and objects (JSON-stringified before redact).
4. Redaction occurs before any sink write — verified by capturing stdout in a test.
5. Patterns defined in one place and exported for reuse.

**Priority:** High

**Source AC:** F18

---

### REQ-REDACT-002: Per-pattern unit-test fixtures for redaction

**Description:**
Add unit tests with one fixture per redaction pattern + negative fixtures that must NOT be redacted.

**Acceptance Criteria:**
1. Test file `server/redact.test.mjs` includes ≥ 4 positive fixtures (one per pattern) plus a mixed-string fixture.
2. Each positive fixture asserts: full key gone, `***REDACTED***` present, surrounding context preserved.
3. Negative fixtures: bare `sk-ant-` (no body), `AIza` (too short), random `sk-` non-key strings under 10 chars are NOT redacted (or document the policy explicitly).
4. CI fails if any fixture regresses.
5. `scripts/smoke.mjs` final step greps the captured server log and fails if any of the 4 patterns survives.

**Priority:** High

**Source AC:** F19

---

### REQ-DOCS-001: README documents 4 providers with key-source link, format, default model, env var, free-tier note

**Description:**
The README's "Supported Providers" section contains exactly one row per provider listing: (a) live link to the official console / token page, (b) key format example, (c) default model used, (d) env var that overrides it, (e) one-line free-tier note.

**Acceptance Criteria:**
1. README contains a "## Supported Providers" section with subsections for Anthropic, OpenAI, Google Gemini, GitHub Models in that order.
2. Each subsection contains all five elements (a)–(e); a CI lint step greps and fails if any element is missing.
3. The console URLs return HTTP 200 (verifiable via `scripts/smoke.mjs --docs-links` or manual check).
4. Default models in README match constants exported by adapters.
5. Env var names match those read by adapters (`ANTHROPIC_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL`, `GITHUB_MODELS_MODEL`).

**Priority:** Medium

**Source AC:** G20

---

### REQ-DOCS-002: GitHub Models ≠ GitHub Copilot disambiguation in README and onboarding

**Description:**
README and onboarding both explicitly state that "GitHub Models" is not "GitHub Copilot" and that Copilot has no public chat API; the supported endpoint is `models.github.ai/inference` accessed with a Personal Access Token requiring `models:read` scope.

**Acceptance Criteria:**
1. README contains a sentence with both "GitHub Models" and "GitHub Copilot" explicitly disambiguating them.
2. Onboarding modal renders permanent disclaimer text under the GitHub Models radio (visible regardless of selection).
3. Both surfaces mention `models.github.ai/inference` and the PAT requirement.
4. Both surfaces note the `models:read` scope.

**Priority:** Medium

**Source AC:** G21

---

### REQ-SMOKE-001: Fake-key happy path returns INVALID_KEY for all 4 adapters

**Description:**
`scripts/smoke.mjs` invokes each adapter with a deliberately-invalid key (`sk-ant-XXX`, `sk-XXX`, `AIzaXXX`, `ghp_XXX`) and asserts the adapter returns an event with `code:'INVALID_KEY'`. Default mode performs only an auth-probe round-trip (no real billable text generation).

**Acceptance Criteria:**
1. `node scripts/smoke.mjs` exits 0 when all 4 fake-key probes return `INVALID_KEY`.
2. Exits non-zero (and prints which provider failed) if any returns a different code.
3. Default mode performs ≤ 1 upstream HTTP call per provider.
4. Script prints redacted key fragments only; final step greps captured log for redaction leaks.
5. Wired into `npm run smoke` (or equivalent).

**Priority:** Medium

**Source AC:** H22

---

### REQ-SMOKE-002: `--integration` flag enables real-key smoke; CI never runs it

**Description:**
The smoke script accepts `--integration` that runs end-to-end real-key probes against ≥ 2 providers using keys read from local env vars. CI must never pass `--integration`.

**Acceptance Criteria:**
1. `node scripts/smoke.mjs --integration` runs real upstream calls for ≥ 2 providers; without the flag, it does not.
2. If required env vars are missing under `--integration`, script exits non-zero with a clear "set X to run integration smoke" message.
3. CI workflow does not contain the substring `--integration`; CI lint step asserts this.
4. README documents how to run `--integration` locally.

**Priority:** Medium

**Source AC:** H23

---

## MODIFIED

### `POST /api/chat` request contract

- **Before (v1):** Body `{messages, systemPrompt, ...}`; key from header `X-Anthropic-Key`.
- **After (v2):** Body `{provider: "anthropic"|"openai"|"gemini"|"github", messages, systemPrompt, ...}`; key from header `X-Provider-Key`. Missing/unknown `provider` ⇒ HTTP 400. v1 clients sending `X-Anthropic-Key` are NOT auto-translated server-side — frontend migration (REQ-MIGRATE-002) handles transition; server treats missing `X-Provider-Key` as `INVALID_KEY`.

### `localStorage` schema

- **Before (v1):** `localStorage['cv-builder.anthropic-key'] = 'sk-ant-...'` (raw string).
- **After (v2):** `localStorage['cv-builder.provider'] = JSON.stringify({provider, key})`. v1 entry is migrated and deleted on first v2 boot (REQ-MIGRATE-002). v2 code MUST NOT write to the v1 key under any path.

### `GET /api/health` response shape

- **Before (v1):** `{ok, python}`.
- **After (v2):** `{ok, python, providers: {anthropic, openai, gemini, github}}`. Backwards-compatible additive field; existing v1 consumers (none beyond the smoke script) remain unaffected.

---

## REMOVED

### Hardcoded `@anthropic-ai/sdk` import in `server/server.js`

Removed: v1 top-of-file `import Anthropic from '@anthropic-ai/sdk'` and inline streaming logic that consumed Anthropic's native event shape inside the route handler. All Anthropic-specific code now lives in `server/providers/anthropic.js`. `server/server.js` only knows the dispatch table and the unified envelope.

### `lib/anthropic-errors.js`

Removed: v1 Anthropic-only error mapper. Responsibilities absorbed into (a) per-provider adapter error normalisation and (b) the shared `mapError` helper backing the unified taxonomy (REQ-ERROR-001). Any imports of `lib/anthropic-errors.js` must be deleted; CI grep asserts zero references remain in the v2 tree.

### `scripts/smoke.sh`

Removed: replaced by `scripts/smoke.mjs` (Node-based, supports `--integration` flag, integrates redaction-leak check). `npm run smoke` repointed.
