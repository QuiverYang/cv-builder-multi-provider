import { GoogleGenAI } from '@google/genai';
import { makeErrorEvent, mapGeminiError, ERROR_CODES } from '../error-taxonomy.js';
import { redactingLogger } from '../redact.js';

export const DEFAULT_MODEL = 'gemini-2.0-flash';
const IDLE_TIMEOUT_MS = 60_000;
const WATCHDOG_INTERVAL_MS = 2_000;
const SYSTEM_INSTRUCTION_LIMIT = 30_000;
const EMPTY_STREAM_MESSAGE = '上游回應為空，可能被內容政策過濾，請改寫提示再試。';

const logger = redactingLogger();

function convertMessages(messages) {
  return messages.map((m) => {
    const role = m.role === 'assistant' ? 'model' : m.role;
    return { role, parts: [{ text: m.content ?? '' }] };
  });
}

export function streamChat({ apiKey, systemPrompt, messages, model, maxTokens = 2048, abortSignal }) {
  const resolvedModel = model ?? process.env.GEMINI_MODEL ?? DEFAULT_MODEL;

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
          logger.warn('[gemini] idle watchdog triggered');
          close(makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷'));
        }
      }, WATCHDOG_INTERVAL_MS);

      if (abortSignal) {
        if (abortSignal.aborted) { close(makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷')); return; }
        abortSignal.addEventListener('abort', () => {
          close(makeErrorEvent(ERROR_CODES.TIMEOUT, '已中斷'));
        }, { once: true });
      }

      try {
        const ai = new GoogleGenAI({ apiKey });

        let contents = convertMessages(messages);
        // Gemini rejects empty contents
        if (contents.length === 0) {
          contents = [{ role: 'user', parts: [{ text: ' ' }] }];
        }

        const config = { maxOutputTokens: maxTokens };

        // Handle systemPrompt placement
        let useSystemInstruction = false;
        if (systemPrompt) {
          if (systemPrompt.length <= SYSTEM_INSTRUCTION_LIMIT) {
            config.systemInstruction = systemPrompt;
            useSystemInstruction = true;
          } else {
            logger.warn('[gemini] systemInstruction overflow fallback applied');
            // Prepend as user turn
            contents = [{ role: 'user', parts: [{ text: systemPrompt }] }, ...contents];
          }
        }

        const geminiModel = ai.models;
        const streamResult = geminiModel.generateContentStream({
          model: resolvedModel,
          contents,
          config,
        });

        for await (const chunk of await streamResult) {
          if (finished) break;
          const text = chunk.text ?? '';
          if (text) {
            const decoded = decoder.decode(Buffer.from(text), { stream: true });
            if (decoded) {
              lastByteAt = Date.now();
              bytesEmitted += decoded.length;
              controller.enqueue({ type: 'text_delta', delta: decoded });
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
        logger.error('[gemini] error:', err);
        close(mapGeminiError(err));
      }
    },
  });
}
