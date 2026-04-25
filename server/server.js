/**
 * cv-builder-multi-provider backend (v2)
 * Node 20 + Hono + @hono/node-server
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { stream } from 'hono/streaming';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { parse, detectGaps, scanPrivacy, render, ParserError } from '../lib/parser-bridge.js';
import { loadAdapter, probeProviders, KNOWN_PROVIDERS } from './providers/index.js';
import { redactingLogger } from './redact.js';
import { ERROR_CODES, makeErrorEvent } from './error-taxonomy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const logger = redactingLogger();

const MAX_PASTE_BYTES = parseInt(process.env.CVB_MAX_PASTE_BYTES ?? '', 10) || 524_288; // 500KB
const MAX_ZIP_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_HISTORY = 40;
const MAX_TOKENS = 2048;

// Load system prompt at boot
const SYSTEM_PROMPT = fs.readFileSync(path.join(ROOT, 'system-prompt.md'), 'utf8');

// Probe python3 version at boot
const execFileAsync = promisify(execFile);
let pythonVersion = null;
try {
  const { stdout } = await execFileAsync('python3', ['--version']);
  pythonVersion = stdout.trim() || 'ok';
} catch {
  pythonVersion = null;
}

// ─── App ────────────────────────────────────────────────────────────────────

const app = new Hono();

// CSP + security headers on all responses
app.use('*', async (c, next) => {
  await next();
  c.header('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self' blob:;");
});

// ─── Health ─────────────────────────────────────────────────────────────────

app.get('/api/health', async c => {
  const providers = await probeProviders();
  return c.json({ ok: true, python: pythonVersion, providers });
});

// ─── Parse ──────────────────────────────────────────────────────────────────

app.post('/api/parse', async c => {
  const contentType = c.req.header('content-type') ?? '';
  const isZip = contentType.includes('application/zip') || contentType.includes('application/octet-stream');

  const rawBuf = await c.req.arrayBuffer();
  const byteLen = rawBuf.byteLength;
  const limit = isZip ? MAX_ZIP_BYTES : MAX_PASTE_BYTES;

  if (byteLen > limit) {
    return c.json(
      { code: 'TOO_LARGE', message_zh: `輸入過大（>${Math.round(limit / 1024)}KB），請只貼履歷主要段落` },
      413
    );
  }

  let kind, body;
  if (isZip) {
    kind = 'linkedin-zip';
    body = Buffer.from(rawBuf);
  } else {
    let payload;
    try {
      payload = JSON.parse(Buffer.from(rawBuf).toString('utf8'));
    } catch {
      return c.json({ code: 'BAD_REQUEST', message_zh: '請求格式錯誤' }, 400);
    }
    kind = payload.kind;
    body = payload.input ?? payload.body ?? '';
    if (!kind) return c.json({ code: 'BAD_REQUEST', message_zh: '缺少 kind 欄位' }, 400);
  }

  try {
    const data = await parse(kind, body);
    return c.json({ ok: true, data });
  } catch (err) {
    if (err instanceof ParserError) {
      if (err.code === 'ZIP_NOT_LINKEDIN') {
        return c.json({
          code: err.code,
          message_zh: '這個 ZIP 找不到 Profile.csv，請確認是 LinkedIn Download-your-data 匯出',
        }, 422);
      }
      if (err.code === 'INSUFFICIENT_DATA') {
        return c.json({
          code: err.code,
          message_zh: '解析到的欄位太少，請補貼更多內容或改貼 LinkedIn ZIP',
          data: err.data,
        }, 422);
      }
      if (err.code === 'PARSER_TIMEOUT') {
        return c.json({ code: err.code, message_zh: '解析超時，請重試或縮短輸入' }, 422);
      }
      return c.json({ code: err.code, message_zh: err.detail }, 422);
    }
    logger.error('[parse]', err);
    return c.json({ code: 'SERVER_ERROR', message_zh: '伺服器錯誤' }, 500);
  }
});

// ─── Gaps ────────────────────────────────────────────────────────────────────

app.post('/api/gaps', async c => {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ code: 'BAD_REQUEST', message_zh: '請求格式錯誤' }, 400);
  }

  const { data: resumeJson } = payload;
  if (!resumeJson) return c.json({ code: 'BAD_REQUEST', message_zh: '缺少 data 欄位' }, 400);

  try {
    const result = await detectGaps(resumeJson);
    return c.json(result);
  } catch (err) {
    logger.error('[gaps]', err);
    return c.json({ questions: [], deferred: [], total_detected: 0 });
  }
});

// ─── Render ─────────────────────────────────────────────────────────────────

app.post('/api/render', async c => {
  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ code: 'BAD_REQUEST', message_zh: '請求格式錯誤' }, 400);
  }

  const { data: resumeJson, answers, template = 'modern-minimal', privacy_decision } = payload;
  if (!resumeJson) return c.json({ code: 'BAD_REQUEST', message_zh: '缺少 data 欄位' }, 400);

  let jsonToRender = resumeJson;
  try {
    const privacyResult = await scanPrivacy(resumeJson);
    const hits = privacyResult?.hits ?? [];

    if (hits.length > 0 && !privacy_decision) {
      return c.json({ code: 'PRIVACY_GATE', hits }, 409);
    }
    if (hits.length > 0 && privacy_decision === 'redact') {
      jsonToRender = applyRedactions(resumeJson, hits);
    }
    if (hits.length > 0 && privacy_decision === 'keep') {
      logger.log('[privacy:keep] paths:', hits.map(h => h.path).join(', '));
    }
  } catch (err) {
    logger.error('[privacy scan]', err);
  }

  const outdir = path.join(ROOT, 'tmp-renders');
  fs.mkdirSync(outdir, { recursive: true });

  try {
    const result = await render(jsonToRender, answers ?? null, template, outdir);
    const html = fs.readFileSync(result.path, 'utf8');
    try { fs.unlinkSync(result.path); } catch {}
    const filename = path.basename(result.path);
    return c.json({ ok: true, html, filename, size: result.size, slug: result.slug });
  } catch (err) {
    if (err instanceof ParserError) {
      return c.json({ code: err.code, message_zh: err.detail }, 422);
    }
    logger.error('[render]', err);
    return c.json({ code: 'SERVER_ERROR', message_zh: '渲染失敗' }, 500);
  }
});

function applyRedactions(data, hits) {
  const clone = JSON.parse(JSON.stringify(data));
  for (const hit of hits) setNestedNull(clone, hit.path);
  return clone;
}

function setNestedNull(obj, dotPath) {
  if (!dotPath) return;
  const parts = dotPath.replace(/\[(\d+)\]/g, '.$1').split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur == null || typeof cur !== 'object') return;
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (cur && typeof cur === 'object') cur[last] = null;
}

// ─── Chat (SSE streaming, multi-provider) ───────────────────────────────────

app.post('/api/chat', async c => {
  const apiKey = c.req.header('x-provider-key');
  if (!apiKey) {
    return c.json(makeErrorEvent(ERROR_CODES.INVALID_KEY, '請先輸入您的 API key'), 400);
  }

  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ code: 'BAD_REQUEST', message_zh: '請求格式錯誤' }, 400);
  }

  const { provider, messages: rawMessages = [] } = payload;

  if (!provider || !KNOWN_PROVIDERS.includes(provider)) {
    return c.json(
      makeErrorEvent(ERROR_CODES.UPSTREAM_ERROR, `不支援的 provider: ${provider}。請選擇 anthropic / openai / gemini / github`),
      400
    );
  }

  let messages = rawMessages;
  if (messages.length > MAX_HISTORY) {
    messages = messages.slice(messages.length - MAX_HISTORY);
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return c.json({ code: 'BAD_REQUEST', message_zh: '缺少 messages' }, 400);
  }

  const adapter = await loadAdapter(provider);

  return stream(c, async s => {
    const abortCtrl = new AbortController();
    c.req.raw.signal?.addEventListener('abort', () => abortCtrl.abort(), { once: true });

    const readable = adapter.streamChat({
      apiKey,
      systemPrompt: SYSTEM_PROMPT,
      messages,
      model: undefined,
      maxTokens: MAX_TOKENS,
      abortSignal: abortCtrl.signal,
    });

    const reader = readable.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.type === 'text_delta') {
          await s.write(`data: ${JSON.stringify({ chunk: value.delta })}\n\n`);
        } else if (value?.type === 'error') {
          logger.error(`[chat:${provider}] error:`, value.code, value.message_zh);
          await s.write(`event: error\ndata: ${JSON.stringify({ code: value.code, message_zh: value.message_zh })}\n\n`);
        }
      }
      await s.write('data: [DONE]\n\n');
    } catch (err) {
      logger.error(`[chat:${provider}] stream error:`, err);
      try {
        await s.write(`event: error\ndata: ${JSON.stringify(makeErrorEvent(ERROR_CODES.UPSTREAM_ERROR, '串流發生錯誤，請稍後再試。'))}\n\n`);
      } catch { /* stream closed */ }
    } finally {
      try { reader.cancel(); } catch {}
    }
  });
});

