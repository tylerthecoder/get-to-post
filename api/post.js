import { authorized, parseRequest, postUpstream, renderUpstream, ProxyError } from '../lib/proxy.js';

export function createHandler(send = postUpstream) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'X-Upstream-Status, X-Upstream-Content-Type, X-Upstream-Content-Encoding');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox; frame-ancestors 'none'");
    const error = (status, code, message) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: { code, message } }));
    };
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization');
      res.statusCode = 204; return res.end();
    }
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET, OPTIONS');
      return error(405, 'method_not_allowed', 'Use GET. HEAD never sends an upstream request.');
    }
    if (!authorized(req.headers.authorization)) return error(401, 'unauthorized', 'Supply the converter API key in the Authorization: Bearer header.');
    const purpose = `${req.headers.purpose ?? ''} ${req.headers['sec-purpose'] ?? ''} ${req.headers['x-purpose'] ?? ''}`;
    if (/prefetch|prerender/i.test(purpose)) return error(400, 'prefetch_blocked', 'Prefetch requests do not trigger a POST.');
    try {
      const config = parseRequest(req.url);
      const upstream = await send(config);
      const result = renderUpstream(upstream, config.mode);
      res.statusCode = result.status;
      res.setHeader('Content-Type', result.type);
      res.setHeader('X-Upstream-Status', String(upstream.status));
      res.setHeader('X-Upstream-Content-Type', String(upstream.headers['content-type'] ?? 'application/octet-stream'));
      if (upstream.headers['content-encoding']) res.setHeader('X-Upstream-Content-Encoding', String(upstream.headers['content-encoding']));
      res.end(result.body);
    } catch (cause) {
      if (cause instanceof ProxyError) return error(cause.status, cause.code, cause.message);
      return error(500, 'internal_error', 'The converter could not process this request.');
    }
  };
}
export default createHandler();
