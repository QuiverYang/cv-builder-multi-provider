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
const MAX_REMOTE_HTML_BYTES = 1024 * 1024; // 1MB
const REMOTE_FETCH_TIMEOUT_MS = 10_000;
const MAX_REMOTE_REDIRECTS = 3;
const MAX_HISTORY = 40;
const MAX_TOKENS = 2048;
const AI_PARSE_MAX_TOKENS = 16384;
const AI_POLISH_MAX_TOKENS = 16384;

const VERTEX_PROJECT = process.env.VERTEX_PROJECT ?? null;
const VERTEX_LOCATION = process.env.VERTEX_LOCATION ?? 'us-central1';

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
  return c.json({ ok: true, python: pythonVersion, providers, vertexGemini: Boolean(VERTEX_PROJECT) });
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

  logger.log('[parse] start:', kind);

  try {
    if (kind === '104-url' || kind === 'linkedin-url') {
      body = await fetchProfileHtml(kind, body);
    }
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
      if (err.code === 'FETCH_FAILED') {
        return c.json({ code: err.code, message_zh: err.detail }, 422);
      }
      return c.json({ code: err.code, message_zh: err.detail }, 422);
    }
    logger.error('[parse]', err);
    return c.json({ code: 'SERVER_ERROR', message_zh: '伺服器錯誤' }, 500);
  }
});

async function fetchProfileHtml(kind, input) {
  let url;
  try {
    url = new URL(String(input).trim());
  } catch {
    throw new ParserError('FETCH_FAILED', '網址格式錯誤，請貼完整的 http(s) 連結。');
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ParserError('FETCH_FAILED', '只支援 http(s) 履歷網址。');
  }

  if (!isAllowedProfileUrl(kind, url)) {
    throw new ParserError('FETCH_FAILED', '網址網域與選擇的履歷來源不符。');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetchAllowedProfileUrl(kind, url, controller.signal);
    if (!res.ok) {
      throw new ParserError('FETCH_FAILED', `抓取履歷網址失敗（HTTP ${res.status}）。`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html')) {
      throw new ParserError('FETCH_FAILED', '履歷網址沒有回傳 HTML，請改貼頁面原始碼或純文字。');
    }

    const contentLength = Number(res.headers.get('content-length') ?? 0);
    if (contentLength > MAX_REMOTE_HTML_BYTES) {
      throw new ParserError('FETCH_FAILED', '履歷頁面過大，請改貼主要履歷內容。');
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > MAX_REMOTE_HTML_BYTES) {
      throw new ParserError('FETCH_FAILED', '履歷頁面過大，請改貼主要履歷內容。');
    }
    return buf.toString('utf8');
  } catch (err) {
    if (err instanceof ParserError) throw err;
    const message = err?.name === 'AbortError' ? '抓取履歷網址逾時，請改貼頁面原始碼或純文字。' : '抓取履歷網址失敗，請改貼頁面原始碼或純文字。';
    throw new ParserError('FETCH_FAILED', message);
  } finally {
    clearTimeout(timer);
  }
}

function isAllowedProfileUrl(kind, url) {
  if (!['http:', 'https:'].includes(url.protocol)) return false;
  const hostname = url.hostname.toLowerCase();
  const is104 = hostname === '104.com.tw' || hostname.endsWith('.104.com.tw');
  const isLinkedIn = hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
  return (kind === '104-url' && is104) || (kind === 'linkedin-url' && isLinkedIn);
}

async function fetchAllowedProfileUrl(kind, initialUrl, signal) {
  let current = initialUrl;
  for (let i = 0; i <= MAX_REMOTE_REDIRECTS; i++) {
    if (!isAllowedProfileUrl(kind, current)) {
      throw new ParserError('FETCH_FAILED', '履歷網址重新導向到不支援的網域。');
    }

    const res = await fetch(current, {
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CVBuilder/2.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (![301, 302, 303, 307, 308].includes(res.status)) return res;

    const location = res.headers.get('location');
    if (!location) {
      throw new ParserError('FETCH_FAILED', '履歷網址重新導向但缺少 Location。');
    }
    current = new URL(location, current);
  }
  throw new ParserError('FETCH_FAILED', '履歷網址重新導向次數過多。');
}

// ─── AI Parse fallback ───────────────────────────────────────────────────────

app.post('/api/ai-parse', async c => {
  const apiKey = c.req.header('x-provider-key') ?? '';

  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ code: 'BAD_REQUEST', message_zh: '請求格式錯誤' }, 400);
  }

  const { provider, kind, input, local_error } = payload;
  logger.log('[ai-parse] start:', provider, kind, local_error?.code ?? 'no-local-error');

  if (!provider || !KNOWN_PROVIDERS.includes(provider)) {
    return c.json(
      makeErrorEvent(ERROR_CODES.UPSTREAM_ERROR, `不支援的 provider: ${provider}。請選擇 anthropic / openai / gemini / github`),
      400
    );
  }

  const isVertexGemini = provider === 'gemini' && Boolean(VERTEX_PROJECT);
  if (!apiKey && !isVertexGemini) {
    return c.json(makeErrorEvent(ERROR_CODES.INVALID_KEY, '請先輸入您的 API key'), 400);
  }

  let source = String(input ?? '');
  if (!source.trim()) {
    return c.json({ code: 'BAD_REQUEST', message_zh: '缺少履歷內容' }, 400);
  }

  if (source.length > MAX_PASTE_BYTES) {
    return c.json({ code: 'TOO_LARGE', message_zh: `輸入過大（>${Math.round(MAX_PASTE_BYTES / 1024)}KB），請只貼履歷主要段落` }, 413);
  }

  if (kind === '104-url' || kind === 'linkedin-url') {
    try {
      const html = await fetchProfileHtml(kind, source);
      source = `${source}\n\n--- fetched html ---\n${html}`;
    } catch (err) {
      logger.warn('[ai-parse] url fetch fallback failed:', err?.message ?? err);
    }
  }

  const adapter = await loadAdapter(provider);
  const abortCtrl = new AbortController();
  c.req.raw.signal?.addEventListener('abort', () => abortCtrl.abort(), { once: true });

  try {
    const text = await collectTextFromAdapter(adapter.streamChat({
      apiKey: isVertexGemini ? undefined : apiKey,
      project: isVertexGemini ? VERTEX_PROJECT : undefined,
      location: isVertexGemini ? VERTEX_LOCATION : undefined,
      systemPrompt: AI_PARSE_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: buildAiParsePrompt({ kind, source, localError: local_error }),
      }],
      model: undefined,
      maxTokens: AI_PARSE_MAX_TOKENS,
      responseMimeType: provider === 'gemini' ? 'application/json' : undefined,
      abortSignal: abortCtrl.signal,
    }));

    const data = normalizeAiResumeJson(extractJsonObject(text));
    if (resumeFieldCount(data) < 3) {
      return c.json({
        code: 'INSUFFICIENT_DATA',
        message_zh: 'AI 也無法從這份輸入解析出足夠履歷欄位，請貼更多可見履歷內容。',
        data,
      }, 422);
    }

    return c.json({ ok: true, data });
  } catch (err) {
    logger.error('[ai-parse]', err);
    if (err instanceof ParserError) {
      return c.json({ code: err.code, message_zh: err.detail }, 422);
    }
    return c.json({ code: 'AI_PARSE_FAILED', message_zh: 'AI 解析失敗，請改貼履歷純文字或 HTML。' }, 422);
  }
});

