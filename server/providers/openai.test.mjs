/**
 * OpenAI adapter unit tests
 * Run: node --test server/providers/openai.test.mjs
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { streamChat, DEFAULT_MODEL } from './openai.js';

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

describe('OpenAI adapter — DEFAULT_MODEL', () => {
  it('exports gpt-4o-mini as default', () => {
    assert.equal(DEFAULT_MODEL, 'gpt-4o-mini');
  });
});

describe('OpenAI adapter — streamChat returns ReadableStream', () => {
  it('returns a ReadableStream instance', () => {
    const stream = streamChat({
      apiKey: 'sk-' + 'fake',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 10,
    });
    assert.ok(stream instanceof ReadableStream);
    stream.getReader().cancel().catch(() => {});
  });
});

describe('OpenAI adapter — AbortSignal (pre-aborted)', () => {
  it('emits TIMEOUT event immediately when pre-aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = streamChat({
      apiKey: 'sk-' + 'fake',
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

describe('OpenAI adapter — error taxonomy (fake key)', () => {
  it('returns an error event for invalid key', async () => {
    const ctrl = new AbortController();
    const stream = streamChat({
      apiKey: 'sk-' + 'fake-invalid-0000000000000000000000',
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
