/**
 * cv-builder-multi-provider frontend (v2)
 * Vanilla JS — no build step.
 */

/* ─── Constants ─────────────────────────────────────────────────────────── */
const KEY_THEME = 'cv-builder.theme';
const KEY_PROVIDER_V2 = 'cv-builder.provider';   // v2 schema: JSON {provider, key}
const KEY_API_KEY_V1 = 'cv-builder.anthropic-key'; // v1 legacy: raw string
const KEY_STATE = 'cv-builder-state-v1';
const SESSION_ID = Math.random().toString(36).slice(2);
const PARSE_TIMEOUT_MS = 45_000;
const AI_PARSE_TIMEOUT_MS = 120_000;
const POLISH_TIMEOUT_MS = 120_000;
const SAMPLE_PREVIEW_TIMEOUT_MS = 20_000;

const SAMPLE_RESUME = {
  name: '王小明',
  headline: '產品經理 / Product Manager',
  summary: '具 8 年跨部門產品經驗，擅長需求拆解、數據分析與端到端交付。曾主導多項 B2B 與 B2C 產品改版，提升留存與轉換，並建立可持續的產品開發流程。',
  contact: {
    email: 'demo@example.com',
    phone: '+886-912-345-678',
    location: '台北市',
    links: ['https://www.linkedin.com/in/demo-profile', 'https://github.com/demo-profile'],
  },
  experiences: [
    {
      company: '星雲科技',
      title: 'Senior Product Manager',
      start: '2021-03',
      end: 'present',
      bullets: [
        '主導核心產品重構，6 個月內將月活提升 28%。',
        '建立產品儀表板與實驗流程，A/B 測試迭代速度提升 2 倍。',
        '整合設計、工程與營運節奏，將需求交付準時率提升到 95%。',
      ],
      location: '台北',
    },
    {
      company: '藍海數位',
      title: 'Product Manager',
      start: '2018-06',
      end: '2021-02',
      bullets: [
        '負責會員與付費流程優化，付費轉換率提升 17%。',
        '導入使用者訪談與旅程地圖，降低新手流失率 22%。',
      ],
      location: '新北',
    },
  ],
  education: [
    { school: '國立台灣大學', degree: 'MBA', field: '資訊管理', start: '2014', end: '2016' },
  ],
  skills: ['Product Strategy', 'Roadmapping', 'SQL', 'A/B Testing', 'Figma', 'Agile'],
  languages: [{ name: '中文', level: '母語' }, { name: 'English', level: 'Professional' }],
  certifications: [{ name: 'PMP', issuer: 'PMI', date: '2020' }],
  _source: 'sample-preview',
  _missing: [],
};

const KNOWN_PROVIDERS = ['anthropic', 'openai', 'gemini', 'github'];

const PROVIDER_META = {
  anthropic: {
    placeholder: 'sk-ant-api03-...',
    helperText: '前往 Anthropic Console 取得 API Key',
    helperLink: 'https://console.anthropic.com/settings/keys',
    helperLinkText: 'Anthropic Console ↗',
  },
  openai: {
    placeholder: 'sk-proj-...',
    helperText: '前往 OpenAI Platform 取得 API Key',
    helperLink: 'https://platform.openai.com/api-keys',
    helperLinkText: 'OpenAI Platform ↗',
  },
  gemini: {
    placeholder: 'AIzaSy... 或 AQ...',
    helperText: '前往 Google AI Studio 或 Google Cloud 取得 Gemini API Key（有免費額度）',
    helperLink: 'https://aistudio.google.com/apikey',
    helperLinkText: 'Google AI Studio ↗',
  },
  github: {
    placeholder: 'ghp_... 或 github_pat_...',
    helperText: '前往 GitHub 建立 Personal Access Token（需要 models:read 範圍）',
    helperLink: 'https://github.com/settings/tokens',
    helperLinkText: 'GitHub Token 設定 ↗',
  },
};

const ERROR_MESSAGES_ZH = {
  INVALID_KEY: '金鑰格式不符或被拒，請確認你選的 provider 與貼的金鑰一致。',
  RATE_LIMITED: '請求太頻繁或額度已用完，稍候再試或到 provider console 檢查用量。',
  OVERLOADED: '上游服務暫時繁忙，請稍後再試一次。',
  TIMEOUT: '回應逾時或已中斷，請重新送出。',
  MODEL_NOT_FOUND: '找不到指定的 model，請確認環境變數設定或改用預設 model。',
  UPSTREAM_ERROR: '上游服務發生未知錯誤，請稍後再試；若反覆出現請回報。',
};

