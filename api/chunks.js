import { authorized, parseRequest, postUpstream, ProxyError } from '../lib/proxy.js';
import { chunkStore, parseChunkRequest, MAX_PAYLOAD_BYTES } from '../lib/chunks.js';
import { createHandler } from './post.js';
import { requestLogger } from '../lib/request-log.js';

export function createChunkHandler({ store = chunkStore, send = postUpstream, logger = requestLogger,
  enabled = () => process.env.CHUNK_UPLOADS_ENABLED === '1' } = {}) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
    try {
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization');
        res.statusCode = 204; return res.end();
      }
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET, OPTIONS');
        throw new ProxyError(405, 'method_not_allowed', 'Use GET. HEAD does not mutate or execute an upload.');
      }
      if (!enabled()) throw new ProxyError(503, 'uploads_disabled', 'Chunk uploads are not enabled on this deployment.');
      if (!authorized(req.headers.authorization)) throw new ProxyError(401, 'unauthorized', 'Supply the converter key in the Authorization header.');
      if (/prefetch|prerender/i.test(`${req.headers.purpose ?? ''} ${req.headers['sec-purpose'] ?? ''} ${req.headers['x-purpose'] ?? ''}`)) {
        throw new ProxyError(400, 'prefetch_blocked', 'Prefetch requests do not mutate or execute uploads.');
      }
      if (req.headers['transfer-encoding'] || (req.headers['content-length'] && req.headers['content-length'] !== '0')) {
        throw new ProxyError(400, 'unexpected_body', 'Send chunks as bounded query values, without a GET body.');
      }
      const input = parseChunkRequest(req.url);
      const result = await store.operate({ ...input, action: input.action === 'execute' ? 'claim' : input.action });
      if (input.action !== 'execute') return res.end(JSON.stringify(result));
      // Claim committed BEFORE logging/network work. No automatic release/retry
      // on a crash, logging failure, DNS error, timeout, or uncertain response.
      try {
        const config = parseRequest(result.request);
        config.data = Buffer.from(result.body, 'base64');
        if (config.data.length > MAX_PAYLOAD_BYTES) throw new ProxyError(500, 'invalid_stored_payload', 'Invalid stored payload.');
        // Log bounded routing metadata, never raw chunks, capability, or assembled
        // body. The existing redaction still applies to destination and headers.
        const loggedReq = { ...req, method: req.method, headers: req.headers,
          url: result.request.replace('/api/post?', '/api/chunks?') + '&action=execute&data=' + encodeURIComponent('[OMITTED: chunked payload]') };
        await createHandler(send, logger, () => config)(loggedReq, res);
      } finally {
        // Consumed even if this fails; bounded lease naturally expires. No log
        // containing DB credentials, capability tokens, chunks, or error details.
        try { await store.operate({ action: 'finish', tokenHash: input.tokenHash }); } catch { /* retain claimed state */ }
      }
    } catch (error) {
      const known = error instanceof ProxyError;
      res.statusCode = known ? error.status : 500;
      if (known && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      res.end(JSON.stringify({ error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'Could not process upload.' } }));
    }
  };
}
export default createChunkHandler();
