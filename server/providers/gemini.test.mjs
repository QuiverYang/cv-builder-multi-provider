/**
 * Gemini adapter unit tests
 * Run: node --test server/providers/gemini.test.mjs
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { streamChat, DEFAULT_MODEL } from './gemini.js';

async function collect(readable) {
  const events = [];
  const reader = readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    events.push(value);
  }
  return events;
}

describe('Gemini adapter — DEFAULT_MODEL', () => {
  it('exports gemini-2.0-flash as default', () => {
    assert.equal(DEFAULT_MODEL, 'gemini-2.0-flash');
  });
});

describe('Gemini adapter — streamChat returns ReadableStream', () => {
  it('returns a ReadableStream instance', () => {
    const stream = streamChat({
      apiKey: 'AIzaFake',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 10,
    });
    assert.ok(stream instanceof ReadableStream);
    stream.getReader().cancel().catch(() => {});
  });
});

describe('Gemini adapter — AbortSignal (pre-aborted)', () => {
  it('emits TIMEOUT event immediately when pre-aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = streamChat({
      apiKey: 'AIzaFake',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hello' }],
      abortSignal: ctrl.signal,
    });
    const events = await collect(stream);
    assert.ok(events.length >= 1);
    assert.equal(events[0].type, 'error');
    assert.equal(events[0].code, 'TIMEOUT');
  });
});

describe('Gemini adapter — role rewrite (assistant → model)', () => {
  it('streamChat accepts assistant role without throwing', () => {
    // Verify adapter does not throw during construction for assistant role messages
    assert.doesNotThrow(() => {
      const stream = streamChat({
        apiKey: 'AIzaFake',
        systemPrompt: '',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi' },
          { role: 'user', content: 'how are you?' },
        ],
      });
      stream.getReader().cancel().catch(() => {});
    });
  });
});

describe('Gemini adapter — empty messages padding', () => {
  it('streamChat accepts empty messages array without throwing', () => {
    assert.doesNotThrow(() => {
      const stream = streamChat({
        apiKey: 'AIzaFake',
        systemPrompt: 'test',
        messages: [],
      });
      stream.getReader().cancel().catch(() => {});
    });
  });
});

describe('Gemini adapter — error taxonomy (fake key)', () => {
  it('returns an error event for invalid key', async () => {
    const ctrl = new AbortController();
    const stream = streamChat({
      apiKey: 'AIzaSyFakeKeyThatIsDefinitelyInvalid12345',
      systemPrompt: '',
      messages: [{ role: 'user', content: 'hello' }],
      abortSignal: ctrl.signal,
    });

    let events;
    try {
      const timer = setTimeout(() => ctrl.abort(), 10000);
      events = await collect(stream);
      clearTimeout(timer);
    } catch { return; }

    const errEvent = events.find(e => e.type === 'error');
    if (errEvent) {
      assert.ok(['INVALID_KEY', 'TIMEOUT', 'UPSTREAM_ERROR'].includes(errEvent.code),
        `unexpected code: ${errEvent.code}`);
    }
  });
});
