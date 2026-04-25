# CV Builder v2 — 多 Provider BYOK 履歷產生器

**CV Builder v2** 是 v1 的升級版，支援 **4 家 AI 提供者**（Anthropic / OpenAI / Google Gemini / GitHub Models）。使用者選擇自己擁有的 API key，無需綁定特定廠商。

## 快速啟動

```bash
npm install
npm start           # 預設 http://127.0.0.1:5173
```

第一次開啟，選擇你的 AI 提供者並貼上對應的 key，開始用 AI 對話生成履歷。

## Supported Providers

### Anthropic

- **取得 API Key**: [Anthropic Console → API Keys](https://console.anthropic.com/settings/keys)
- **Key 格式**: `sk-ant-api03-...`
- **預設 model**: `claude-sonnet-4-6`
- **環境變數 override**: `ANTHROPIC_MODEL`
- **免費額度**: 無（付費制）

### OpenAI

- **取得 API Key**: [OpenAI Platform → API Keys](https://platform.openai.com/api-keys)
- **Key 格式**: `sk-proj-...` 或 `sk-...`
- **預設 model**: `gpt-4o-mini`
- **環境變數 override**: `OPENAI_MODEL`
- **免費額度**: 無（付費制，新帳戶有試用額度）

### Google Gemini

- **取得 API Key**: [Google AI Studio](https://aistudio.google.com/apikey)
- **Key 格式**: `AIzaSy...`
- **預設 model**: `gemini-2.0-flash`
- **環境變數 override**: `GEMINI_MODEL`
- **免費額度**: 有（每日免費 quota，詳見 [AI Studio 定價](https://ai.google.dev/pricing)）

### GitHub Models

> **重要提醒**: **GitHub Models ≠ GitHub Copilot**。GitHub Copilot 是 IDE 補全工具，沒有公開的 chat API。CV Builder 使用的是 **GitHub Models**（`models.github.ai/inference`），透過 GitHub Personal Access Token 存取。

- **取得 PAT**: [GitHub Settings → Personal Access Tokens](https://github.com/settings/tokens)
  - 建立 token 時勾選 **`models:read`** 權限（Read access to GitHub Models）
  - 支援 Classic PAT（`ghp_...`）或 Fine-grained PAT（`github_pat_...`）
- **Key 格式**: `ghp_...` 或 `github_pat_...`
- **預設 model**: `gpt-4o-mini`
- **環境變數 override**: `GITHUB_MODELS_MODEL`
- **免費額度**: 有（依 GitHub 帳戶等級，詳見 [GitHub Models 文件](https://docs.github.com/en/github-models/prototyping-with-ai-models)）

---

## BYOK 安全保證

- API key **只儲存在您的瀏覽器 localStorage**，不會送到任何後端儲存或第三方服務
- 後端 server-side log 會自動 **redact 所有 4 種 key pattern**（`sk-ant-...`、`sk-...`、`AIza...`、`ghp_...`/`github_pat_...`）
- 按「切換提供者」可立即清除並重新選擇

## v1 → v2 Migration FAQ

**Q: 我之前用 Anthropic key 的設定還在嗎？**
A: 是的。v2 首次載入時會自動偵測 v1 格式的 key，無聲地 migrate 到 v2 schema，並顯示一條 3 秒提示。你不需要重新輸入。

**Q: localStorage schema 有什麼變化？**
A: v1 存的是 `localStorage['cv-builder.anthropic-key']`（原始字串）；v2 存的是 `localStorage['cv-builder.provider']`（JSON `{provider, key}`）。遷移由前端自動完成。

**Q: 我可以隨時換 provider 嗎？**
A: 可以。點右上角「切換提供者」即可重新選擇，切換時若有進行中的 AI 串流會先安全中斷。

## 環境變數

| 變數 | 說明 |
|------|------|
| `PORT` | 伺服器 port（預設 5173） |
| `ANTHROPIC_MODEL` | 覆蓋 Anthropic 預設 model |
| `OPENAI_MODEL` | 覆蓋 OpenAI 預設 model |
| `GEMINI_MODEL` | 覆蓋 Gemini 預設 model |
| `GITHUB_MODELS_MODEL` | 覆蓋 GitHub Models 預設 model |

若環境變數設定了不存在的 model，adapter 會回傳 `MODEL_NOT_FOUND` 錯誤。

## 執行 Smoke Test

```bash
# 預設（假 key 測試，不花費 API 費用）
npm run smoke

# Integration（真 key，本地偶爾跑，CI 不跑）
ANTHROPIC_API_KEY_INTEGRATION=sk-ant-... OPENAI_API_KEY_INTEGRATION=sk-... npm run smoke -- --integration
```

## v1 比較

| 功能 | v1 | v2 |
|------|----|----|
| Provider | Anthropic only | Anthropic / OpenAI / Gemini / GitHub Models |
| Onboarding | 貼 Anthropic key | 2-step：選 provider → 貼 key |
| localStorage | `cv-builder.anthropic-key` | `cv-builder.provider` (JSON) |
| Migration | N/A | 自動 migrate v1 key |
| 免費額度 | 無 | Gemini + GitHub Models 有免費額度 |