/* ─── Storage helpers (with in-memory fallback) ──────────────────────────── */
let storageOk = true;
const memStore = {};

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return memStore[key] ?? null; }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    if (key === KEY_STATE) {
      try { localStorage.removeItem(KEY_STATE); } catch {}
      delete memStore[KEY_STATE];
      return false;
    }
    storageOk = false;
    memStore[key] = value;
    document.getElementById('storage-banner').hidden = false;
    return false;
  }
}

function storageRemove(key) {
  try { localStorage.removeItem(key); } catch { delete memStore[key]; }
}

function timeoutError(message_zh) {
  const err = new Error(message_zh);
  err.message_zh = message_zh;
  return err;
}

function repairOversizedState() {
  try {
    const raw = localStorage.getItem(KEY_STATE);
    if (!raw) return;
    if (raw.length > 250_000) {
      localStorage.removeItem(KEY_STATE);
      return;
    }
    const loaded = JSON.parse(raw);
    if (['parsing', 'rendering'].includes(loaded?.phase)) {
      localStorage.removeItem(KEY_STATE);
    }
  } catch {
    try { localStorage.removeItem(KEY_STATE); } catch {}
  }
}

/* ─── Provider credential state ─────────────────────────────────────────── */
let _sessionCredentials = null; // fallback when localStorage fails

function getCredentials() {
  if (_sessionCredentials) return _sessionCredentials;
  const raw = storageGet(KEY_PROVIDER_V2);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (KNOWN_PROVIDERS.includes(parsed?.provider) && parsed?.key) return parsed;
    return null;
  } catch { return null; }
}

function setCredentials(provider, key) {
  const v = JSON.stringify({ provider, key });
  const saved = storageSet(KEY_PROVIDER_V2, v);
  if (!saved) _sessionCredentials = { provider, key };
}

function clearCredentials() {
  storageRemove(KEY_PROVIDER_V2);
  storageRemove(KEY_API_KEY_V1);
  _sessionCredentials = null;
}

/* ─── v1 → v2 migration ──────────────────────────────────────────────────── */
function migrateV1IfNeeded() {
  const v2raw = storageGet(KEY_PROVIDER_V2);
  const v1key = storageGet(KEY_API_KEY_V1);

  // Both present: v2 wins, v1 deleted, no toast
  if (v2raw && v1key) {
    storageRemove(KEY_API_KEY_V1);
    return;
  }

  // v2 already valid: nothing to do
  if (v2raw) {
    try {
      const p = JSON.parse(v2raw);
      if (KNOWN_PROVIDERS.includes(p?.provider) && p?.key) return;
    } catch {}
    // Invalid v2: clear it, fall to onboarding
    storageRemove(KEY_PROVIDER_V2);
    return;
  }

  // Only v1 present
  if (v1key && v1key.trim()) {
    setCredentials('anthropic', v1key.trim());
    storageRemove(KEY_API_KEY_V1);
    showMigrationToast();
  } else if (v1key !== null) {
    // empty/whitespace v1 — just delete
    storageRemove(KEY_API_KEY_V1);
  }
}

function showMigrationToast() {
  const toast = document.getElementById('migration-toast');
  if (!toast) return;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 3000);
}

/* ─── State ─────────────────────────────────────────────────────────────── */
let state = {
  version: KEY_STATE,
  sessionId: SESSION_ID,
  messages: [],
  displayLog: [],
  parsedData: null,
  gapsData: null,
  answers: {},
  currentTemplate: 'modern-minimal',
  renderedHtml: null,
  renderedFilename: null,
  polished: false,
  phase: 'idle',
};

function saveState() {
  const persisted = { ...state, renderedHtml: null };
  storageSet(KEY_STATE, JSON.stringify(persisted));
}

function loadState() {
  repairOversizedState();
  const raw = storageGet(KEY_STATE);
  if (!raw) return;
  try {
    const loaded = JSON.parse(raw);
    if (loaded.version === KEY_STATE) state = loaded;
  } catch {}
}

