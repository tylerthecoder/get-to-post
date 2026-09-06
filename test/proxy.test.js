import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { parseRequest, isPublicAddress, resolveDestination, requestUpstream, renderUpstream, authorized, MAX_RESPONSE_BYTES } from '../lib/proxy.js';
import { createHandler } from '../api/post.js';

const url = (params = {}) => `/api/post?${new URLSearchParams({ url: 'https://example.com/post', ...params })}`;
test('exact data and headers survive URL encoding', () => {
  const data = 'name=Tyler&text=plus+ percent% emoji🦊\nnext';
  const parsed = parseRequest(url({ data, headers: JSON.stringify({ 'Content-Type': 'text/plain', Authorization: 'Bearer example-test-value' }) }));
  assert.equal(parsed.data, data);
  assert.equal(parsed.headers['content-type'], 'text/plain');
  assert.equal(parsed.headers.authorization, 'Bearer example-test-value');
  assert.equal(parsed.headers['accept-encoding'], 'identity');
});
test('malformed parameters and protocol/header tricks fail before transport', () => {
  for (const params of [
    { url: 'http://example.com' }, { url: 'https://user:pass@example.com' },
    { url: 'https://example.com:8443/' }, { url: 'https://example.com/#secret' },
    { headers: '[]' }, { headers: 'null' }, { headers: '{broken' },
    { headers: '{"x-test":5}' }, { headers: '{"Host":"localhost"}' },
    { headers: '{"x-test":"hello\\r\\nInjected: yes"}' },
    { headers: '{"Accept-Encoding":"gzip"}' }, { headers: '{"X-Forwarded-For":"127.0.0.1"}' },
    { timeout: '20001' }, { timeout: 'NaN' }, { timeout: '0' }, { response: 'wat' }, { unknown: 'value' },
  ]) assert.throws(() => parseRequest(url(params)), { status: 400 });
  assert.throws(() => parseRequest(`${url()}&url=https://other.example`), { code: 'duplicate_parameter' });
  assert.throws(() => parseRequest(url({ data: 'x'.repeat(13000) })), { status: 414 });
});
test('blocks private, mapped, transition, reserved and obfuscated IP destinations', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '192.0.2.1', '198.18.0.1', '::1', '::', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '64:ff9b::7f00:1', '2002:7f00:1::']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  for (const destination of ['https://localhost', 'https://foo.local', 'https://127.1', 'https://2130706433', 'https://0x7f000001', 'https://[::ffff:127.0.0.1]']) {
    assert.throws(() => parseRequest(url({ url: destination })), { status: 403 });
  }
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});
test('mixed public/private DNS records are rejected', async () => {
  await assert.rejects(resolveDestination('example.com', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]), { status: 403 });
});
test('connection pins vetted DNS and sends exactly one POST without following redirects', async () => {
  let calls = 0; let dnsCalls = 0;
  const config = parseRequest(url({ data: 'é & +' }));
  const upstream = await requestUpstream(config, {
    resolver: async () => { dnsCalls++; return [{ address: '8.8.8.8', family: 4 }]; },
    transport: (target, options, callback) => {
      calls++; assert.equal(target.hostname, 'example.com'); assert.equal(options.method, 'POST'); assert.equal(options.agent, false);
      assert.equal(options.headers['content-length'], Buffer.byteLength('é & +'));
      options.lookup('example.com', {}, (err, address, family) => { assert.equal(err, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
      options.lookup('example.com', { all: true }, (err, records) => assert.deepEqual(records, [{ address: '8.8.8.8', family: 4 }]));
      const request = new EventEmitter(); request.destroy = () => {};
      request.end = (data) => {
        assert.equal(data, 'é & +');
        const response = new EventEmitter(); response.statusCode = 302; response.headers = { location: 'https://127.0.0.1/' };
        callback(response); response.emit('data', Buffer.from('redirect')); response.emit('end');
      };
      return request;
    },
  });
  assert.equal(upstream.status, 302); assert.equal(calls, 1); assert.equal(dnsCalls, 1);
});
test('blocks overlarge response while reading', async () => {
  await assert.rejects(requestUpstream(parseRequest(url()), {
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: (_target, _options, callback) => {
      const request = new EventEmitter(); request.destroy = () => {};
      request.end = () => {
        const response = new EventEmitter(); response.destroy = () => {}; response.statusCode = 200; response.headers = {};
        callback(response); response.emit('data', Buffer.alloc(MAX_RESPONSE_BYTES + 1)); response.emit('end');
      };
      return request;
    },
  }), { code: 'response_too_large' });
});
test('deadline also covers stalled DNS', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(requestUpstream(parseRequest(url({ timeout: '5' })), { resolver: () => new Promise(() => {}) }), { status: 504 }); }
  finally { clearTimeout(keepAlive); }
});
test('response rendering preserves data without serving active HTML or setting cookies', () => {
  const upstream = { status: 418, headers: { 'content-type': 'text/html', 'set-cookie': ['session=abc'], location: 'https://example.com' }, body: Buffer.from('<script>alert(1)</script>') };
  const raw = renderUpstream(upstream, 'raw');
  assert.equal(raw.status, 418); assert.equal(raw.type, 'text/plain; charset=utf-8'); assert.deepEqual(raw.body, upstream.body);
  const envelope = JSON.parse(renderUpstream(upstream, 'json').body);
  assert.equal(envelope.status, 418); assert.equal(envelope.headers['set-cookie'], undefined); assert.equal(envelope.body, upstream.body.toString());
  const binary = JSON.parse(renderUpstream({ ...upstream, headers: {}, body: Buffer.from([0, 255, 128]) }, 'json').body);
  assert.equal(binary.encoding, 'base64'); assert.deepEqual(Buffer.from(binary.body, 'base64'), Buffer.from([0, 255, 128]));
  const json = JSON.parse(renderUpstream({ ...upstream, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"ok":true}') }, 'json').body);
  assert.deepEqual(json.body, { ok: true });
});
test('optional API key requires exact incoming bearer authorization', () => {
  assert.equal(authorized(undefined, 'test-key'), false);
  assert.equal(authorized('Bearer bad', 'test-key'), false);
  assert.equal(authorized('Bearer test-key', 'test-key'), true);
  assert.equal(authorized(undefined, ''), true);
});
test('HTTP handler: no HEAD/prefetch POSTs, CORS, no cache, raw status, and JSON errors', async (t) => {
  let calls = 0;
  const server = createServer(createHandler(async (config) => {
    calls++; assert.equal(config.headers.cookie, undefined);
    return { status: 201, headers: { 'content-type': 'application/json', 'set-cookie': ['bad=1'] }, body: Buffer.from('{"ok":true}') };
  }, { start: async () => {}, finish: async () => {} }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [options, status] of [[{ method: 'HEAD' }, 405], [{ method: 'POST' }, 405], [{ method: 'OPTIONS' }, 204], [{ headers: { 'sec-purpose': 'prefetch' } }, 400]]) {
    const response = await fetch(base + url(), options); assert.equal(response.status, status); await response.arrayBuffer();
  }
  assert.equal(calls, 0);
  const response = await fetch(base + url(), { headers: { Cookie: 'private=incoming' } });
  assert.equal(response.status, 201); assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('set-cookie'), null); assert.equal(calls, 1);
  const invalid = await fetch(`${base}/api/post`); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'invalid_url');
});

test('method defaults, normalization, extension tokens, and malformed methods', () => {
  assert.equal(parseRequest(url()).method, 'POST');
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND', 'X-CUSTOM']) {
    assert.equal(parseRequest(url({ method: method.toLowerCase(), url: 'https://example.com/' })).method, method);
  }
  for (const method of ['', ' GET', 'GET ', 'GET\r\nHost: evil', 'GET/POST', 'GET\n', 'GET\r', 'GÉT', 'GET\0']) {
    assert.throws(() => parseRequest(url({ method })), { code: 'invalid_method' });
  }
  assert.throws(() => parseRequest(`${url({ method: 'PUT' })}&method=DELETE`), { code: 'duplicate_parameter' });
  for (const method of ['TRACE', 'CONNECT']) {
    assert.throws(() => parseRequest(url({ method, data: 'body' })), { code: 'invalid_data' });
  }
  for (const target of ['https://example.com/path', 'https://example.com/?q=1']) {
    assert.throws(() => parseRequest(url({ method: 'CONNECT', url: target })), { code: 'invalid_url' });
  }
});

test('all standard and extension methods traverse the handler, logging, and real HTTP transport', async (t) => {
  const { request } = await import('node:http');
  const received = [];
  const upstream = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ method: req.method, body: Buffer.concat(chunks).toString(), headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'text/plain', 'X-Method': req.method });
    res.end(req.method === 'HEAD' ? undefined : 'response');
  });
  upstream.on('connect', (req, socket) => {
    received.push({ method: req.method, path: req.url, headers: req.headers });
    socket.end('HTTP/1.1 200 Connection Established\r\nX-Method: CONNECT\r\n\r\n');
  });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  t.after(() => upstream.close());
  const records = []; const outcomes = [];
  const server = createServer(createHandler((config) => requestUpstream(config, {
    resolver: async () => [{ address: '8.8.8.8', family: 4 }],
    // Only this test transport redirects a vetted destination to a loopback fixture.
    transport: (_target, options, callback) => request({ ...options, hostname: '127.0.0.1', port: upstream.address().port }, callback),
  }), { start: async (record) => records.push(record), finish: async (_id, outcome) => outcomes.push(outcome) }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND']) {
    const data = ['TRACE', 'CONNECT'].includes(method) ? '' : 'é & +';
    const response = await fetch(base + url({ method, url: 'https://example.com/', data, response: 'json' }));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, 200);
    assert.equal(result.headers['x-method'], method);
    assert.equal(result.body, ['HEAD', 'CONNECT'].includes(method) ? '' : 'response');
    const sent = received.at(-1);
    assert.equal(sent.method, method);
    if (method === 'CONNECT') assert.equal(sent.path, 'example.com:443');
    else assert.equal(sent.body, data);
    if (['TRACE', 'CONNECT'].includes(method)) assert.equal(sent.headers['content-length'], undefined);
    else assert.equal(sent.headers['content-length'], String(Buffer.byteLength(data)));
    assert.ok(records.at(-1).query.some(([key, value]) => key === 'method' && value === method));
    assert.equal(outcomes.at(-1).upstreamStatus, 200);
  }
  assert.equal(received.length, 10);
  for (const options of [{ method: 'HEAD' }, { method: 'OPTIONS' }, { headers: { purpose: 'prefetch' } }]) {
    const response = await fetch(base + url({ method: 'DELETE' }), options);
    await response.arrayBuffer();
  }
  assert.equal(received.length, 10);
});

test('CONNECT discards tunnel bytes and closes the socket; upgrades fail promptly', async () => {
  for (const event of ['connect', 'upgrade']) {
    let destroyed = false;
    const result = requestUpstream(parseRequest(url({ method: event === 'connect' ? 'CONNECT' : 'GET', url: 'https://example.com/' })), {
      resolver: async () => [{ address: '8.8.8.8', family: 4 }],
      transport: (_target, _options, _callback) => {
        const request = new EventEmitter();
        request.end = () => request.emit(event, { statusCode: 200, headers: {} }, { destroy: () => { destroyed = true; } }, Buffer.from('tunnel bytes'));
        return request;
      },
    });
    if (event === 'connect') assert.equal((await result).body.length, 0);
    else await assert.rejects(result, { code: 'unsupported_upgrade' });
    assert.equal(destroyed, true);
  }
});
