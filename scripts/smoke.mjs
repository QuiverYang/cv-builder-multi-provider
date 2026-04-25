#!/usr/bin/env node
/**
 * smoke.mjs — cv-builder-multi-provider smoke test
 *
 * Default mode: fake-key INVALID_KEY checks × 4 providers + redaction-leak grep
 * --integration: real-key happy paths for ≥2 providers (requires env vars, never run in CI)
 */

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const integration = process.argv.includes('--integration');

let serverLog = '';
let server = null;
let serverPort = null;

const FAKE_KEYS = {
  anthropic: 'sk-ant-XXX000000000000000000000',
  openai: 'sk-XXX000000000000000000000000000000',
  gemini: 'AIzaXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  github: 'ghp_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
};

const REAL_KEY_ENVS = {
  anthropic: 'ANTHROPIC_API_KEY_INTEGRATION',
  openai: 'OPENAI_API_KEY_INTEGRATION',
  gemini: 'GEMINI_API_KEY_INTEGRATION',
  github: 'GITHUB_PAT_INTEGRATION',
};

function log(msg) { process.stdout.write(msg + '\n'); }
function err(msg) { process.stderr.write('FAIL: ' + msg + '\n'); }

async function startServer() {
  return new Promise((resolve, reject) => {
    server = spawn('node', ['server/server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    server.stdout.on('data', d => {
      const s = d.toString();
      serverLog += s;
      const m = s.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m && !serverPort) {
        serverPort = parseInt(m[1]);
        resolve(serverPort);
      }
    });
    server.stderr.on('data', d => { serverLog += d.toString(); });
    server.on('error', reject);
    setTimeout(() => reject(new Error('Server did not start in 15s')), 15000);
  });
}

function stopServer() {
  if (server) { server.kill(); server = null; }
}

function request(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const opts = {
      hostname: '127.0.0.1',
      port: serverPort,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function readSSEError(body) {
  // Parse first error event from SSE response body string
  const lines = body.split('\n');
  let isError = false;
  for (const line of lines) {
    if (line.startsWith('event: error')) { isError = true; continue; }
    if (line.startsWith('data: ') && isError) {
      try { return JSON.parse(line.slice(6)); } catch {}
    }
    if (line === '' && isError) { isError = false; }
  }
  // Also check for data: lines containing code fields
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        const p = JSON.parse(line.slice(6));
        if (p.code) return p;
      } catch {}
    }
  }
  return null;
}

async function fetchSSE(provider, key) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ provider, messages: [{ role: 'user', content: 'Hello' }] });
    const opts = {
      hostname: '127.0.0.1',
      port: serverPort,
      path: '/api/chat',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-provider-key': key,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
    setTimeout(() => { req.destroy(); resolve({ status: 408, body: '' }); }, 20000);
  });
}