const AI_PARSE_SYSTEM_PROMPT = `你是履歷資料解析器。只根據使用者提供的內容抽取資料，不要捏造。
你必須只輸出一個 JSON object，不要 markdown，不要 code fence，不要解釋，不要前後加任何文字。
即使資料不足，也要輸出符合 schema 的 JSON，缺少的欄位填 null 或空陣列，並把缺少原因放在 _missing。
控制輸出長度：summary 最多 160 字；experiences 最多 15 段，優先保留所有可辨識工作經驗；每段 bullets 最多 5 點、每點最多 90 字；education 最多 8 筆；skills 最多 35 項。
JSON schema:
{
  "name": string|null,
  "headline": string|null,
  "summary": string|null,
  "contact": {"email": string|null, "phone": string|null, "location": string|null, "links": string[]},
  "experiences": [{"company": string|null, "title": string|null, "start": string|null, "end": string|null, "bullets": string[], "location": string|null}],
  "education": [{"school": string|null, "degree": string|null, "field": string|null, "start": string|null, "end": string|null}],
  "skills": string[],
  "languages": [{"name": string|null, "level": string|null}],
  "certifications": [{"name": string|null, "issuer": string|null, "date": string|null}],
  "_source": string,
  "_missing": string[]
}
contact.links 只收個人 GitHub、GitLab、LinkedIn、Medium、個人網站；不要輸出 App Store、YouTube、104 附件、追蹤碼、影片播放器或頁面資源 URL。
日期格式盡量用 YYYY 或 YYYY-MM；目前工作 end 用 "present"。找不到的欄位用 null 或空陣列。`;

function buildAiParsePrompt({ kind, source, localError }) {
  return `請把以下輸入解析成 canonical resume JSON。只回傳 JSON object，第一個字元必須是 {，最後一個字元必須是 }。
不要逐字收錄頁面上的所有連結；contact.links 最多 5 個，且只保留可作為履歷抬頭的個人公開連結。不要為了精簡而刪除可辨識的工作經驗；若內容很多，先縮短 bullets，而不是移除 experience。
kind: ${kind ?? 'unknown'}
local_parser_error: ${JSON.stringify(localError ?? null)}

輸入內容:
${source}`;
}

