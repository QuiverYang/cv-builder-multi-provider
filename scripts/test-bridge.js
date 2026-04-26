/**
 * Unit tests for lib/parser-bridge.js and lib/anthropic-errors.js
 * Run: node scripts/test-bridge.js
 */

import { parse, detectGaps, scanPrivacy, ParserError } from '../lib/parser-bridge.js';
import { mapError, ERROR_CODES } from '../lib/anthropic-errors.js';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

async function test(name, fn) {
  console.log(`\n[${name}]`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ✗ THREW: ${err.message}`);
    failed++;
  }
}

/* ── Parser Bridge Tests ─────────────────────────────────────────────────── */

await test('parse plaintext fixture', async () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'plaintext.txt'), 'utf8');
  const data = await parse('text-paste', text);
  assert(typeof data === 'object', 'returns object');
  assert(data.name != null, `has name: ${data.name}`);
  assert('experiences' in data, 'has experiences key');
  assert('education' in data, 'has education key');
  assert('skills' in data, 'has skills key');
  assert(data._source === 'text-paste', `_source is text-paste, got: ${data._source}`);
});

await test('parse html fixture (linkedin.html)', async () => {
  const html = fs.readFileSync(path.join(FIXTURES, 'linkedin.html'), 'utf8');
  const data = await parse('html-paste', html);
  assert(typeof data === 'object', 'returns object');
  assert('_source' in data, 'has _source');
});

await test('parse 104 html fixture', async () => {
  const html = fs.readFileSync(path.join(FIXTURES, '104.html'), 'utf8');
  const data = await parse('html-paste', html);
  assert(typeof data === 'object', 'returns object');
});

await test('parse linkedin-export.zip', async () => {
  const zipBuf = fs.readFileSync(path.join(FIXTURES, 'linkedin-export.zip'));
  const data = await parse('linkedin-zip', zipBuf);
  assert(typeof data === 'object', 'returns object');
  assert(data._source === 'linkedin-zip', `_source is linkedin-zip, got: ${data._source}`);
});

await test('truly sparse input returns INSUFFICIENT_DATA', async () => {
  // Only 1 field (name) — field_count will be < 3
  const text = 'John Doe\n\nsome random text without sections';
  let threw = false;
  let code = null;
  try {
    await parse('text-paste', text);
  } catch (err) {
    threw = true;
    code = err.code;
  }
  assert(threw, 'throws for truly sparse input');
  assert(code === 'INSUFFICIENT_DATA', `code is INSUFFICIENT_DATA, got: ${code}`);
});

await test('non-linkedin ZIP returns ZIP_NOT_LINKEDIN', async () => {
  // Create a fake ZIP with no Profile.csv
  const { execSync } = await import('child_process');
  const tmpDir = fs.mkdtempSync('/tmp/cvb-test-zip-');
  fs.writeFileSync(path.join(tmpDir, 'something.txt'), 'hello');
  execSync(`cd ${tmpDir} && zip -q test.zip something.txt`);
  const zipBuf = fs.readFileSync(path.join(tmpDir, 'test.zip'));
  fs.rmSync(tmpDir, { recursive: true });

  let code = null;
  try {
    await parse('linkedin-zip', zipBuf);
  } catch (err) {
    code = err.code;
  }
  assert(code === 'ZIP_NOT_LINKEDIN', `code is ZIP_NOT_LINKEDIN, got: ${code}`);
});

await test('detectGaps returns structured output', async () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'plaintext.txt'), 'utf8');
  const data = await parse('text-paste', text);
  const gaps = await detectGaps(data);
  assert('questions' in gaps, 'has questions');
  assert('deferred' in gaps, 'has deferred');
  assert('total_detected' in gaps, 'has total_detected');
});

await test('scanPrivacy returns hits array', async () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'plaintext.txt'), 'utf8');
  const data = await parse('text-paste', text);
  const result = await scanPrivacy(data);
  assert('hits' in result, 'has hits array');
  assert(Array.isArray(result.hits), 'hits is array');
});

/* ── Anthropic Error Mapper Tests ────────────────────────────────────────── */

await test('mapError: 401 → BYOK_INVALID', () => {
  const err = mapError({ status: 401 });
  assert(err.code === ERROR_CODES.BYOK_INVALID, `code is BYOK_INVALID, got: ${err.code}`);
  assert(typeof err.message_zh === 'string', 'has message_zh');
});

await test('mapError: 429 → BYOK_RATE_LIMITED with retry-after', () => {
  const err = mapError({ status: 429, headers: { 'retry-after': '30' } });
  assert(err.code === ERROR_CODES.BYOK_RATE_LIMITED, `code is BYOK_RATE_LIMITED, got: ${err.code}`);
  assert(err.retry_after_s === 30, `retry_after_s is 30, got: ${err.retry_after_s}`);
});

await test('mapError: 529 → BYOK_OVERLOADED', () => {
  const err = mapError({ status: 529 });
  assert(err.code === ERROR_CODES.BYOK_OVERLOADED, `code is BYOK_OVERLOADED, got: ${err.code}`);
});

await test('mapError: AbortError → STREAM_ABORTED', () => {
  const err = mapError({ name: 'AbortError', message: 'aborted' });
  assert(err.code === ERROR_CODES.STREAM_ABORTED, `code is STREAM_ABORTED, got: ${err.code}`);
});

await test('mapError: redacts sk-ant key from message', () => {
  const err = mapError({ message: `failed with ${'sk-ant-' + 'api03-secret123'} in body` });
  assert(!err.message_zh.includes('sk-ant-'), 'message_zh does not contain sk-ant-');
  assert(err.message_zh.includes('[REDACTED]'), 'message_zh contains [REDACTED]');
});

/* ── Summary ─────────────────────────────────────────────────────────────── */

console.log(`\n${'─'.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed ✓');
}