/* ─── DOM refs ───────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

const byokModal = $('byok-modal');
const byokInput = $('byok-input');
const chatLog = $('chat-log');
const chatInput = $('chat-input');
const sendBtn = $('send-btn');
const statusText = $('status-text');
const templateGallery = $('template-gallery');
const templateList = $('template-list');
const previewFrame = $('preview-frame');
const previewPlaceholder = $('preview-placeholder');
const downloadArea = $('download-area');
const downloadBtn = $('download-btn');
const storageBanner = $('storage-banner');
const multitabBanner = $('multitab-banner');

/* ─── Theme ─────────────────────────────────────────────────────────────── */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  storageSet(KEY_THEME, t);
}

const savedTheme = storageGet(KEY_THEME);
applyTheme(savedTheme === 'terminal' ? 'terminal' : 'light');

$('theme-toggle').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'terminal' ? 'light' : 'terminal');
});

$('storage-banner-close').addEventListener('click', () => { storageBanner.hidden = true; });
$('multitab-banner-close').addEventListener('click', () => { multitabBanner.hidden = true; });

/* ─── Onboarding Modal (2-step) ──────────────────────────────────────────── */
let selectedProvider = null;
let _vertexGeminiAvailable = false;

function showByokModal() {
  byokModal.hidden = false;
  selectedProvider = null;
  showStep(1);
  $('step1-next').disabled = true;
  byokInput.value = '';
  // Probe health to disable unavailable providers
  probeAndDisableProviders();
}

function hideByokModal() {
  byokModal.hidden = true;
}

function showStep(n) {
  $('step-1').hidden = n !== 1;
  $('step-2').hidden = n !== 2;
}

async function probeAndDisableProviders() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('/api/health', { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return;
    const json = await res.json();
    const providers = json.providers ?? {};
    _vertexGeminiAvailable = json.vertexGemini ?? false;
    for (const id of KNOWN_PROVIDERS) {
      const opt = document.getElementById(`opt-${id}`);
      if (!opt) continue;
      const radio = opt.querySelector('input[type=radio]');
      if (providers[id] === false) {
        radio.disabled = true;
        let note = opt.querySelector('.sdk-missing-note');
        if (!note) {
          note = document.createElement('span');
          note.className = 'sdk-missing-note';
          note.textContent = '(SDK 未安裝)';
          opt.appendChild(note);
        }
      }
      if (id === 'gemini' && _vertexGeminiAvailable) {
        let note = opt.querySelector('.vertex-note');
        if (!note) {
          note = document.createElement('span');
          note.className = 'vertex-note';
          note.textContent = '(Vertex AI — 不需要 key)';
          opt.appendChild(note);
        }
      }
    }
  } catch {
    // fail-open: all radios remain enabled
    console.warn('[onboarding] /api/health timeout or error — all providers enabled (fail-open)');
  }
}

// Step 1: provider radio change
document.querySelectorAll('input[name="provider"]').forEach(radio => {
  radio.addEventListener('change', () => {
    selectedProvider = radio.value;
    $('step1-next').disabled = false;
  });
});

$('step1-next').addEventListener('click', () => {
  if (!selectedProvider) return;
  if (selectedProvider === 'gemini' && _vertexGeminiAvailable) {
    setCredentials('gemini', 'vertex-ai');
    hideByokModal();
    greetIfNeeded();
    return;
  }
  showStep(2);
  // Update step 2 UI for selected provider
  const meta = PROVIDER_META[selectedProvider];
  $('step2-title').textContent = `貼上 ${selectedProvider === 'anthropic' ? 'Anthropic' : selectedProvider === 'openai' ? 'OpenAI' : selectedProvider === 'gemini' ? 'Google Gemini' : 'GitHub Models'} API Key`;
  byokInput.placeholder = meta.placeholder;
  byokInput.value = '';
  const helperLink = $('key-link');
  helperLink.href = meta.helperLink;
  helperLink.textContent = meta.helperLinkText;
  $('key-helper-text').childNodes[0].textContent = meta.helperText + ' ';
  $('byok-confirm').disabled = true;
  byokInput.focus();
});

$('step2-back').addEventListener('click', () => {
  showStep(1);
});

byokInput.addEventListener('input', () => {
  $('byok-confirm').disabled = !byokInput.value.trim();
});

byokInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !$('byok-confirm').disabled) confirmByok();
});

$('byok-confirm').addEventListener('click', confirmByok);

function confirmByok() {
  const key = byokInput.value.trim();
  if (!key || !selectedProvider) return;
  setCredentials(selectedProvider, key);
  byokInput.value = '';
  hideByokModal();
  greetIfNeeded();
}