async function collectTextFromAdapter(readable) {
  const reader = readable.getReader();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.type === 'text_delta') {
        text += value.delta;
      } else if (value?.type === 'error') {
        throw new ParserError(value.code ?? 'AI_PARSE_FAILED', value.message_zh ?? 'AI 解析失敗');
      }
    }
    return text;
  } finally {
    try { reader.cancel(); } catch {}
  }
}

function extractJsonObject(text) {
  const trimmed = String(text ?? '').trim();
  logger.log('[ai-parse] raw response preview:', trimmed.slice(0, 500));
  logger.log('[ai-parse] raw response tail:', trimmed.slice(-500));
  logger.log('[ai-parse] raw response length:', trimmed.length);
  if (!trimmed) throw new ParserError('AI_PARSE_FAILED', 'AI 沒有回傳解析結果。');

  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {}

  const fenced = unfenced.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(unfenced.slice(start, end + 1)); } catch {}
  }

  if (/無法|不能|抱歉|sorry|cannot|can't/i.test(unfenced)) {
    return {
      name: null,
      headline: null,
      summary: null,
      contact: { email: null, phone: null, location: null, links: [] },
      experiences: [],
      education: [],
      skills: [],
      languages: [],
      certifications: [],
      _source: 'ai-parse',
      _missing: [unfenced.slice(0, 300)],
    };
  }

  throw new ParserError('AI_PARSE_FAILED', 'AI 回傳格式不是有效 JSON。');
}

function normalizeAiResumeJson(data) {
  return {
    name: data?.name ?? null,
    headline: data?.headline ?? null,
    summary: data?.summary ?? null,
    contact: {
      email: data?.contact?.email ?? null,
      phone: data?.contact?.phone ?? null,
      location: data?.contact?.location ?? null,
      links: normalizeContactLinks(data?.contact?.links),
    },
    experiences: Array.isArray(data?.experiences) ? data.experiences.map(exp => ({
      company: exp?.company ?? null,
      title: exp?.title ?? null,
      start: exp?.start ?? null,
      end: exp?.end ?? null,
      bullets: Array.isArray(exp?.bullets) ? exp.bullets.filter(Boolean) : [],
      location: exp?.location ?? null,
    })) : [],
    education: Array.isArray(data?.education) ? data.education.map(edu => ({
      school: edu?.school ?? null,
      degree: edu?.degree ?? null,
      field: edu?.field ?? null,
      start: edu?.start ?? null,
      end: edu?.end ?? null,
    })) : [],
    skills: Array.isArray(data?.skills) ? data.skills.filter(Boolean) : [],
    languages: Array.isArray(data?.languages) ? data.languages.map(lang => ({
      name: lang?.name ?? null,
      level: lang?.level ?? null,
    })) : [],
    certifications: Array.isArray(data?.certifications) ? data.certifications.map(cert => ({
      name: cert?.name ?? null,
      issuer: cert?.issuer ?? null,
      date: cert?.date ?? null,
    })) : [],
    _source: data?._source ?? 'ai-parse',
    _missing: Array.isArray(data?._missing) ? data._missing : [],
  };
}

function resumeFieldCount(data) {
  let n = 0;
  for (const key of ['name', 'headline', 'summary']) {
    if (data?.[key]) n++;
  }
  if (data?.contact?.email || data?.contact?.phone) n++;
  if (data?.experiences?.length) n++;
  if (data?.education?.length) n++;
  if (data?.skills?.length) n++;
  return n;
}

function normalizeContactLinks(links) {
  if (!Array.isArray(links)) return [];

  const allowedHosts = new Set([
    'github.com',
    'gitlab.com',
    'linkedin.com',
    'www.linkedin.com',
    'medium.com',
    'newway-explore.com',
    'www.newway-explore.com',
  ]);

  const blockedHosts = new Set([
    'apps.apple.com',
    'www.youtube.com',
    'youtube.com',
    'youtu.be',
    'pda.104.com.tw',
    '104.com.tw',
    'www.googletagmanager.com',
    'connect.facebook.net',
    'player.vimeo.com',
  ]);

  const out = [];
  const seen = new Set();
  for (const raw of links) {
    try {
      const url = new URL(String(raw).trim());
      const host = url.hostname.toLowerCase();
      const isAllowed = allowedHosts.has(host) || host.endsWith('.github.io');
      const isBlocked = blockedHosts.has(host) || host.endsWith('.104.com.tw');
      if (!isAllowed || isBlocked) continue;
      const normalized = url.toString();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        out.push(normalized);
      }
    } catch {}
  }
  return out.slice(0, 5);
}

