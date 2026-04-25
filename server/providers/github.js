import OpenAI from 'openai';
import { makeErrorEvent, mapGithubError, ERROR_CODES } from '../error-taxonomy.js';
import { redactingLogger } from '../redact.js';

export const DEFAULT_MODEL = 'gpt-4o-mini';
const GITHUB_MODELS_BASE_URL = 'https://models.github.ai/inference';
const IDLE_TIMEOUT_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const EMPTY_STREAM_MESSAGE = '上游回應為空，可能被內容政策過濾，請改寫提示再試。';

const logger = redactingLogger();

export function streamChat({ apiKey, systemPrompt, messages, model, maxTokens = 2048, abortSignal }) {
  const resolvedModel = model ?? process.env.GITHUB_MODELS_MODEL ?? DEFAULT_MODEL;

  return new ReadableStream({
    async start(controller) {
      const decoder = new TextDecoder('utf-8', { stream: true });
      let bytesEmitted = 0;
      let lastByteAt = Date.now();
      let watchdog = null;
      let finished = false;

      function close(event) {
        if (finished) return;
        finished = true;
        clearInterval(watchdog);
        if (event) controller.enqueue(event);
        try { controller.close(); } catch {}
      }

      watchdog = setInterval(() => {
        if (Date.now() - lastByteAt > IDLE_TIMEOUT_MS) {
          logger.warn('[github] idle watchdog triggered');
          close(makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷'));
          abortCtrl.abort();
        }
      }, WATCHDOG_INTERVAL_MS);

      const abortCtrl = new AbortController();
      if (abortSignal) {
        if (abortSignal.aborted) { close(makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷')); return; }
        abortSignal.addEventListener('abort', () => {
          abortCtrl.abort();
          close(makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷'));
        }, { once: true });
      }

      try {
        const client = new OpenAI({ apiKey, baseURL: GITHUB_MODELS_BASE_URL });
        const upstream = [
          ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
          ...messages,
        ];

        const stream = await client.chat.completions.create(
          { model: resolvedModel, stream: true, messages: upstream, max_tokens: maxTokens },
          { signal: abortCtrl.signal }
        );

        for await (const chunk of stream) {
          if (finished) break;
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) {
            const text = decoder.decode(Buffer.from(delta), { stream: true });
            if (text) {
              lastByteAt = Date.now();
              bytesEmitted += text.length;
              controller.enqueue({ type: 'text_delta', delta: text });
            }
          }
        }
        const flushed = decoder.decode();
        if (flushed) { bytesEmitted += flushed.length; controller.enqueue({ type: 'text_delta', delta: flushed }); }

        if (bytesEmitted === 0 && !finished) {
          close(makeErrorEvent(ERROR_CODES.UPSTREAM_ERROR, EMPTY_STREAM_MESSAGE));
        } else {
          close(null);
        }
      } catch (err) {
        if (finished) return;
        logger.error('[github] error:', err);
        close(mapGithubError(err));
      }
    },
  });
}
