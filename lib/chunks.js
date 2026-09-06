import { createHash } from 'node:crypto';
import { neon } from '@neondatabase/serverless';
import { MAX_URL_BYTES, parseRequest, ProxyError } from './proxy.js';

export const CHUNK_BYTES = 4096;
export const MAX_PAYLOAD_BYTES = 256 * 1024;
const bad = (message) => { throw new ProxyError(400, 'invalid_upload', message); };
const actions = {
  create: ['url', 'headers', 'response', 'timeout', 'bytes', 'chunks', 'sha256', 'expires'],
  put: ['index', 'chunk'], status: [], execute: [],
};
export function parseChunkRequest(requestUrl) {
  if (Buffer.byteLength(requestUrl) > MAX_URL_BYTES) throw new ProxyError(414, 'url_too_long', 'Encoded URL must be at most 12 KiB.');
  const params = new URL(requestUrl, 'https://converter.invalid').searchParams;
  const action = params.get('action');
  if (!Object.hasOwn(actions, action)) bad('action must be create, put, status, or execute.');
  const allowed = new Set(['action', 'token', ...actions[action]]);
  for (const key of params.keys()) if (!allowed.has(key) || params.getAll(key).length !== 1) bad('Unknown or duplicate parameter.');
  const token = params.get('token');
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) bad('Supply a fresh random 32-byte token as 64 lowercase hex characters; reuse it only for this upload.');
  const result = { action, tokenHash: createHash('sha256').update(token).digest('hex') };
  const integer = (key, max) => {
    const value = params.get(key);
    if (!/^(0|[1-9][0-9]*)$/.test(value ?? '') || Number(value) > max) bad(`Invalid ${key}.`);
    return Number(value);
  };
  if (action === 'create') {
    result.bytes = integer('bytes', MAX_PAYLOAD_BYTES);
    result.expires = integer('expires', 4102444800);
    result.chunks = integer('chunks', 64);
    result.digest = params.get('sha256');
    if (!result.bytes || result.chunks !== Math.ceil(result.bytes / CHUNK_BYTES) || !/^[a-f0-9]{64}$/.test(result.digest ?? '')) bad('Supply body bytes, ceil(bytes/4096) chunks, and its lowercase SHA-256.');
    const request = new URLSearchParams();
    for (const key of ['url', 'headers', 'response', 'timeout']) if (params.has(key)) request.set(key, params.get(key));
    result.request = `/api/post?${request}`;
    if (Buffer.byteLength(result.request) > 8192) bad('Encoded destination and request options must fit in 8 KiB.');
    parseRequest(result.request); // Freeze and validate routing options before storing anything.
  } else if (action === 'put') {
    result.index = integer('index', 63);
    const encoded = params.get('chunk') ?? '';
    if (!/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length > 5462) bad('chunk must be unpadded base64url encoding of at most 4096 bytes.');
    const data = Buffer.from(encoded, 'base64url');
    if (data.length > CHUNK_BYTES || data.toString('base64url') !== encoded) bad('Invalid base64url chunk.');
    result.data = data;
  }
  return result;
}

const errors = {
  invalid_expiry: [400, 'Create requires a fixed expires Unix timestamp in the next 15 minutes. Expired create links cannot be reused.'],
  invalid_upload: [400, 'Invalid upload.'], invalid_chunk: [400, 'Chunk index or byte length does not match the declared body.'],
  uploads_disabled: [503, 'Chunk uploads are disabled.'],
  upload_rate_limited: [429, 'Shared upload request budget reached.'],
  upload_daily_limit: [429, 'Shared daily upload budget reached.'],
  upload_capacity: [429, 'All upload slots are occupied.'], execution_capacity: [429, 'All chunk execution slots are occupied.'],
  upload_not_found: [404, 'Upload is unknown or expired.'], upload_expiring: [410, 'Upload is too close to expiry to execute.'],
  upload_conflict: [409, 'Token already belongs to a different request.'], chunk_conflict: [409, 'That chunk index already contains different bytes.'],
  upload_consumed: [409, 'Execution was already claimed. It may have sent the POST. Never recreate or retry blindly.'],
  upload_incomplete: [409, 'Some chunks are missing.'], digest_mismatch: [409, 'Assembled payload does not match its declared SHA-256.'],
};
export function createChunkStore({ connectionString = () => process.env.CHUNK_DATABASE_URL, client = neon } = {}) {
  return {
    async operate(input) {
      try {
        const url = connectionString();
        if (!url) throw new Error('unconfigured');
        const rows = await client(url).query('SELECT chunk_uploads.operate($1,$2,$3,$4,$5,$6,$7,$8::bytea,$9::bigint) AS result', [
          input.action, input.tokenHash, input.request ?? null, input.bytes ?? null,
          input.chunks ?? null, input.digest ?? null, input.index ?? null,
          input.data ? `\\x${input.data.toString('hex')}` : null, input.expires ?? null,
        ], { fetchOptions: { signal: AbortSignal.timeout(3000) } });
        const result = rows[0].result;
        if (result.error) {
          const [status, message] = errors[result.error] ?? [503, 'Upload storage is unavailable.'];
          const error = new ProxyError(status, result.error, message);
          error.retryAfter = result.retryAfter;
          throw error;
        }
        return result;
      } catch (error) {
        if (error instanceof ProxyError) throw error;
        // A lost claim response is ambiguous: never automatically try it again.
        throw new ProxyError(503, 'upload_storage_unavailable', 'Upload storage is unavailable. If executing, the claim may have committed; check status and do not retry blindly.');
      }
    },
  };
}
export const chunkStore = createChunkStore();
