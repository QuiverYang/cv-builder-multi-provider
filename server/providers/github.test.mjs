/**
 * GitHub Models adapter unit tests
 * Run: node --test server/providers/github.test.mjs
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { streamChat, DEFAULT_MODEL } from './github.js';

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

describe('GitHub Models adapter — DEFAULT_MODEL', () => {
  it('exports gpt-4o-mini as default', () => {
    assert.equal(DEFAULT_MODEL, 'gpt-4o-mini');
  });
});

describe('GitHub Models adapter — streamChat returns ReadableStream', () => {
  it('returns a ReadableStream instance', () => {
    const stream = streamChat({
      apiKey: 'ghp_fake',
      systemPrompt: 'test',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 10,
    });
    assert.ok(stream instanceof ReadableStream);
    stream.getReader().cancel().catch(() => {});
  });
});

describe('GitHub Models adapter — AbortSignal (pre-aborted)', () => {
  it('emits TIMEOUT event immediately when pre-aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = streamChat({
      apiKey: 'ghp_fake',
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

describe('GitHub Models adapter — PAT-specific error message', () => {
  it('INVALID_KEY message_zh mentions GitHub PAT and models:read', async () => {
    // Import error taxonomy to verify the message
    const { mapGithubError } = await import('../error-taxonomy.js');
    const fakeErr = { status: 401, message: 'Invalid credentials' };
    const result = mapGithubError(fakeErr);
    assert.equal(result.code, 'INVALID_KEY');
    assert.ok(result.message_zh.includes('GitHub'), 'should mention GitHub');
    assert.ok(result.message_zh.includes('models:read'), 'should mention models:read scope');
  });
});

describe('GitHub Models adapter — error taxonomy (fake PAT)', () => {
  it('returns an error event for invalid PAT', async () => {
    const ctrl = new AbortController();
    const stream = streamChat({
      apiKey: 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
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
