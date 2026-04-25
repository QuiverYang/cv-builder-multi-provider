// Key redaction patterns — server log safety
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_\-]+/g,
  /sk-[A-Za-z0-9_\-]+/g,
  /AIza[A-Za-z0-9_\-]{35}/g,
  /(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/g,
];

export function redact(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, '***REDACTED***');
  }
  return out;
}

export function redactObject(obj) {
  if (obj instanceof Error) {
    const copy = new Error(redact(obj.message));
    copy.stack = redact(obj.stack ?? '');
    copy.code = obj.code;
    return copy;
  }
  try {
    return JSON.parse(redact(JSON.stringify(obj)));
  } catch {
    return redact(String(obj));
  }
}

export function redactingLogger(base = console) {
  const wrap = (fn) => (...args) => {
    const safe = args.map((a) =>
      typeof a === 'string' ? redact(a) : a instanceof Error ? redactObject(a) : redactObject(a)
    );
    return fn.apply(base, safe);
  };
  return {
    log: wrap(base.log.bind(base)),
    info: wrap(base.info.bind(base)),
    warn: wrap(base.warn.bind(base)),
    error: wrap(base.error.bind(base)),
    debug: wrap((base.debug ?? base.log).bind(base)),
  };
}

export default { redact, redactObject, redactingLogger, PATTERNS };