// ─── Static ──────────────────────────────────────────────────────────────────

app.use('/*', serveStatic({ root: path.join(ROOT, 'web') }));

// ─── Boot ────────────────────────────────────────────────────────────────────

const BASE_PORT = parseInt(process.env.PORT ?? '', 10) || 5173;
const MAX_PORT = BASE_PORT === 5173 ? 5179 : BASE_PORT;

async function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port }, () => resolve({ server, port }));
    server.on('error', err => {
      if (err.code === 'EADDRINUSE') reject(err);
      else reject(err);
    });
  });
}

let boundPort = null;
let server = null;

for (let p = BASE_PORT; p <= MAX_PORT; p++) {
  try {
    const result = await tryListen(p);
    server = result.server;
    boundPort = result.port;
    break;
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || p === MAX_PORT) {
      if (p === MAX_PORT) {
        process.stderr.write(`cv-builder: all ports ${BASE_PORT}-${MAX_PORT} in use. Set PORT env var or free a port.\n`);
        process.exit(2);
      }
      throw err;
    }
  }
}

const url = `http://127.0.0.1:${boundPort}`;
logger.log(`cv-builder listening on ${url}`);
if (!pythonVersion) {
  logger.warn('WARNING: python3 not found — parse/render features will fail. Install Python 3.10+.');
}

try {
  const { default: open } = await import('open');
  await open(url);
} catch {
  // Non-fatal
}
