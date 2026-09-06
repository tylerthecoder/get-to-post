import { authorized, parseRequest, requestUpstream, renderUpstream, ProxyError } from '../lib/proxy.js';
import { requestLogger, requestRecord } from '../lib/request-log.js';

export function createHandler(send = requestUpstream, logger = requestLogger) {
  return async (req, res) => {
    const started = performance.now();
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Upstream-Status, X-Upstream-Content-Type, X-Upstream-Content-Encoding, X-Request-Id, X-Request-Log-Status');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    res.setHeader('Link', '</llms.txt>; rel="describedby"; type="text/plain"');
    const record = requestRecord(req);
    res.setHeader('X-Request-Id', record.id);
    let logged = false;
    let upstreamStatus = null;
    const complete = async (body, errorCode = null) => {
      if (logged) {
        try {
          await logger.finish(record.id, {
            httpStatus: res.statusCode, upstreamStatus, errorCode,
            durationMs: Math.round(performance.now() - started),
            responseBytes: req.method === 'HEAD' || [204, 304].includes(res.statusCode) ? 0 : body ? Buffer.byteLength(body) : 0,
          });
          res.setHeader('X-Request-Log-Status', 'complete');
        } catch {
          // Preserve the actual upstream result so a logging outage cannot invite
          // retries of an already-completed action. The start row is durable.
          res.setHeader('X-Request-Log-Status', 'request-only');
          console.error(JSON.stringify({ event: 'request_log_completion_failed', requestId: record.id }));
        }
      }
      res.end(body);
    };
    const error = (status, code, message) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return complete(JSON.stringify({ error: { code, message } }), code);
    };
    try {
      await logger.start(record);
      logged = true;
    } catch {
      res.setHeader('X-Request-Log-Status', 'unavailable');
      console.error(JSON.stringify({ event: 'request_log_start_failed', requestId: record.id }));
      return error(503, 'logging_unavailable', 'Request logging is unavailable. No upstream request was sent.');
    }
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');
      res.statusCode = 204; return complete();
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return error(405, 'method_not_allowed', 'Use GET. HEAD never sends an upstream request.');
    }
    if (!authorized(req.headers.authorization)) return error(401, 'unauthorized', 'Supply the converter API key in the Authorization: Bearer header.');
    const purpose = `${req.headers.purpose ?? ''} ${req.headers['sec-purpose'] ?? ''} ${req.headers['x-purpose'] ?? ''}`;
    if (/prefetch|prerender/i.test(purpose)) return error(400, 'prefetch_blocked', 'Prefetch requests do not trigger an upstream request.');
    try {
      const config = parseRequest(req.url);
      const upstream = await send(config);
      upstreamStatus = upstream.status;
      const result = renderUpstream(upstream, config.mode);
      res.statusCode = result.status;
      res.setHeader('Content-Type', result.type);
      res.setHeader('X-Upstream-Status', String(upstream.status));
      res.setHeader('X-Upstream-Content-Type', String(upstream.headers['content-type'] ?? 'application/octet-stream'));
      if (upstream.headers['content-encoding']) res.setHeader('X-Upstream-Content-Encoding', String(upstream.headers['content-encoding']));
      return complete(result.body);
    } catch (cause) {
      if (cause instanceof ProxyError) return error(cause.status, cause.code, cause.message);
      return error(500, 'internal_error', 'The converter could not process this request.');
    }
  };
}
export default createHandler();