// ─── AI Polish ───────────────────────────────────────────────────────────────

app.post('/api/polish', async c => {
  const apiKey = c.req.header('x-provider-key') ?? '';

  let payload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ code: 'BAD_REQUEST', message_zh: '請求格式錯誤' }, 400);
  }

  const { provider, data, answers = null } = payload;
  logger.log('[polish] start:', provider, answers ? Object.keys(answers).length : 0);

  if (!provider || !KNOWN_PROVIDERS.includes(provider)) {
    return c.json(
      makeErrorEvent(ERROR_CODES.UPSTREAM_ERROR, `不支援的 provider: ${provider}。請選擇 anthropic / openai / gemini / github`),
      400
    );
  }

  const isVertexGemini = provider === 'gemini' && Boolean(VERTEX_PROJECT);
  if (!apiKey && !isVertexGemini) {
    return c.json(makeErrorEvent(ERROR_CODES.INVALID_KEY, '請先輸入您的 API key'), 400);
  }

  if (!data) {
    return c.json({ code: 'BAD_REQUEST', message_zh: '缺少履歷資料' }, 400);
  }

  const adapter = await loadAdapter(provider);
  const abortCtrl = new AbortController();
  c.req.raw.signal?.addEventListener('abort', () => abortCtrl.abort(), { once: true });

  try {
    const text = await collectTextFromAdapter(adapter.streamChat({
      apiKey: isVertexGemini ? undefined : apiKey,
      project: isVertexGemini ? VERTEX_PROJECT : undefined,
      location: isVertexGemini ? VERTEX_LOCATION : undefined,
      systemPrompt: AI_POLISH_SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: buildAiPolishPrompt({ data, answers }),
      }],
      model: undefined,
      maxTokens: AI_POLISH_MAX_TOKENS,
      responseMimeType: provider === 'gemini' ? 'application/json' : undefined,
      abortSignal: abortCtrl.signal,
    }));

    const polished = normalizeAiResumeJson(extractJsonObject(text));
    if (resumeFieldCount(polished) < 3) {
      return c.json({ code: 'INSUFFICIENT_DATA', message_zh: 'AI 潤稿後資料不足，請補更多履歷內容。' }, 422);
    }

    return c.json({ ok: true, data: polished });
  } catch (err) {
    logger.error('[polish]', err);
    if (err instanceof ParserError) {
      return c.json({ code: err.code, message_zh: err.detail }, 422);
    }
    return c.json({ code: 'AI_POLISH_FAILED', message_zh: 'AI 潤稿失敗，將使用原始解析結果。' }, 422);
  }
});

const AI_POLISH_SYSTEM_PROMPT = `你是繁體中文履歷顧問。你會收到 canonical resume JSON 與使用者針對缺口問題的補答。
你的任務是把資料整合成更正式、更精煉、更成果導向的履歷 JSON。
硬性規則：
- 只輸出 JSON object，不要 markdown，不要 code fence，不要解釋。
- 保留事實，不新增使用者未提供的公司、數字、學歷、職稱或成果。
- 必須保留輸入中的所有 experiences，不得合併、刪除或重排到無法對應原職涯順序；只能潤飾既有欄位與 bullet 文案。
- 使用者補答要先比對 target_path，再整合進對應 summary / skills / experience bullets；不要逐字附加。
- summary 改成 3-5 句專業摘要，繁中正式語氣，最多 180 字。
- 每段經歷 bullets 改成成果導向、動詞開頭、具體但不誇大；每段最多 5 點，每點最多 90 字。
- 技術詞、產品名、產業經驗整理進 skills；skills 最多 35 項。
- 不確定或缺少的內容放進 _missing，不要亂補。
- contact.links 只保留個人作品集、GitHub、LinkedIn、Medium 等專業連結。
輸出 schema 必須與輸入相同。`;

function buildAiPolishPrompt({ data, answers }) {
  return `請根據履歷 JSON 與使用者補答，輸出潤飾後的 canonical resume JSON。

履歷 JSON:
${JSON.stringify(data)}

使用者補答:
${JSON.stringify(answers ?? {})}`;
}

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
  const apiKey = c.req.header('x-provider-key') ?? '';

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

  const isVertexGemini = provider === 'gemini' && Boolean(VERTEX_PROJECT);
  if (!apiKey && !isVertexGemini) {
    return c.json(makeErrorEvent(ERROR_CODES.INVALID_KEY, '請先輸入您的 API key'), 400);
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
      apiKey: isVertexGemini ? undefined : apiKey,
      project: isVertexGemini ? VERTEX_PROJECT : undefined,
      location: isVertexGemini ? VERTEX_LOCATION : undefined,
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
