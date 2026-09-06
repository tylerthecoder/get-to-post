import { randomUUID } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

const REDACTED = '[REDACTED]';
const OMITTED = '[OMITTED: invalid or oversized structured input]';
const MAX_INPUT = 16 * 1024;
const MAX_HEADERS = 16 * 1024;
const sensitive = (name) => /authorization|cookie|password|passwd|secret|token|api[-_]?key|credential|signature|bypass|(?:^|[-_])(?:key|jwt|session)(?:$|[-_])/i.test(name);

// PostgreSQL JSONB rejects NUL and lone UTF-16 surrogates. Keep a printable
// representation instead of making malicious input disable the audit insert.
function databaseSafe(value) {
  if (typeof value === 'string') return value.toWellFormed().replaceAll('\0', '\\u0000');
  if (Array.isArray(value)) return value.map(databaseSafe);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [databaseSafe(key), databaseSafe(item)]));
  return value;
}

function redactObject(value, depth = 0) {
  if (depth > 20) return '[OMITTED: nesting limit]';
  if (Array.isArray(value)) return value.map((item) => redactObject(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sensitive(key) ? REDACTED : redactObject(item, depth + 1)]));
  }
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? redactUrl(value, depth + 1) : value;
}

function redactUrl(value, depth = 0) {
  if (depth > 20 || value.length > MAX_INPUT) return OMITTED;
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    url.hash = '';
    const params = [...url.searchParams].map(([key, item]) => [key, sensitive(key) ? REDACTED : /^https?:\/\//i.test(item) ? redactUrl(item, depth + 1) : item]);
    url.search = new URLSearchParams(params).toString();
    return url.href;
  } catch { return OMITTED; }
}

function redactUnparsedBody(value) {
  // Without a parse tree we cannot reliably find a credential value's end.
  // Keep the readable prefix, but discard the tail after a sensitive field.
  const fields = /("(?:\\.|[^"\\])*"|'[^']*'|[\w-]+)\s*[:=]\s*/g;
  for (const match of value.matchAll(fields)) {
    let key = match[1];
    if (key.startsWith('"')) {
      try { key = JSON.parse(key); } catch { /* Best-effort text fallback. */ }
    } else if (key.startsWith("'")) key = key.slice(1, -1);
    if (sensitive(key)) return value.slice(0, match.index + match[0].length) + REDACTED;
  }
  return value;
}

function redactBody(value, contentType) {
  if (value.length > MAX_INPUT) return OMITTED;
  try { return JSON.stringify(redactObject(JSON.parse(value))); }
  catch {
    if (contentType.includes('application/x-www-form-urlencoded')) {
      return new URLSearchParams([...new URLSearchParams(value)].map(([key, item]) => [key, sensitive(key) ? REDACTED : item])).toString();
    }
    // Preserve malformed JSON and text; arbitrary secrets cannot be identified reliably.
    return redactUnparsedBody(value);
  }
}

export function requestRecord(req, { id = randomUUID(), now = new Date() } = {}) {
  const requestUrl = req.url ?? '';
  const oversized = Buffer.byteLength(requestUrl) > MAX_INPUT;
  let url;
  try { url = new URL(oversized ? '/api/post' : requestUrl, 'https://converter.invalid'); }
  catch { url = new URL('https://converter.invalid/api/post'); }
  let contentType = 'application/json';
  const query = oversized ? [['__omitted', OMITTED]] : [...url.searchParams].map(([key, value]) => {
    if (sensitive(key)) return [key, REDACTED];
    if (key === 'headers') {
      try {
        const parsed = JSON.parse(value);
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return [key, OMITTED];
        return [key, redactObject(parsed)];
      } catch { return [key, OMITTED]; }
    }
    if (key === 'url') return [key, redactUrl(value)];
    if (key === 'data') return [key, value]; // Redact after finding Content-Type, regardless of parameter order.
    return [key, value];
  });
  for (const [key, value] of query) {
    if (key === 'headers' && value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) if (name.toLowerCase() === 'content-type' && typeof item === 'string') contentType = item.toLowerCase();
    }
  }
  for (const entry of query) if (entry[0] === 'data') entry[1] = redactBody(entry[1], contentType);
  let headerBytes = 0;
  const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([name, value]) => {
    headerBytes += Buffer.byteLength(name) + Buffer.byteLength(String(value));
    if (headerBytes > MAX_HEADERS) return [name, '[OMITTED: header limit]'];
    // Referer can embed another request's URL, so omit it rather than partially parsing it.
    if (sensitive(name) || name.toLowerCase() === 'referer' || /^x-(vercel|now)-/i.test(name)) return [name, REDACTED];
    return [name, value];
  }));
  return databaseSafe({
    id, receivedAt: now.toISOString(), method: req.method ?? 'UNKNOWN',
    path: url.pathname, query, headers, urlBytes: Buffer.byteLength(requestUrl),
    truncated: oversized || headerBytes > MAX_HEADERS,
    environment: process.env.VERCEL_ENV ?? 'development',
    deployment: process.env.VERCEL_URL ?? null,
  });
}

export function createRequestLogger({ connectionString = () => process.env.REQUEST_LOG_DATABASE_URL, client = neon } = {}) {
  const execute = async (query, values) => {
    const url = connectionString();
    if (!url) throw new Error('Request logging is not configured');
    // Never reuse a timeout signal between warm invocations.
    const sql = client(url);
    await sql.query(query, values, { fetchOptions: { signal: AbortSignal.timeout(3000) } });
  };
  return {
    async start(record) {
      await execute(`INSERT INTO request_logging.requests
        (id, received_at, method, path, query, headers, url_bytes, truncated, environment, deployment)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9, $10)`, [
        record.id, record.receivedAt, record.method, record.path,
        JSON.stringify(record.query), JSON.stringify(record.headers), record.urlBytes,
        record.truncated, record.environment, record.deployment,
      ]);
    },
    async finish(id, outcome) {
      await execute(`INSERT INTO request_logging.outcomes
        (request_id, finished_at, http_status, upstream_status, error_code, duration_ms, response_bytes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
        id, new Date().toISOString(), outcome.httpStatus, outcome.upstreamStatus,
        outcome.errorCode, outcome.durationMs, outcome.responseBytes,
      ]);
    },
  };
}

export const requestLogger = createRequestLogger();