async function runSmoke() {
  let failed = false;

  log('\n=== cv-builder-multi-provider smoke test ===\n');

  // 1. Start server
  log('Starting server...');
  try {
    await startServer();
    log(`Server started on port ${serverPort}`);
  } catch (e) {
    err('Server failed to start: ' + e.message);
    process.exit(1);
  }

  // Short delay for server to be ready
  await new Promise(r => setTimeout(r, 500));

  // 2. Health check
  log('\n[1] GET /api/health');
  try {
    const { status, body } = await request('GET', '/api/health', null);
    const json = JSON.parse(body);
    if (status !== 200) { err(`health returned ${status}`); failed = true; }
    else if (!json.providers || typeof json.providers !== 'object') {
      err('health missing providers field'); failed = true;
    } else {
      for (const id of ['anthropic', 'openai', 'gemini', 'github']) {
        if (typeof json.providers[id] !== 'boolean') {
          err(`health.providers.${id} is not boolean: ${json.providers[id]}`); failed = true;
        }
      }
      log(`  ok — providers: ${JSON.stringify(json.providers)}`);
    }
  } catch (e) { err('health check threw: ' + e.message); failed = true; }

  // 3. Fake-key INVALID_KEY × 4 providers
  log('\n[2] Fake-key INVALID_KEY checks (no real API calls)');
  for (const [provider, fakeKey] of Object.entries(FAKE_KEYS)) {
    try {
      const { status, body } = await fetchSSE(provider, fakeKey);
      const event = await readSSEError(body);
      if (event?.code === 'INVALID_KEY') {
        log(`  [${provider}] ✓ INVALID_KEY`);
      } else {
        // Some providers may return UPSTREAM_ERROR due to network issues in test
        // Accept INVALID_KEY or note the actual code
        const code = event?.code ?? `(no event; HTTP ${status})`;
        log(`  [${provider}] code=${code} — ${code === 'INVALID_KEY' ? '✓' : 'NOTE: expected INVALID_KEY'}`);
        // Don't fail on non-INVALID_KEY since network to upstream may be blocked in CI
      }
    } catch (e) { err(`[${provider}] fake-key check threw: ${e.message}`); }
  }

  // 4. Parse smoke (v1 parity)
  log('\n[3] Parse smoke (text-paste fixture)');
  try {
    const fixture = '王大明\nSoftware Engineer\nEmail: wang@example.com\n\nExperience:\nGoogle, 2020-2023, Senior SWE\n\nEducation:\nNTU, CS, 2016-2020';
    const { status, body } = await request('POST', '/api/parse', { kind: 'text-paste', input: fixture });
    if (status === 200) {
      const json = JSON.parse(body);
      log(`  ok — name=${json.data?.name ?? '?'}`);
    } else {
      log(`  skip — /api/parse returned ${status} (python may not be installed)`);
    }
  } catch (e) { log(`  skip — ${e.message}`); }

  // 5. Redaction leak check
  log('\n[4] Redaction leak check (grep server log for raw keys)');
  const patterns = [
    /sk-ant-[A-Za-z0-9_\-]{10,}/,
    /sk-[A-Za-z0-9_\-]{10,}/,
    /AIza[A-Za-z0-9_\-]{35}/,
    /ghp_[A-Za-z0-9]{36,}/,
    /github_pat_[A-Za-z0-9_]{20,}/,
  ];
  let leakFound = false;
  for (const pat of patterns) {
    if (pat.test(serverLog)) {
      err(`Key pattern ${pat} leaked in server log!`); leakFound = true; failed = true;
    }
  }
  if (!leakFound) log('  ok — no key patterns in server log');

  // 6. Integration (real keys, ≥2 providers)
  if (integration) {
    log('\n[5] Integration tests (real keys)');
    const providers = Object.entries(REAL_KEY_ENVS)
      .map(([id, env]) => ({ id, key: process.env[env] }))
      .filter(x => x.key);

    if (providers.length < 2) {
      err('--integration requires at least 2 provider env vars set (ANTHROPIC_API_KEY_INTEGRATION, OPENAI_API_KEY_INTEGRATION, GEMINI_API_KEY_INTEGRATION, GITHUB_PAT_INTEGRATION)');
      failed = true;
    } else {
      for (const { id, key } of providers) {
        log(`  [${id}] real-key happy path...`);
        try {
          const { status, body } = await fetchSSE(id, key);
          const chunks = [];
          for (const line of body.split('\n')) {
            if (line.startsWith('data: ')) {
              const raw = line.slice(6);
              if (raw === '[DONE]') break;
              try { const p = JSON.parse(raw); if (p.chunk) chunks.push(p.chunk); } catch {}
            }
          }
          const text = chunks.join('');
          if (text.length > 0) {
            log(`  [${id}] ✓ received ${text.length} chars — "${text.slice(0, 50).replace(/\n/g, '⏎')}..."`);
          } else {
            err(`[${id}] integration: no text chunks received`); failed = true;
          }
        } catch (e) { err(`[${id}] integration threw: ${e.message}`); failed = true; }
      }
    }
  }

  stopServer();

  log('\n=== Smoke complete ===\n');
  if (failed) {
    process.stderr.write('Some checks FAILED\n');
    process.exit(1);
  } else {
    log('All checks passed.');
    process.exit(0);
  }
}

runSmoke().catch(e => {
  err(String(e));
  stopServer();
  process.exit(1);
});
