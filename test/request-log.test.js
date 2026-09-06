import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { requestRecord, createRequestLogger } from '../lib/request-log.js';
import { createHandler } from '../api/post.js';
import { ProxyError } from '../lib/proxy.js';

const target = (params = {}) => `/api/post?${new URLSearchParams({ url: 'https://example.com/post', ...params })}`;
const req = (params = {}, headers = {}) => ({ method: 'GET', url: target(params), headers });
const query = (record, key) => record.query.find(([name]) => name === key)?.[1];

test('logs request details while redacting credentials in nested JSON, URLs and headers', () => {
  const record = requestRecord(req({
    url: 'https://user:example-pass@example.com/path?token=example-token&mode=test',
    data: JSON.stringify({ message: 'retain me', nested: [{ password: 'example-pass', apiKey: 'example-key' }] }),
    headers: JSON.stringify({ Authorization: 'Bearer example-token', 'X-Test': 'retain me', Cookie: 'example-session' }),
    secret: 'example-secret',
  }, { authorization: 'Bearer example-incoming-key', cookie: 'example-incoming-cookie', referer: 'https://example.org/?token=example-referrer', 'x-vercel-protection-bypass': 'example-bypass', 'x-now-route-matches': 'example-raw-query', 'user-agent': 'agent-test' }));
  const serialized = JSON.stringify(record);
  for (const value of ['example-pass', 'example-token', 'example-key', 'example-secret', 'example-session', 'example-incoming-key', 'example-incoming-cookie', 'example-referrer', 'example-bypass', 'example-raw-query']) assert.ok(!serialized.includes(value), value);
  assert.match(serialized, /retain me/); assert.equal(record.headers['user-agent'], 'agent-test');
  assert.equal(query(record, 'headers').Authorization, '[REDACTED]');
  assert.equal(JSON.parse(query(record, 'data')).nested[0].password, '[REDACTED]');
});

test('form logging uses Content-Type regardless of parameter order; sent input is not mutated', () => {
  const request = req({ data: 'message=hello&api_key=example-secret', headers: '{"Content-Type":"application/x-www-form-urlencoded"}' });
  const original = request.url;
  const record = requestRecord(request);
  assert.equal(new URLSearchParams(query(record, 'data')).get('api_key'), '[REDACTED]');
  assert.equal(new URLSearchParams(query(record, 'data')).get('message'), 'hello');
  assert.equal(request.url, original);
});

test('malformed, duplicate, oversized, and hostile Unicode input stays loggable', () => {
  const malformed = requestRecord(req({ headers: '{"Authorization":"example-secret"', data: '{"token":"example-secret"' }));
  assert.ok(!JSON.stringify(malformed).includes('example-secret'));
  const duplicate = requestRecord({ ...req(), url: `${target()}&data=1&data=2` });
  assert.equal(duplicate.query.filter(([name]) => name === 'data').length, 2);
  const oversized = requestRecord(req({ data: 'z'.repeat(20000) }));
  assert.equal(oversized.truncated, true); assert.ok(JSON.stringify(oversized).length < 1000);
  const unicode = requestRecord(req({ data: '{"value":"\\u0000\\ud800"}', unknown: '\0' }, { 'x-test': '\ud800' }));
  assert.equal(query(unicode, 'unknown'), '\\u0000');
  assert.equal(unicode.headers['x-test'], '\ufffd');
  // Data is JSON text nested in JSONB: its backslash escape remains legal text.
  assert.equal(typeof query(unicode, 'data'), 'string');
});

test('plain text body is retained and incoming header storage is bounded', () => {
  const record = requestRecord(req({ data: 'hello agent', headers: '{"Content-Type":"text/plain"}' }, { huge: 'x'.repeat(20000) }));
  assert.equal(query(record, 'data'), 'hello agent'); assert.equal(record.truncated, true);
  assert.match(record.headers.huge, /OMITTED/);
});

test('unparseable bodies remain readable with best-effort credential redaction', () => {
  for (const data of ['hello agent', '{"message":"unfinished', '', 'message=hello']) {
    const request = req({ data });
    const original = request.url;
    assert.equal(query(requestRecord(request), 'data'), data);
    assert.equal(request.url, original);
  }
  for (const data of [
    '{"message":"hello", "token":"example-secret',
    '{"message":"hello", "\\u0074oken":{"value":"example-secret"}',
    "message: hello, 'password': 'example-secret'",
    'message=hello&api_key=example-secret',
  ]) {
    const logged = query(requestRecord(req({ data })), 'data');
    assert.match(logged, /hello/);
    assert.match(logged, /\[REDACTED\]$/);
    assert.ok(!logged.includes('example-secret'));
  }
});

