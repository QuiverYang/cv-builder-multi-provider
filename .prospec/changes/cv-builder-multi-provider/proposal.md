# cv-builder-multi-provider

## User Story

As a **resume-building user who does not have (or does not want to spend on) an Anthropic API key**,
I want **to use my OpenAI, Google Gemini, or GitHub Models token instead, picking my provider during onboarding and pasting the matching key**,
So that **I can use the CV Builder chat without being forced to subscribe to a single LLM vendor — and existing v1 users with an Anthropic key keep working with zero re-onboarding.**

## Acceptance Criteria

### A. Provider selection & onboarding

1. On first visit (no provider+key in localStorage and no legacy v1 key), the onboarding modal renders **two steps**: (1) provider radio group with 4 options (Anthropic / OpenAI / Google Gemini / GitHub Models) and (2) a key input whose placeholder + helper text matches the picked provider (`sk-ant-...`, `sk-...`, `AIza...`, `ghp_...` or `github_pat_...`).
2. The modal includes a one-line link per provider pointing to the official console / token page where users can fetch a key.
3. The user can switch provider in step 1 freely before submitting — placeholder + helper text update live without page reload.
4. After submit, `localStorage['cv-builder.provider']` is written as JSON `{"provider": "...", "key": "..."}` (v2 schema). The onboarding modal closes and chat is enabled.

### B. Returning user & legacy migration

5. If `localStorage['cv-builder.provider']` (v2) exists at boot, onboarding is skipped and chat is enabled with the stored provider+key.
6. If `localStorage['cv-builder.anthropic-key']` (v1 schema) exists but no v2 entry, the app **silently migrates** to v2 with `provider: "anthropic"`, deletes the v1 key, and reloads chat without prompting the user.
7. A "Change provider" affordance in the UI lets the user wipe the stored provider+key and re-open onboarding without a full page reload.

### C. Backend dispatch & streaming

8. `POST /api/chat` reads `provider` from the request body and the API key from a request header (`X-Provider-Key`); it dispatches to the corresponding adapter under `server/providers/<provider>.js`.
9. All 4 adapters expose the same interface `streamChat({ apiKey, systemPrompt, messages, model, maxTokens, abortSignal }) → ReadableStream<Event>` where `Event` is `{type:'text_delta', delta:string}` or `{type:'error', code, message_zh}`.
10. The frontend SSE consumer **does not branch on provider** — it only reads `text_delta` events and a final `[DONE]` marker, so swapping provider does not require a frontend change.
11. System prompt is passed as a single string from the frontend; each adapter routes it to its provider's idiomatic location (Anthropic `system` field, OpenAI/GitHub `messages[0]={role:"system"}`, Gemini `systemInstruction`, with Gemini also rewriting `assistant` → `model`).

### D. Defaults, env override, and health

12. Each provider has a default model: Anthropic `claude-sonnet-4-6`, OpenAI `gpt-4o-mini`, Gemini `gemini-2.0-flash`, GitHub Models `gpt-4o-mini`.
13. Env vars override defaults: `ANTHROPIC_MODEL`, `OPENAI_MODEL`, `GEMINI_MODEL`, `GITHUB_MODELS_MODEL`. Unset → default. If override names a non-existent model, the adapter returns `MODEL_NOT_FOUND`.
14. `GET /api/health` returns `{providers: {anthropic: bool, openai: bool, gemini: bool, github: bool}}` indicating whether each SDK is installed and importable. Detection uses dynamic `import()` and never throws.
15. Providers whose SDK is missing are **rendered as disabled** in the onboarding provider radio (degradation strategy A from idea Notes).

### E. Error taxonomy (uniform across providers)

16. All adapters map upstream errors to one of: `INVALID_KEY` (401-class), `RATE_LIMITED` (429), `OVERLOADED` (503/529), `TIMEOUT` (abort/deadline), `MODEL_NOT_FOUND`, `UPSTREAM_ERROR` (everything else).
17. The frontend renders a localized Chinese message per code; it **never** displays raw upstream JSON / SDK stack trace.

### F. Security — key redaction

18. Server-side request/error logger redacts all 4 key patterns before any line is written: `sk-ant-[A-Za-z0-9_\-]+`, `sk-[A-Za-z0-9_\-]+`, `AIza[A-Za-z0-9_\-]{35}`, `ghp_[A-Za-z0-9]{36,}`, `github_pat_[A-Za-z0-9_]{20,}`.
19. The redaction is unit-tested with one fixture per pattern.

### G. README & onboarding clarity

20. README documents — for each of the 4 providers — (a) where to get the key (live link), (b) what format it has, (c) what default model is used, (d) what env var overrides it, (e) what free-tier exists.
21. README and onboarding both explicitly state: **"GitHub Models" ≠ "GitHub Copilot"** — Copilot has no public chat API; we use `models.github.ai/inference` with a Personal Access Token.

### H. Smoke / verification

22. `scripts/smoke.mjs` invokes each provider with a deliberately-invalid key (`sk-XXX`, `AIzaXXX`, `ghp_XXX`, `sk-ant-XXX`) and asserts the adapter returns `INVALID_KEY` (no real upstream calls billed).
23. `--integration` flag enables real-key smoke runs for at least 2 providers locally; CI never runs `--integration`.

## Related Modules

_v2 builds on `cv-builder-web-app` v1 (separate project under `projects/cv-builder-web-app/`)._
_Hard prerequisite: v1 must be in `verification-passed` state before implement starts. v2 will copy the v1 source into its own project directory at the start of implement and evolve from there._

## Edge Cases

- **Provider selected but key field empty** → submit disabled, no localStorage write.
- **User pastes Anthropic key after picking OpenAI** → no client-side format validation (we don't want false-negatives on future key prefixes); upstream returns `INVALID_KEY`, frontend shows "金鑰格式不符或被拒，請確認你選的 provider 與貼的金鑰一致。"
- **Streaming aborted mid-response** (user navigates away, network drop) → adapter must propagate `AbortSignal` to the SDK and yield `{type:'error', code:'TIMEOUT'}` so the frontend can show "已中斷"; no orphaned upstream connection.
- **localStorage v1 key empty string** → treat as "no v1 key", do not migrate empty values.
- **Both v1 and v2 entries present** (manual tampering or re-running v1 in another tab) → v2 wins, v1 deleted.
- **`/api/health` called before SDKs probed** → never blocks; first call probes lazily and caches the result for the process lifetime.
- **GitHub Models PAT with insufficient scopes** → returns `INVALID_KEY` (matches the error-taxonomy bucket; the message_zh hints "請確認 PAT 有 `models:read` 範圍").
- **Gemini message history contains an `assistant` role** (returning user with stored history) → adapter rewrites to `model` before sending; never throws.
- **System prompt exceeds Gemini's `systemInstruction` size limit** → adapter falls back to prepending it as a `user` turn and continues; logs a `WARN` with redacted key.

## Notes

This proposal is the **v2 contract** for `cv-builder-multi-provider`. It directly extends v1 (Anthropic-only BYOK). Keep v1 working as a special case (`provider: "anthropic"`) so all v1 users transparently become v2 users.

The 4-provider scope is locked (matches Integrator's accept-with-22h decision over Pragmatist's split-MVP). Stretch to a 5th provider is **out of scope** for v2 and lives in a future change.
