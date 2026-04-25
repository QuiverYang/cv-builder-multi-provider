/**
 * Subprocess wrappers for Python helpers.
 * Spawns python3 with stdin pipe, collects stdout, JSON-parses.
 * Error taxonomy: PARSER_CRASH | PARSER_TIMEOUT | INSUFFICIENT_DATA | ZIP_NOT_LINKEDIN
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HELPERS_DIR = path.join(__dirname, '..', 'helpers');
const TIMEOUT_MS = 10_000;
const STDERR_MAX = 4096;

class ParserError extends Error {
  constructor(code, detail = '') {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

function truncateStderr(buf) {
  const s = buf.toString('utf8');
  if (s.length <= STDERR_MAX) return s;
  return s.slice(0, STDERR_MAX) + '…[truncated]';
}

/**
 * Run a Python helper script, optionally writing `stdinData` to its stdin.
 * `args` is an array of CLI args after `python3 <script>`.
 */
function runPython(script, args = [], stdinData = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [path.join(HELPERS_DIR, script), ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT_MS);

    child.stdout.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]); });
    child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]); });

    if (stdinData !== null) {
      child.stdin.write(typeof stdinData === 'string' ? stdinData : JSON.stringify(stdinData));
      child.stdin.end();
    } else {
      child.stdin.end();
    }

    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new ParserError('PARSER_TIMEOUT', `${script} exceeded ${TIMEOUT_MS}ms`));
      }
      if (code !== 0) {
        return reject(new ParserError('PARSER_CRASH', truncateStderr(stderr)));
      }
      try {
        resolve(JSON.parse(stdout.toString('utf8')));
      } catch {
        reject(new ParserError('PARSER_CRASH', `Bad JSON from ${script}: ${truncateStderr(stderr)}`));
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      reject(new ParserError('PARSER_CRASH', err.message));
    });
  });
}

/** Write data to a temp file, return its path. Caller must clean up. */
function writeTmp(data, ext = '.tmp') {
  const p = path.join(os.tmpdir(), `cvb-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  if (Buffer.isBuffer(data)) {
    fs.writeFileSync(p, data);
  } else if (typeof data === 'string') {
    fs.writeFileSync(p, data, 'utf8');
  } else {
    fs.writeFileSync(p, JSON.stringify(data), 'utf8');
  }
  return p;
}

function fieldCount(data) {
  let n = 0;
  for (const key of ['name', 'headline', 'summary']) {
    if (data[key]) n++;
  }
  if (data.contact?.email || data.contact?.phone) n++;
  if (data.experiences?.length) n++;
  if (data.education?.length) n++;
  if (data.skills?.length) n++;
  return n;
}

/**
 * Pre-validate a ZIP buffer: must contain Profile.csv.
 * Throws ZIP_NOT_LINKEDIN if not found.
 * Uses a lightweight check via Python's zipfile.
 */
async function validateZip(zipBuffer) {
  const tmpZip = writeTmp(zipBuffer, '.zip');
  try {
    const result = await runPython('zip_validate.py', [tmpZip]);
    if (!result.ok) {
      throw new ParserError('ZIP_NOT_LINKEDIN', result.reason || 'Profile.csv not found');
    }
  } finally {
    try { fs.unlinkSync(tmpZip); } catch {}
  }
}

/**
 * Parse resume input.
 * @param {string} kind - linkedin-url|104-url|html-paste|linkedin-zip|text-paste
 * @param {string|Buffer} body - text content or binary buffer for zip
 * @returns {object} canonical resume JSON
 */
export async function parse(kind, body) {
  let tmpPath = null;
  try {
    if (kind === 'linkedin-zip') {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      // Pre-validate ZIP before spawning full parser
      await validateZip(buf);
      tmpPath = writeTmp(buf, '.zip');
    } else {
      tmpPath = writeTmp(body, kind === 'html-paste' ? '.html' : '.txt');
    }

    const data = await runPython('parse.py', ['--kind', kind, '--input', tmpPath]);

    if (fieldCount(data) < 3) {
      const err = new ParserError('INSUFFICIENT_DATA', `field_count=${fieldCount(data)}`);
      err.data = data;
      throw err;
    }

    return data;
  } finally {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
  }
}

/**
 * Detect gaps in parsed resume data.
 * @param {object} resumeJson - canonical resume JSON
 * @returns {object} {questions, deferred, total_detected}
 */
export async function detectGaps(resumeJson) {
  const tmpPath = writeTmp(resumeJson, '.json');
  try {
    return await runPython('gaps.py', [tmpPath, '--max', '5']);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Scan for sensitive data.
 * @param {object} resumeJson - canonical resume JSON
 * @returns {object} {hits: [...]}
 */
export async function scanPrivacy(resumeJson) {
  const tmpPath = writeTmp(resumeJson, '.json');
  try {
    return await runPython('privacy.py', [tmpPath]);
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
}

/**
 * Render resume to single-file HTML.
 * @param {object} resumeJson
 * @param {object|null} answers
 * @param {string} template - modern-minimal|colorful|academic-serif
 * @param {string} outdir
 * @returns {object} {path, size, slug}
 */
export async function render(resumeJson, answers, template, outdir) {
  const dataPath = writeTmp(resumeJson, '.json');
  const answersPath = answers ? writeTmp(answers, '.json') : null;
  try {
    const args = [
      '--data', dataPath,
      '--template', template,
      '--outdir', outdir,
    ];
    if (answersPath) args.push('--answers', answersPath);
    return await runPython('render.py', args);
  } finally {
    try { fs.unlinkSync(dataPath); } catch {}
    if (answersPath) { try { fs.unlinkSync(answersPath); } catch {} }
  }
}

export { ParserError };