async function serve(t, send, logger) {
  const server = createServer(createHandler(send, logger));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}`;
}
const upstream = () => ({ status: 201, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"created":true}') });

test('durably logs before forwarding and records the outcome before returning', async (t) => {
  const events = []; let startRecord; let outcome;
  const base = await serve(t, async (config) => {
    events.push('post'); assert.deepEqual(events, ['start', 'post']);
    assert.equal(config.headers.authorization, 'Bearer example-upstream-secret');
    return upstream();
  }, {
    start: async (record) => { startRecord = record; events.push('start'); },
    finish: async (id, result) => { assert.equal(id, startRecord.id); outcome = result; events.push('finish'); },
  });
  const response = await fetch(base + target({ headers: '{"Authorization":"Bearer example-upstream-secret"}' }));
  assert.equal(response.status, 201); assert.equal(response.headers.get('x-request-log-status'), 'complete');
  assert.equal(response.headers.get('x-request-id'), startRecord.id);
  assert.deepEqual(events, ['start', 'post', 'finish']);
  assert.equal(outcome.upstreamStatus, 201); assert.equal(outcome.httpStatus, 201);
  assert.equal(outcome.responseBytes, Buffer.byteLength('{"created":true}'));
  assert.ok(!JSON.stringify(startRecord).includes('example-upstream-secret'));
});

test('rejections, HEAD, OPTIONS, prefetch and upstream errors are also logged', async (t) => {
  const starts = []; const finishes = [];
  const base = await serve(t, async () => { throw new ProxyError(504, 'upstream_timeout', 'Timed out'); }, {
    start: async (record) => starts.push(record), finish: async (_id, result) => finishes.push(result),
  });
  const cases = [
    ['/api/post', {}, 400], [target({ url: 'https://127.0.0.1' }), {}, 403],
    [target(), { method: 'HEAD' }, 405], [target(), { method: 'OPTIONS' }, 204],
    [target(), { headers: { purpose: 'prefetch' } }, 400], [target(), {}, 504],
  ];
  for (const [url, options, status] of cases) {
    const response = await fetch(base + url, options); assert.equal(response.status, status); await response.arrayBuffer();
  }
  assert.equal(starts.length, cases.length); assert.equal(finishes.length, cases.length);
  assert.deepEqual(finishes.map((record) => record.httpStatus), cases.map((c) => c[2]));
  assert.equal(finishes[2].responseBytes, 0); // HEAD suppresses the error body.
  assert.equal(finishes[3].responseBytes, 0); // OPTIONS has no body.
  assert.equal(finishes.at(-1).errorCode, 'upstream_timeout');
});

test('logging outage fails closed without exposing database errors or sending a POST', async (t) => {
  const emitted = []; t.mock.method(console, 'error', (value) => emitted.push(value));
  let sent = false;
  const base = await serve(t, async () => { sent = true; return upstream(); }, {
    start: async () => { throw new Error('postgresql://secret-user:secret-password@db'); },
    finish: async () => assert.fail('Should not finish an unrecorded request'),
  });
  const response = await fetch(base + target()); const text = await response.text();
  assert.equal(response.status, 503); assert.equal(sent, false);
  assert.equal(response.headers.get('x-request-log-status'), 'unavailable');
  assert.equal(JSON.parse(text).error.code, 'logging_unavailable');
  assert.ok(!`${text}${emitted.join('')}`.includes('secret-password'));
});

test('outcome-write failure preserves the actual POST response and durable request ID', async (t) => {
  t.mock.method(console, 'error', () => {});
  let id;
  const base = await serve(t, async () => upstream(), {
    start: async (record) => { id = record.id; }, finish: async () => { throw new Error('database offline'); },
  });
  const response = await fetch(base + target());
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { created: true });
  assert.equal(response.headers.get('x-request-id'), id);
  assert.equal(response.headers.get('x-request-log-status'), 'request-only');
});

test('database logger parameterizes payloads and supplies a fresh deadline for each write', async () => {
  const calls = [];
  const logger = createRequestLogger({ connectionString: () => 'test-connection', client: () => ({ query: async (...args) => calls.push(args) }) });
  const record = requestRecord(req({ data: JSON.stringify({ message: "'; DROP TABLE request_logging.requests; --" }) }));
  await logger.start(record);
  await logger.finish(record.id, { httpStatus: 200, upstreamStatus: 200, errorCode: null, durationMs: 4, responseBytes: 2 });
  assert.equal(calls.length, 2);
  assert.ok(!calls[0][0].includes('DROP TABLE'));
  assert.ok(calls[0][1].some((value) => typeof value === 'string' && value.includes('DROP TABLE')));
  assert.notEqual(calls[0][2].fetchOptions.signal, calls[1][2].fetchOptions.signal);
  await assert.rejects(createRequestLogger({ connectionString: () => undefined }).start(record), /not configured/);
});

test('AI guide, logging disclosure, and usable examples exist without JavaScript', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const guide = await readFile(new URL('../public/llms.txt', import.meta.url), 'utf8');
  for (const content of [html, guide]) {
    assert.match(content, /AI agent/); assert.match(content, /Tyler Tracy/);
    assert.match(content, /benefit humanity/); assert.match(content, /curl --get/);
    assert.match(content, /response=json/); assert.match(content, /Neon/);
  }
  assert.ok(html.indexOf('Requests are logged') < html.indexOf('curl --get'));
});
