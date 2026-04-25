/**
 * Maps Anthropic SDK errors to stable user-facing taxonomy.
 * Frontend always receives: {code, message_zh, retry_after_s?}
 */

export const ERROR_CODES = {
  BYOK_INVALID: 'BYOK_INVALID',
  BYOK_RATE_LIMITED: 'BYOK_RATE_LIMITED',
  BYOK_OVERLOADED: 'BYOK_OVERLOADED',
  STREAM_ABORTED: 'STREAM_ABORTED',
  BYOK_UNKNOWN: 'BYOK_UNKNOWN',
};

const REDACT_RE = /sk-ant-[A-Za-z0-9_-]+/g;

function redact(s) {
  if (typeof s !== 'string') return s;
  return s.replace(REDACT_RE, '[REDACTED]');
}

/**
 * Map an Anthropic SDK error or HTTP status to user-facing payload.
 * @param {Error|object} err
 * @returns {{ code: string, message_zh: string, retry_after_s?: number }}
 */
export function mapError(err) {
  const status = err?.status ?? err?.statusCode ?? 0;
  const retryAfterHeader = err?.headers?.['retry-after'] ?? err?.headers?.['x-ratelimit-reset-requests'];

  if (status === 401) {
    return {
      code: ERROR_CODES.BYOK_INVALID,
      message_zh: 'API key 被 Anthropic 拒絕（401），請確認 sk-ant-... 並重新貼上',
    };
  }

  if (status === 429) {
    const retryAfterS = retryAfterHeader ? parseInt(retryAfterHeader, 10) : undefined;
    const result = {
      code: ERROR_CODES.BYOK_RATE_LIMITED,
      message_zh: retryAfterS
        ? `Anthropic 限流，請 ${retryAfterS} 秒後再送出`
        : 'Anthropic 限流，請稍後再試',
    };
    if (retryAfterS) result.retry_after_s = retryAfterS;
    return result;
  }

  if (status === 529 || status === 503) {
    return {
      code: ERROR_CODES.BYOK_OVERLOADED,
      message_zh: 'Anthropic 目前過載（529），系統已自動重試一次',
    };
  }

  // AbortError or network cancel
  if (
    err?.name === 'AbortError' ||
    err?.code === 'ECONNRESET' ||
    err?.message?.includes('aborted') ||
    err?.message?.includes('abort')
  ) {
    return {
      code: ERROR_CODES.STREAM_ABORTED,
      message_zh: '連線中斷，此次對話已標記 [中斷]',
    };
  }

  const safeMsg = redact(err?.message ?? String(err));
  return {
    code: ERROR_CODES.BYOK_UNKNOWN,
    message_zh: `未知錯誤（${status || 'network'}）：${safeMsg.slice(0, 120)}`,
  };
}
