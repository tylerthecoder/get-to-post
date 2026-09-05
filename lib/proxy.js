import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import ipaddr from 'ipaddr.js';

export const MAX_URL_BYTES = 12 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
export class ProxyError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new ProxyError(status, code, message); };
const blockedHeaders = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'expect', 'trailer', 'te', 'keep-alive', 'accept-encoding', 'via', 'forwarded']);

export function isPublicAddress(address) {
  try {
    const parsed = ipaddr.parse(address);
    // Reject transition and mapped addresses as well as all special-use ranges.
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export function parseRequest(requestUrl) {
  if (Buffer.byteLength(requestUrl) > MAX_URL_BYTES) fail(414, 'url_too_long', 'Encoded request URL must be at most 12 KiB.');
  const params = new URL(requestUrl, 'https://converter.invalid').searchParams;
  const allowed = new Set(['url', 'data', 'headers', 'response', 'timeout']);
  for (const key of params.keys()) {
    if (!allowed.has(key)) fail(400, 'unknown_parameter', `Unknown parameter: ${key}`);
    if (params.getAll(key).length !== 1) fail(400, 'duplicate_parameter', `Supply ${key} only once.`);
  }
  let target;
  try { target = new URL(params.get('url')); } catch { fail(400, 'invalid_url', 'Supply an absolute HTTPS destination in url.'); }
  if (target.protocol !== 'https:' || target.username || target.password || target.hash) fail(400, 'invalid_url', 'Use HTTPS without embedded credentials or a fragment.');
  if (target.port && target.port !== '443') fail(400, 'invalid_port', 'Only HTTPS port 443 is supported.');
  const hostname = target.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || /\.(localhost|local|internal|home|test|invalid)$/.test(hostname)) fail(403, 'blocked_destination', 'Destination must be on the public internet.');
  if (ipaddr.isValid(hostname) && !isPublicAddress(hostname)) fail(403, 'blocked_destination', 'Private and special-use IP addresses are blocked.');
  let supplied;
  try { supplied = JSON.parse(params.get('headers') ?? '{}'); } catch { fail(400, 'invalid_headers', 'headers must be a JSON object with string values.'); }
  if (!supplied || Array.isArray(supplied) || typeof supplied !== 'object' || Object.keys(supplied).length > 32) fail(400, 'invalid_headers', 'headers must be an object with at most 32 string entries.');
  const headers = Object.create(null);
  headers['content-type'] = 'application/json';
  for (const [name, value] of Object.entries(supplied)) {
    const key = name.toLowerCase();
    if (typeof value !== 'string') fail(400, 'invalid_headers', 'Every header value must be a string.');
    if (blockedHeaders.has(key) || key.startsWith('proxy-') || key.startsWith('x-forwarded-') || key.startsWith('x-vercel-')) fail(400, 'blocked_header', `Header ${name} cannot be overridden.`);
    try { validateHeaderName(name); validateHeaderValue(name, value); } catch { fail(400, 'invalid_headers', 'Invalid header name or value.'); }
    if (Object.keys(headers).includes(key) && key !== 'content-type') fail(400, 'invalid_headers', 'Header names must be unique ignoring case.');
    headers[key] = value;
  }
  headers['accept-encoding'] = 'identity';
  const mode = params.get('response') ?? 'raw';
  if (!['raw', 'json'].includes(mode)) fail(400, 'invalid_response', 'response must be raw or json.');
  const timeout = Number(params.get('timeout') ?? 15000);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 20000) fail(400, 'invalid_timeout', 'timeout must be an integer from 1 to 20000 milliseconds.');
  return { target, hostname, headers, data: params.get('data') ?? '', mode, timeout };
}

export async function resolveDestination(hostname, resolver = lookup) {
  const addresses = ipaddr.isValid(hostname)
    ? [{ address: hostname, family: ipaddr.parse(hostname).kind() === 'ipv4' ? 4 : 6 }]
    : await resolver(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) fail(403, 'blocked_destination', 'Destination resolves to a private or special-use address.');
  return addresses.find(({ family }) => family === 4) ?? addresses[0];
}

export function authorized(authorization, secret = process.env.PROXY_API_KEY) {
  if (!secret) return true;
  const actual = Buffer.from(authorization ?? '');
  const expected = Buffer.from(`Bearer ${secret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function postUpstream(config, { resolver = lookup, transport = https.request } = {}) {
  const signal = AbortSignal.timeout(config.timeout);
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new ProxyError(504, 'upstream_timeout', 'Upstream request timed out. It may already have processed the POST; do not retry blindly.'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([aborted, (async () => {
      const pinned = await resolveDestination(config.hostname, resolver);
      signal.throwIfAborted();
      return await new Promise((resolve, reject) => {
        const request = transport(config.target, {
          method: 'POST', agent: false, signal,
          headers: { ...config.headers, 'content-length': Buffer.byteLength(config.data) },
          // DNS is checked once, then the connection uses only the vetted IP.
          // The original hostname remains in Host and TLS certificate verification.
          lookup: (_hostname, options, callback) => options.all
            ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family),
        }, (response) => {
          const chunks = []; let size = 0;
          response.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              const error = new ProxyError(502, 'response_too_large', 'Upstream response exceeds 1 MiB.');
              reject(error); response.destroy(); request.destroy();
            } else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
        });
        request.on('error', reject);
        request.end(config.data);
      });
    })()]);
  } catch (error) {
    if (error instanceof ProxyError) throw error;
    if (signal.aborted) fail(504, 'upstream_timeout', 'Upstream request timed out. It may already have processed the POST; do not retry blindly.');
    fail(502, 'upstream_failed', 'Could not complete the upstream HTTPS request.');
  } finally { signal.removeEventListener('abort', onAbort); }
}

export function renderUpstream(upstream, mode) {
  const originalType = String(upstream.headers['content-type'] ?? 'application/octet-stream');
  const mediaType = originalType.split(';')[0].trim().toLowerCase();
  const isJson = mediaType === 'application/json' || mediaType.endsWith('+json');
  const encoded = upstream.headers['content-encoding'] && upstream.headers['content-encoding'] !== 'identity';
  if (mode === 'json') {
    const textual = !encoded && (isJson || mediaType.startsWith('text/') || mediaType.includes('xml') || mediaType === 'application/x-www-form-urlencoded');
    let body = upstream.body.toString(textual ? 'utf8' : 'base64');
    if (isJson && !encoded) { try { body = JSON.parse(body); } catch { /* Preserve invalid JSON as text. */ } }
    const headers = Object.fromEntries(Object.entries(upstream.headers).filter(([key]) => !['set-cookie', 'set-cookie2'].includes(key)));
    return { status: 200, type: 'application/json; charset=utf-8', body: JSON.stringify({ status: upstream.status, headers, encoding: textual ? 'utf8' : 'base64', body }) };
  }
  // Do not turn this origin into a host for arbitrary upstream HTML/JS or redirects.
  return {
    status: upstream.status,
    type: encoded ? 'application/octet-stream' : isJson ? 'application/json; charset=utf-8' : mediaType.startsWith('text/') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
    body: upstream.body,
  };
}
