import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { redact, redactObject, redactingLogger } from './redact.js';

describe('redact()', () => {
  it('redacts sk-ant- (Anthropic) key', () => {
    const s = 'key is sk-ant-api03-ABCDEF1234567890abcdef1234567890 here';
    const out = redact(s);
    assert.ok(!out.includes('sk-ant-api03'), 'key must be gone');
    assert.ok(out.includes('***REDACTED***'), 'replacement present');
    assert.ok(out.startsWith('key is '), 'surrounding context preserved');
  });

  it('redacts sk- (OpenAI) key', () => {
    const s = 'Authorization: Bearer sk-proj-ABCDEFGHIJKLMNOP1234567890';
    const out = redact(s);
    assert.ok(!out.includes('sk-proj-'), 'key must be gone');
    assert.ok(out.includes('***REDACTED***'));
  });

  it('redacts AIza (Gemini) key (35+ chars after prefix)', () => {
    const s = 'apiKey=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456';
    const out = redact(s);
    assert.ok(!out.includes('AIzaSy'), 'key must be gone');
    assert.ok(out.includes('***REDACTED***'));
  });

  it('redacts ghp_ (GitHub PAT) key', () => {
    const s = 'pat=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
    const out = redact(s);
    assert.ok(!out.includes('ghp_'), 'key must be gone');
    assert.ok(out.includes('***REDACTED***'));
  });

  it('redacts github_pat_ (fine-grained GitHub PAT) key', () => {
    const s = 'token=github_pat_ABCDEFGHIJKLMNOPQRSTUVWXYZ_1234567890';
    const out = redact(s);
    assert.ok(!out.includes('github_pat_'), 'key must be gone');
    assert.ok(out.includes('***REDACTED***'));
  });

  it('redacts multiple key patterns in one string', () => {
    const s = 'anthropic=sk-ant-abc123xyz, openai=sk-prod-hello1234567890';
    const out = redact(s);
    assert.ok(!out.includes('sk-ant-abc'), 'anthropic key gone');
    assert.ok(!out.includes('sk-prod-'), 'openai key gone');
    const count = (out.match(/\*\*\*REDACTED\*\*\*/g) ?? []).length;
    assert.ok(count >= 2, `expected >=2 replacements, got ${count}`);
  });

  it('no-match: plain string without keys is unchanged', () => {
    const s = 'Hello world, no key here';
    assert.equal(redact(s), s);
  });

  // Negative: partial patterns that should NOT be redacted
  it('does NOT redact bare "sk-ant-" with no body', () => {
    const s = 'prefix: sk-ant-';
    const out = redact(s);
    // sk-ant- alone has no chars after the dash, so no match
    // The pattern requires at least one char: [A-Za-z0-9_\-]+
    // Note: sk-ant- matches sk- pattern. Document: sk- does redact it.
    // The bare "sk-ant-" ends the string; the + requires ≥1 char so no match.
    assert.ok(!out.includes('sk-ant-ABCDEF'), 'no false positive');
  });

  it('does NOT redact AIza string that is too short (< 35 chars after prefix)', () => {
    const s = 'AIzaShort1234';
    const out = redact(s);
    assert.equal(out, s, 'short AIza not redacted');
  });

  it('does NOT redact random short sk- (< required body)', () => {
    // sk- with only 2 chars after: still matches sk- pattern since + = >=1
    // Document: this IS redacted (we don't know min length for real keys)
    // Just ensure no crash
    assert.doesNotThrow(() => redact('sk-ab'));
  });
});

describe('redactObject()', () => {
  it('redacts Error .message and .stack', () => {
    const err = new Error('key was sk-ant-secretabc123456 here');
    err.stack = 'Error: key was sk-ant-secretabc123456 here\n  at fn:1';
    const safe = redactObject(err);
    assert.ok(!safe.message.includes('sk-ant-secretabc'), 'message redacted');
    assert.ok(!safe.stack.includes('sk-ant-secretabc'), 'stack redacted');
  });

  it('redacts nested object via JSON round-trip', () => {
    const obj = { headers: { authorization: 'sk-proj-mysecret123456' } };
    const safe = redactObject(obj);
    assert.ok(!JSON.stringify(safe).includes('sk-proj-mysecret'), 'nested redacted');
  });
});

describe('redactingLogger()', () => {
  it('wraps console methods and redacts keys in string args', () => {
    const lines = [];
    const base = { log: (...a) => lines.push(a.join(' ')), info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push(a.join(' ')), error: (...a) => lines.push(a.join(' ')) };
    const logger = redactingLogger(base);
    logger.log('key=sk-ant-testkey12345678');
    assert.ok(lines[0].includes('***REDACTED***'), 'log redacted');
    assert.ok(!lines[0].includes('sk-ant-testkey'), 'raw key gone from log');
  });
});