/* ─── Change provider (replaces v1 "forget-key") ────────────────────────── */
$('change-provider').addEventListener('click', async () => {
  // Abort in-flight stream
  if (_currentAbortCtrl) {
    _currentAbortCtrl.abort();
    if (_currentReader) {
      try { await _currentReader.cancel(); } catch {}
      _currentReader = null;
    }
    _currentAbortCtrl = null;
  }
  clearCredentials();
  showByokModal();
});

/* ─── Chat Display ───────────────────────────────────────────────────────── */
function renderLog() {
  chatLog.innerHTML = '';
  for (const entry of state.displayLog) appendBubbleFromEntry(entry);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function appendBubbleFromEntry(entry) {
  const div = document.createElement('div');
  div.className = `bubble ${entry.type}`;
  if (entry.interrupted) {
    div.textContent = entry.text;
    const span = document.createElement('span');
    span.className = 'interrupted';
    span.textContent = ' [中斷]';
    div.appendChild(span);
  } else {
    div.textContent = entry.text;
  }
  chatLog.appendChild(div);
  return div;
}

function addBubble(type, text, opts = {}) {
  const entry = { type, text, ...opts };
  state.displayLog.push(entry);
  const el = appendBubbleFromEntry(entry);
  chatLog.scrollTop = chatLog.scrollHeight;
  return el;
}

function setStatus(msg) { statusText.textContent = msg; }

/* ─── Input history ──────────────────────────────────────────────────────── */
let inputHistory = [];
let historyIdx = -1;

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); handleSend(); return; }
  if (e.key === 'Escape') { chatInput.value = ''; historyIdx = -1; return; }
  if (e.key === 'ArrowUp' && chatInput.value === '') {
    e.preventDefault();
    if (inputHistory.length > 0) {
      historyIdx = Math.min(historyIdx + 1, inputHistory.length - 1);
      chatInput.value = inputHistory[historyIdx] ?? '';
    }
    return;
  }
  historyIdx = -1;
});

sendBtn.addEventListener('click', handleSend);

function setInputDisabled(disabled) {
  chatInput.disabled = disabled;
  sendBtn.disabled = disabled;
}

/* ─── Greeting ───────────────────────────────────────────────────────────── */
function greetIfNeeded() {
  if (state.displayLog.length === 0) {
    const greeting = '我幫你把履歷轉成單檔 HTML（現代簡約 / 彩色設計感 / 學術型 三選一）。\n支援 LinkedIn / 104 連結，或貼 HTML / 純文字 / LinkedIn Download-your-data ZIP 路徑。\n請直接貼內容：';
    state.messages.push({ role: 'assistant', content: greeting });
    addBubble('ai', greeting);
    state.phase = 'waiting-input';
    saveState();
  }
}

/* ─── Main send handler ──────────────────────────────────────────────────── */
async function handleSend() {
  const text = chatInput.value.trim();
  if (!text) return;

  const creds = getCredentials();
  if (!creds) { showByokModal(); return; }

  if (text === '取消') {
    chatInput.value = '';
    addBubble('user', '取消');
    state.messages.push({ role: 'user', content: '取消' });
    addBubble('ai', '已取消。若要重新開始請重新貼履歷內容。');
    state.phase = 'idle';
    saveState();
    return;
  }

  if (/^https?:\/\//.test(text.trim()) || /^<!DOCTYPE|^<html/i.test(text.trim())) {
    state.parsedData = null;
    state.gapsData = null;
    state.answers = {};
    state.renderedHtml = null;
    state.renderedFilename = null;
    state.polished = false;
    state.phase = 'waiting-input';
  }

  chatInput.value = '';
  inputHistory.unshift(text);
  if (inputHistory.length > 30) inputHistory.pop();

  addBubble('user', text);
  state.messages.push({ role: 'user', content: text });
  setInputDisabled(true);
  setStatus('AI 思考中…');

  if (state.phase === 'waiting-input' && !state.parsedData) {
    await handleInitialInput(text, creds);
  } else if (state.phase === 'gaps') {
    await handleGapAnswer(text, creds);
  } else {
    await doStreamChat(creds);
  }
}

/* ─── Streaming chat (multi-provider aware) ─────────────────────────────── */
let _currentAbortCtrl = null;
let _currentReader = null;

