// Unified 6-code error taxonomy for all provider adapters
export const ERROR_CODES = {
  INVALID_KEY: 'INVALID_KEY',
  RATE_LIMITED: 'RATE_LIMITED',
  OVERLOADED: 'OVERLOADED',
  TIMEOUT: 'TIMEOUT',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
};

export function makeErrorEvent(code, message_zh) {
  return { type: 'error', code, message_zh };
}

// HTTP status → error code mapping
export function mapHttpStatus(status, defaultCode = ERROR_CODES.UPSTREAM_ERROR) {
  if (status === 401) return ERROR_CODES.INVALID_KEY;
  if (status === 402) return ERROR_CODES.RATE_LIMITED;
  if (status === 404) return ERROR_CODES.MODEL_NOT_FOUND;
  if (status === 429) return ERROR_CODES.RATE_LIMITED;
  if (status === 503 || status === 529) return ERROR_CODES.OVERLOADED;
  return defaultCode;
}

export function mapAnthropicError(err) {
  if (err?.name === 'AbortError' || err?.code === 'TIMEOUT') {
    return makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷');
  }
  const status = err?.status ?? err?.statusCode;
  const code = mapHttpStatus(status);
  const messages = {
    [ERROR_CODES.INVALID_KEY]: 'Anthropic 金鑰格式不符或被拒，請確認金鑰是否正確。',
    [ERROR_CODES.RATE_LIMITED]: 'Anthropic 請求太頻繁或額度已用完，稍候再試或到 Anthropic Console 檢查用量。',
    [ERROR_CODES.OVERLOADED]: 'Anthropic 服務暫時繁忙，請稍後再試一次。',
    [ERROR_CODES.MODEL_NOT_FOUND]: `Anthropic 找不到指定的 model（${err?.message ?? ''}），請確認環境變數 ANTHROPIC_MODEL 設定。`,
    [ERROR_CODES.UPSTREAM_ERROR]: 'Anthropic 發生未知錯誤，請稍後再試；若反覆出現請回報。',
  };
  return makeErrorEvent(code, messages[code] ?? messages[ERROR_CODES.UPSTREAM_ERROR]);
}

export function mapOpenAIError(err) {
  if (err?.name === 'AbortError' || err?.code === 'TIMEOUT') {
    return makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷');
  }
  const status = err?.status ?? err?.statusCode;
  const code = mapHttpStatus(status);
  const messages = {
    [ERROR_CODES.INVALID_KEY]: 'OpenAI 金鑰格式不符或被拒，請確認金鑰是否正確。',
    [ERROR_CODES.RATE_LIMITED]: 'OpenAI 請求太頻繁或額度已用完，稍候再試或到 OpenAI Platform 檢查用量。',
    [ERROR_CODES.OVERLOADED]: 'OpenAI 服務暫時繁忙，請稍後再試一次。',
    [ERROR_CODES.MODEL_NOT_FOUND]: `OpenAI 找不到指定的 model（${err?.message ?? ''}），請確認環境變數 OPENAI_MODEL 設定。`,
    [ERROR_CODES.UPSTREAM_ERROR]: 'OpenAI 發生未知錯誤，請稍後再試；若反覆出現請回報。',
  };
  return makeErrorEvent(code, messages[code] ?? messages[ERROR_CODES.UPSTREAM_ERROR]);
}

export function mapGeminiError(err) {
  if (err?.name === 'AbortError' || err?.code === 'TIMEOUT') {
    return makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷');
  }
  // Gemini uses message-based error detection
  const msg = (err?.message ?? '').toLowerCase();
  const status = err?.status ?? err?.statusCode ?? err?.httpStatusCode;

  let code = mapHttpStatus(status);
  if (code === ERROR_CODES.UPSTREAM_ERROR) {
    if (msg.includes('api_key') || msg.includes('api key') || msg.includes('invalid_argument') || msg.includes('invalid key')) {
      code = ERROR_CODES.INVALID_KEY;
    } else if (msg.includes('resource_exhausted') || msg.includes('quota') || msg.includes('rate')) {
      code = ERROR_CODES.RATE_LIMITED;
    } else if (msg.includes('unavailable') || msg.includes('overloaded')) {
      code = ERROR_CODES.OVERLOADED;
    } else if (msg.includes('not found') || msg.includes('model')) {
      code = ERROR_CODES.MODEL_NOT_FOUND;
    }
  }
  const messages = {
    [ERROR_CODES.INVALID_KEY]: 'Google Gemini 金鑰格式不符或被拒，請確認金鑰是否正確（AIza...）。',
    [ERROR_CODES.RATE_LIMITED]: 'Google Gemini 請求太頻繁或免費額度已用完，稍候再試或到 Google AI Studio 檢查用量。',
    [ERROR_CODES.OVERLOADED]: 'Google Gemini 服務暫時繁忙，請稍後再試一次。',
    [ERROR_CODES.MODEL_NOT_FOUND]: `Google Gemini 找不到指定的 model，請確認環境變數 GEMINI_MODEL 設定。`,
    [ERROR_CODES.UPSTREAM_ERROR]: 'Google Gemini 發生未知錯誤，請稍後再試；若反覆出現請回報。',
  };
  return makeErrorEvent(code, messages[code] ?? messages[ERROR_CODES.UPSTREAM_ERROR]);
}

export function mapGithubError(err) {
  if (err?.name === 'AbortError' || err?.code === 'TIMEOUT') {
    return makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷');
  }
  const status = err?.status ?? err?.statusCode;
  // 403 with scope issue → also INVALID_KEY
  let code = mapHttpStatus(status);
  if (status === 403) code = ERROR_CODES.INVALID_KEY;

  const messages = {
    [ERROR_CODES.INVALID_KEY]: 'GitHub Models 金鑰被拒，請確認使用的是 GitHub Personal Access Token（ghp_... 或 github_pat_...），並確認 PAT 有 models:read 權限。',
    [ERROR_CODES.RATE_LIMITED]: 'GitHub Models 請求太頻繁或免費額度已用完，稍候再試或到 GitHub 帳戶設定檢查用量。',
    [ERROR_CODES.OVERLOADED]: 'GitHub Models 服務暫時繁忙，請稍後再試一次。',
    [ERROR_CODES.MODEL_NOT_FOUND]: `GitHub Models 找不到指定的 model，請確認環境變數 GITHUB_MODELS_MODEL 設定。`,
    [ERROR_CODES.UPSTREAM_ERROR]: 'GitHub Models 發生未知錯誤，請稍後再試；若反覆出現請回報。',
  };
  return makeErrorEvent(code, messages[code] ?? messages[ERROR_CODES.UPSTREAM_ERROR]);
}
