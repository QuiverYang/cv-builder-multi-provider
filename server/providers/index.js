// Provider registry with lazy SDK probing and adapter loading.
//
// Adapter interface contract (additive — future types like 'tool_use' or 'image_block'
// can be added without breaking existing text_delta consumers):
//   streamChat({ apiKey, systemPrompt, messages, model, maxTokens, abortSignal })
//     → ReadableStream<{ type: 'text_delta', delta: string }
//                    | { type: 'error', code: string, message_zh: string }>
import { makeErrorEvent } from '../error-taxonomy.js';

export const KNOWN_PROVIDERS = ['anthropic', 'openai', 'gemini', 'github'];

const SDK_PACKAGES = {
  anthropic: '@anthropic-ai/sdk',
  openai: 'openai',
  gemini: '@google/genai',
  github: 'openai',
};

const ADAPTER_PATHS = {
  anthropic: new URL('./anthropic.js', import.meta.url).pathname,
  openai: new URL('./openai.js', import.meta.url).pathname,
  gemini: new URL('./gemini.js', import.meta.url).pathname,
  github: new URL('./github.js', import.meta.url).pathname,
};

// Memoised Promise — concurrent callers await the same probe
let _probePromise = null;

export function probeProviders() {
  if (_probePromise) return _probePromise;
  _probePromise = (async () => {
    const result = {};
    for (const [id, pkg] of Object.entries(SDK_PACKAGES)) {
      try {
        await import(pkg);
        result[id] = true;
      } catch {
        result[id] = false;
      }
    }
    return result;
  })();
  return _probePromise;
}

export async function loadAdapter(name) {
  if (!KNOWN_PROVIDERS.includes(name)) {
    return {
      streamChat: () => new ReadableStream({
        start(controller) {
          controller.enqueue(makeErrorEvent('UPSTREAM_ERROR', `未知的 provider: ${name}`));
          controller.close();
        },
      }),
    };
  }
  try {
    return await import(ADAPTER_PATHS[name]);
  } catch (err) {
    return {
      streamChat: () => new ReadableStream({
        start(controller) {
          controller.enqueue(makeErrorEvent('UPSTREAM_ERROR', `無法載入 ${name} adapter`));
          controller.close();
        },
      }),
    };
  }
}