async function doStreamChat(creds, prefixMsg = null) {
  if (prefixMsg) {
    addBubble('system', prefixMsg);
    setInputDisabled(false);
    setStatus('');
    return;
  }

  // Snapshot credentials at call time (multi-tab safety)
  const { provider, key } = creds;

  const bubble = addBubble('ai', '');
  let fullText = '';
  let interrupted = false;

  _currentAbortCtrl = new AbortController();
  const { signal } = _currentAbortCtrl;

  try {
    const resp = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-provider-key': key,
        'x-session-id': SESSION_ID,
      },
      body: JSON.stringify({ provider, messages: state.messages.slice(-40) }),
      signal,
    });

    if (!resp.ok) {
      const json = await resp.json().catch(() => ({}));
      const msg = ERROR_MESSAGES_ZH[json.code] ?? json.message_zh ?? 'AI 回應失敗，請重試';
      bubble.textContent = msg;
      if (json.code === 'INVALID_KEY') setTimeout(() => showByokModal(), 500);
      setInputDisabled(false);
      setStatus('');
      return;
    }

    _currentReader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventType = 'data';

    while (true) {
      const { done, value } = await _currentReader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('event: ')) { eventType = line.slice(7).trim(); continue; }
        if (line.startsWith('data: ')) {
          const raw = line.slice(6);
          if (raw === '[DONE]') break;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.code || eventType === 'error') {
              const msg = ERROR_MESSAGES_ZH[parsed.code] ?? parsed.message_zh ?? `錯誤：${parsed.code}`;
              bubble.textContent = msg;
              if (parsed.code === 'INVALID_KEY') setTimeout(() => showByokModal(), 500);
              interrupted = true;
              break;
            }
            if (parsed.chunk) {
              fullText += parsed.chunk;
              bubble.textContent = fullText;
              chatLog.scrollTop = chatLog.scrollHeight;
            }
          } catch {}
          eventType = 'data';
        }
      }
      if (interrupted) break;
    }
  } catch (err) {
    if (err?.name === 'AbortError') {
      interrupted = true;
      if (fullText) bubble.textContent = fullText;
      const span = document.createElement('span');
      span.className = 'interrupted';
      span.textContent = ' [中斷]';
      bubble.appendChild(span);
    } else {
      fullText = fullText || '連線中斷';
      interrupted = true;
      bubble.textContent = fullText;
    }
  } finally {
    _currentAbortCtrl = null;
    _currentReader = null;
  }

  if (!interrupted && fullText) {
    state.messages.push({ role: 'assistant', content: fullText });
    const idx = state.displayLog.length - 1;
    if (idx >= 0 && state.displayLog[idx].type === 'ai') {
      state.displayLog[idx].text = fullText;
      state.displayLog[idx].interrupted = false;
    }
  } else if (interrupted) {
    const idx = state.displayLog.length - 1;
    if (idx >= 0) state.displayLog[idx].interrupted = true;
  }

  saveState();
  setInputDisabled(false);
  setStatus('');
}

/* ─── Backward-compat wrapper for older call sites ───────────────────────── */
async function streamChat(creds, prefixMsg = null) {
  return doStreamChat(creds, prefixMsg);
}

/* ─── Input parsing flow ─────────────────────────────────────────────────── */
async function handleInitialInput(text, creds) {
  const kind = detectKind(text);
  addBubble('system', `正在解析您的履歷（${kind}）…`);
  setStatus('解析中…');
  state.phase = 'parsing';
  saveState();

  try {
    const parseResult = await callParse(kind, text);

    let finalParseResult = parseResult;
    if (!finalParseResult.ok) {
      setStatus('本地解析不足，改由 AI 解析…');
      addBubble('system', '本地解析資料不足，改由 AI 嘗試解析履歷內容…');
      finalParseResult = await callAiParse(kind, text, creds, parseResult);
    }

    if (!finalParseResult.ok) {
      addBubble('ai', finalParseResult.message_zh ?? 'AI 解析失敗，請改貼可見的履歷文字或 HTML。');
      state.phase = 'waiting-input';
      saveState();
      setInputDisabled(false);
      setStatus('');
      return;
    }

    state.parsedData = finalParseResult.data;
    const summary = buildSummary(state.parsedData);
    addBubble('system', summary);

    const parseMsg = `[PARSE_RESULT] ${JSON.stringify({ ok: true, summary })}`;
    state.messages.push({ role: 'user', content: parseMsg });
    await runGaps(creds);
  } catch (err) {
    addBubble('ai', `解析失敗：${err.message_zh ?? err.message ?? String(err)}`);
    state.phase = 'waiting-input';
    setInputDisabled(false);
    setStatus('');
    saveState();
  }
}

