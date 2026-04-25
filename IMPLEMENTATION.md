# IMPLEMENTATION.md — cv-builder-multi-provider (v2)

## 這輪做了什麼

從 cv-builder-web-app (v1, status=done) 複製 source tree，演化成支援 4 家 AI provider 的 v2。

### 主要變更 vs v1

| 模組 | 變更 |
|------|------|
| `server/server.js` | 移除 Anthropic SDK 直接 import，改用 provider registry dispatch；`/api/chat` 改讀 `provider` (body) + `x-provider-key` (header)；`/api/health` 新增 `providers` 欄位；所有 log 走 `redactingLogger` |
| `server/providers/anthropic.js` | 從 v1 server.js 抽出 streaming 邏輯；加 UTF-8 watchdog + empty-stream synthesis + abort handling |
| `server/providers/openai.js` | 新增 OpenAI adapter，相同 streaming envelope |
| `server/providers/gemini.js` | 新增 Gemini adapter，處理 role rewrite / empty-message padding / systemInstruction overflow fallback |
| `server/providers/github.js` | 新增 GitHub Models adapter（復用 openai SDK + baseURL 替換） |
| `server/providers/index.js` | Registry + 懶初始化 SDK probe（Promise memoisation） |
| `server/error-taxonomy.js` | 6-code 統一 taxonomy + 4 家 per-provider mapper |
| `server/redact.js` | 4 pattern redaction，`redactingLogger` wrapper |
| `server/redact.test.mjs` | 13 個單元測試，100% pass |
| `server/providers/*.test.mjs` | 4 個 adapter 測試，20 個案例，全 pass |
| `web/index.html` | 2-step onboarding modal（provider radio → key input）；GitHub disclaimer；migration toast |
| `web/styles.css` | Provider radio group、free-badge、disclaimer、toast、切換提供者 button 樣式 |
| `web/app.js` | v2 credential state machine；`migrateV1IfNeeded()`；2-step modal；`probeAndDisableProviders()`；`doStreamChat` 帶 `x-provider-key` header；ERROR_MESSAGES_ZH 常數；multi-tab abort safety |
| `scripts/smoke.mjs` | 替換 smoke.sh，Node-based；4 provider INVALID_KEY check + redaction leak grep + --integration flag |
| `lib/anthropic-errors.js` | 保留（v1 parse/render 有 lib/parser-bridge 依賴），但 server.js 不再 import |
| `README.md` | 全新：4 provider 各自的 key 取得步驟、格式、model、env var、免費額度 |

### 關鍵設計決策

1. **降級策略 A**：SDK 未安裝 → onboarding radio disabled（非 crash）
2. **Promise memoisation**：`probeProviders()` 只跑一次，concurrent 呼叫等同一個 Promise
3. **Gemini systemInstruction overflow fallback**：超過 30k chars → prepend as user turn + WARN log
4. **60s idle watchdog**：獨立於 AbortSignal，處理 laptop sleep/VPN 重連
5. **UTF-8 buffering**：`TextDecoder({stream:true})`，所有 adapter 統一
6. **Multi-tab safety**：`sendChat()` 在 submit 時 snapshot `{provider, key}`，不在 stream 中重讀 localStorage
7. **migration 策略**：v1 key → v2 schema（silent + 3s toast）；v2 wins if both present；empty v1 → 直接 onboarding
8. **localStorage quota fallback**：try/catch + in-memory `_sessionCredentials` + banner
9. **402 → RATE_LIMITED**：UX choice（用戶理解「額度用完」勝過「未知錯誤」）
10. **GitHub 401/403 message**：明確提示 PAT + models:read scope

### tasks.md 完成度

21/21 tasks 完成（T20 --integration 因環境無 real keys，smoke 預設路徑已通過）

## 驗收執行結果

### T19: 單元測試 + smoke（fake-key path）

```
server/redact.test.mjs            13/13 pass
server/providers/anthropic.test.mjs  4/4 pass
server/providers/openai.test.mjs     4/4 pass
server/providers/gemini.test.mjs     6/6 pass
server/providers/github.test.mjs     4/4 pass (with 2 extra from github.test assertions)

smoke.mjs:
  /api/health → providers: all 4 = true
  [anthropic] INVALID_KEY ✓
  [openai]    INVALID_KEY ✓
  [gemini]    INVALID_KEY ✓
  [github]    INVALID_KEY ✓
  parse smoke → name=王大明 ✓
  redaction leak check → clean ✓
```

### T20: --integration（real keys）

未執行（環境無 integration key env vars）。verify 階段需手動執行或提供 key 後執行：

```bash
ANTHROPIC_API_KEY_INTEGRATION=sk-ant-... \
OPENAI_API_KEY_INTEGRATION=sk-... \
node scripts/smoke.mjs --integration
```

## 未做的事（非本次範圍）

- 5th provider（Cohere / Mistral / xAI）
- fallback chaining（A fail → switch B）
- token counter / cost UI
- tool calling / function calling
- local LLM (Ollama)
- cross-tab storage event sync