function detectKind(text) {
  const t = text.trim();
  if (/^https?:\/\//.test(t) && t.includes('linkedin.com/in/')) return 'linkedin-url';
  if (/^https?:\/\//.test(t) && t.includes('104.com.tw')) return '104-url';
  if (/^<!DOCTYPE|^<html/i.test(t) || (t.includes('<div') && t.includes('</'))) return 'html-paste';
  if (/\.zip$/i.test(t) && !t.includes('\n')) return 'linkedin-zip';
  return 'text-paste';
}

function buildSummary(data) {
  const exp = (data.experiences ?? []).length;
  const edu = (data.education ?? []).length;
  const skills = (data.skills ?? []).length;
  return `讀到 ${exp} 段工作經歷、${edu} 個學歷、${skills} 項技能（source: ${data._source ?? 'unknown'}）`;
}

async function callParse(kind, input) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PARSE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('/api/parse', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, input }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw timeoutError('本地解析逾時，請重試或改貼履歷 HTML / 純文字。');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (!res.ok) return { ok: false, ...json };
  return json;
}

async function callAiParse(kind, input, creds, localError) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), AI_PARSE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('/api/ai-parse', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-provider-key': creds.key,
      },
      body: JSON.stringify({
        provider: creds.provider,
        kind,
        input,
        local_error: localError,
      }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw timeoutError('AI 解析逾時，請重試或改貼履歷 HTML / 純文字。');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (!res.ok) return { ok: false, ...json };
  return json;
}

/* ─── Gap Q&A flow ───────────────────────────────────────────────────────── */
let gapQuestions = [];
let gapAnswers = {};
let gapIdx = 0;

async function runGaps(creds) {
  setStatus('偵測履歷缺口…');
  try {
    const res = await fetch('/api/gaps', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: state.parsedData }),
    });
    if (!res.ok) throw new Error('gaps API failed');
    const gapsResult = await res.json();

    state.gapsData = gapsResult;
    gapQuestions = gapsResult.questions ?? [];
    gapAnswers = {};
    gapIdx = 0;

    const gapsMsg = `[GAPS_RESULT] ${JSON.stringify({ total: gapQuestions.length })}`;
    state.messages.push({ role: 'user', content: gapsMsg });

    if (gapQuestions.length === 0) {
      state.phase = 'rendering';
      await polishThenRender(creds);
      return;
    }

    state.phase = 'gaps';
    setInputDisabled(false);
    setStatus('');
    await askNextGap(creds);
  } catch {
    state.phase = 'rendering';
    await polishThenRender(creds);
  }
}

async function askNextGap(creds) {
  if (gapIdx >= gapQuestions.length || gapIdx >= 5) {
    await polishThenRender(creds);
    return;
  }
  const q = gapQuestions[gapIdx];
  const qText = `(問題 ${gapIdx + 1}/${Math.min(gapQuestions.length, 5)}) ${q.text}`;
  state.messages.push({ role: 'assistant', content: qText });
  addBubble('ai', qText);
  saveState();
  setInputDisabled(false);
  setStatus('');
}

async function handleGapAnswer(text, creds) {
  if (gapIdx < gapQuestions.length) {
    const q = gapQuestions[gapIdx];
    const skip = ['跳過', '不知道', 'skip', ''].includes(text.trim());
    gapAnswers[q.id] = { answer: skip ? '跳過' : text, target_path: q.target_path, rule: q.rule, text: q.text };
    gapIdx++;
  }
  if (gapIdx >= Math.min(gapQuestions.length, 5)) {
    state.answers = gapAnswers;
    state.phase = 'rendering';
    addBubble('ai', '好的，我會先整合您的補充並潤飾履歷，再生成預覽…');
    state.messages.push({ role: 'assistant', content: '好的，我會先整合您的補充並潤飾履歷，再生成預覽…' });
    await polishThenRender(creds);
  } else {
    await askNextGap(creds);
  }
}

async function polishThenRender(creds) {
  setStatus('AI 正在整合補答並潤飾履歷…');
  setInputDisabled(true);
  try {
    const polished = await callPolish(creds);
    if (polished.ok && polished.data) {
      state.parsedData = polished.data;
      state.answers = {};
      state.polished = true;
      addBubble('system', '已完成 AI 潤飾：摘要、經歷 bullet 與技能已重新整理。');
    } else {
      addBubble('system', `AI 潤飾未完成，改用原始解析結果：${polished.message_zh ?? '未知原因'}`);
    }
  } catch (err) {
    addBubble('system', `AI 潤飾失敗，改用原始解析結果：${err.message ?? String(err)}`);
  }
  await doRender(creds);
}

async function callPolish(creds) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), POLISH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch('/api/polish', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-provider-key': creds.key,
      },
      body: JSON.stringify({
        provider: creds.provider,
        data: state.parsedData,
        answers: Object.keys(state.answers ?? {}).length > 0 ? state.answers : null,
      }),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw timeoutError('AI 潤飾逾時，將使用原始解析結果。');
    throw err;
  } finally {
    clearTimeout(timer);
  }
  const json = await res.json();
  if (!res.ok) return { ok: false, ...json };
  return json;
}

/* ─── Render ─────────────────────────────────────────────────────────────── */
async function doRender(creds, privacyDecision = null) {
  setStatus('生成履歷中…');
  setInputDisabled(true);
  try {
    const payload = {
      data: state.parsedData,
      answers: Object.keys(state.answers).length > 0 ? state.answers : null,
      template: state.currentTemplate,
    };
    if (privacyDecision) payload.privacy_decision = privacyDecision;

    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();

    if (res.status === 409 && json.code === 'PRIVACY_GATE') {
      const decision = await showPrivacyModal(json.hits);
      await doRender(creds, decision);
      return;
    }
    if (!res.ok) {
      addBubble('ai', `渲染失敗：${json.message_zh ?? '未知錯誤'}`);
      state.phase = 'done';
      setInputDisabled(false);
      setStatus('');
      return;
    }

    state.renderedHtml = json.html;
    state.renderedFilename = json.filename;
    state.phase = 'done';
    showPreview(json.html);
    showTemplateGallery();
    downloadArea.hidden = false;
    downloadBtn.disabled = false;
    saveState();
    setStatus('');
    setInputDisabled(false);
  } catch (err) {
    addBubble('ai', `渲染失敗：${err.message ?? String(err)}`);
    state.phase = 'done';
    setInputDisabled(false);
    setStatus('');
  }
}

function showPreview(html) {
  previewPlaceholder.hidden = true;
  previewFrame.hidden = false;
  previewFrame.setAttribute('sandbox', '');
  previewFrame.srcdoc = html;
}

async function rerenderTemplate(templateId) {
  state.currentTemplate = templateId;
  updateTemplateButtons();
  const renderData = state.parsedData || SAMPLE_RESUME;
  setStatus('切換樣板中…');
  const t0 = performance.now();
  try {
    const hasRealData = Boolean(state.parsedData);
    const res = await fetch('/api/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: renderData,
        answers: hasRealData && Object.keys(state.answers ?? {}).length > 0 ? state.answers : null,
        template: templateId,
        privacy_decision: 'keep',
      }),
    });
    if (!res.ok) return;
    const json = await res.json();
    showPreview(json.html);
    if (hasRealData) {
      state.renderedHtml = json.html;
      state.renderedFilename = json.filename;
      saveState();
      downloadArea.hidden = false;
    } else {
      downloadArea.hidden = true;
    }
    const elapsed = Math.round(performance.now() - t0);
    setStatus(`${hasRealData ? '切換完成' : '示範樣板切換完成'}（${elapsed}ms）`);
    setTimeout(() => setStatus(''), 2000);
  } catch { setStatus('切換失敗'); }
}

async function showSamplePreviewIfNeeded() {
  if (state.parsedData || state.renderedHtml) return;
  setStatus('載入示範樣板中…');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), SAMPLE_PREVIEW_TIMEOUT_MS);
    const res = await fetch('/api/render', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: SAMPLE_RESUME, template: state.currentTemplate, privacy_decision: 'keep' }),
    }).finally(() => clearTimeout(timer));
    if (!res.ok) return;
    const json = await res.json();
    showPreview(json.html);
    showTemplateGallery();
    downloadArea.hidden = true;
    previewPlaceholder.hidden = true;
  } catch {
    // keep placeholder when sample preview is unavailable
  } finally {
    if (!state.parsedData && !state.renderedHtml) setStatus('');
  }
}

/* ─── Template Gallery ───────────────────────────────────────────────────── */
let templates = [];

async function loadTemplates() {
  try {
    const res = await fetch('/templates.json');
    templates = await res.json();
    renderTemplateGallery();
  } catch {}
}

function renderTemplateGallery() {
  templateList.innerHTML = '';
  for (const tpl of templates) {
    const btn = document.createElement('button');
    btn.className = 'tpl-btn' + (tpl.id === state.currentTemplate ? ' active' : '');
    btn.dataset.id = tpl.id;
    btn.title = tpl.description;
    btn.textContent = tpl.label;
    btn.addEventListener('click', () => rerenderTemplate(tpl.id));
    templateList.appendChild(btn);
  }
}

function updateTemplateButtons() {
  for (const btn of templateList.querySelectorAll('.tpl-btn')) {
    btn.classList.toggle('active', btn.dataset.id === state.currentTemplate);
  }
}

function showTemplateGallery() { templateGallery.hidden = false; renderTemplateGallery(); }

/* ─── Download ───────────────────────────────────────────────────────────── */
downloadBtn.addEventListener('click', () => {
  if (!state.renderedHtml) return;
  const blob = new Blob([state.renderedHtml], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.renderedFilename ?? 'resume.html';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

/* ─── Privacy Modal ──────────────────────────────────────────────────────── */
function showPrivacyModal(hits) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.id = 'privacy-modal';
    const paths = hits.map(h => `${h.path}（${h.reason}）`).join('\n');
    overlay.innerHTML = `
      <div class="modal-box">
        <h2>偵測到可能的敏感資料</h2>
        <p>以下欄位包含可能的敏感內容：<br><code style="font-size:11px;white-space:pre">${escHtml(paths)}</code></p>
        <p>如何處理？</p>
        <div class="priv-actions">
          <button id="priv-redact">刪除敏感欄位</button>
          <button id="priv-keep" class="primary">保留並繼續</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#priv-redact').addEventListener('click', () => { document.body.removeChild(overlay); resolve('redact'); });
    overlay.querySelector('#priv-keep').addEventListener('click', () => { document.body.removeChild(overlay); resolve('keep'); });
  });
}

function escHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

/* ─── Multi-tab sync ─────────────────────────────────────────────────────── */
window.addEventListener('focus', () => {
  const raw = storageGet(KEY_STATE);
  if (!raw) return;
  try {
    const loaded = JSON.parse(raw);
    if (loaded.sessionId && loaded.sessionId !== state.sessionId) {
      state = { ...loaded, sessionId: SESSION_ID };
      renderLog();
      if (state.renderedHtml) { showPreview(state.renderedHtml); showTemplateGallery(); downloadArea.hidden = false; }
      multitabBanner.hidden = false;
      saveState();
    }
  } catch {}
});

/* ─── Restore state on load ──────────────────────────────────────────────── */
function restoreState() {
  loadState();
  if (['parsing', 'rendering'].includes(state.phase)) {
    const last = state.displayLog[state.displayLog.length - 1];
    if (last && last.type === 'ai') last.interrupted = true;
    state.phase = state.parsedData ? 'waiting-input' : 'waiting-input';
    state.renderedHtml = null;
    setStatus('');
    setInputDisabled(false);
    saveState();
  }
  if (state.phase === 'gaps' && (!state.parsedData || !state.gapsData)) {
    state.phase = 'waiting-input';
    setInputDisabled(false);
    setStatus('');
    saveState();
  }
  if (state.displayLog.length > 0) {
    renderLog();
    const last = state.displayLog[state.displayLog.length - 1];
    if (last && last.type === 'ai' && state.phase !== 'done' && state.phase !== 'idle') {
      last.interrupted = true;
      renderLog();
    }
    if (state.renderedHtml) { showPreview(state.renderedHtml); showTemplateGallery(); downloadArea.hidden = false; }
  }
}

/* ─── Init ───────────────────────────────────────────────────────────────── */
async function init() {
  await loadTemplates();

  // v1→v2 migration (runs before getCredentials)
  migrateV1IfNeeded();

  restoreState();

  const creds = getCredentials();
  if (!creds) {
    showByokModal();
  } else {
    greetIfNeeded();
  }
  await showSamplePreviewIfNeeded();
}

init();
