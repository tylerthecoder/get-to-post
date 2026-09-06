import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import builder from '../api/builder.js';
import { renderBuilder } from '../lib/builder.js';
import { MAX_URL_BYTES, parseRequest } from '../lib/proxy.js';
import { createHandler } from '../api/post.js';

const unescape = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[name]);
const links = (html) => [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)].map((match) => ({ href: unescape(match[1]), label: unescape(match[2].replace(/<[^>]*>/g, '')) }));
const find = (html, label) => {
  const result = links(html).find((item) => item.label === label);
  assert.ok(result, `Missing link: ${label}`);
  return result.href;
};
const requestState = (fields, edit = null) => ({ v: 1, fields: ['https://example.org/post', '', '{}', 'json', '15000'].map((value, i) => fields[i] ?? value), edit });
const stateUrl = (state, view = 'review', group = 'url') => `/builder?${new URLSearchParams({ state: Buffer.from(JSON.stringify(state)).toString('base64url'), view, group })}`;

test('a link-only client constructs the acceptance request; only final execution posts and logs', async (t) => {
  const sent = []; const logged = [];
  const post = createHandler(async (config) => {
    sent.push(config);
    return { status: 201, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"created":true}') };
  }, { start: async (record) => logged.push(record), finish: async () => {} });
  const server = createServer((req, res) => req.url.startsWith('/api/post?') ? post(req, res) : builder(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  let html; let currentUrl;
  async function visit(url) {
    assert.ok(url.startsWith('/builder'));
    currentUrl = url;
    const response = await fetch(base + url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
    assert.match(response.headers.get('x-robots-tag'), /noindex, nofollow/);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('set-cookie'), null);
    html = await response.text();
    assert.doesNotMatch(html, /<(script|form|input|button)\b/i);
    assert.equal(sent.length, 0); assert.equal(logged.length, 0);
  }
  const follow = (label) => visit(find(html, label));
  const append = async (text) => { for (const char of text) await follow(char); };
  await visit('/builder');
  assert.ok(!html.includes('httpbin'));
  assert.ok(!links(html).some((item) => item.href.startsWith('/api/post?')));
  await follow('Edit destination');
  await follow('https://');
  await append('httpbin');
  await follow('.org'); await follow('/');
  await append('post'); await follow('Done');
  await follow('Edit body'); await follow('{"');
  await append('message');
  await follow('\":\"');
  await append('hello');
  await follow('"}'); await follow('Done');
  await follow('Review request');
  const execute = find(html, 'Execute request');
  const params = new URL(execute, base).searchParams;
  assert.equal(params.get('url'), 'https://httpbin.org/post');
  assert.equal(params.get('data'), '{"message":"hello"}');
  assert.equal(params.get('headers'), '{}');
  assert.equal(params.get('response'), 'json');
  assert.equal(params.get('timeout'), '15000');
  assert.match(html, /Ready to execute/);
  assert.match(html, /rel="nofollow"/);
  // Fetching and prefetching review never execute. Prefetching Execute is still blocked by the original handler.
  const reviewUrl = currentUrl;
  for (const options of [{ method: 'HEAD' }, { headers: { purpose: 'prefetch' } }]) {
    const res = await fetch(base + reviewUrl, options); assert.equal(res.status, 200); await res.text();
  }
  assert.equal(sent.length, 0); assert.equal(logged.length, 0);
  const prefetch = await fetch(base + execute, { headers: { purpose: 'prefetch' } });
  assert.equal(prefetch.status, 400); await prefetch.text(); assert.equal(sent.length, 0);
  const response = await fetch(base + execute);
  assert.equal((await response.json()).body.created, true);
  assert.equal(sent.length, 1); assert.equal(logged.length, 2);
  assert.equal(sent[0].data, '{"message":"hello"}');
  assert.equal(sent[0].headers['content-type'], 'application/json');
});

test('arbitrary fields, Unicode, correction controls, and response selection work through rendered links', () => {
  let html = renderBuilder('/builder').html;
  const follow = (label) => { const result = renderBuilder(find(html, label)); assert.equal(result.status, 200); html = result.html; };
  function type(field, value) {
    follow(`Edit ${field}`); follow('Clear field');
    for (const char of value) {
      follow(({ ' ': 'Space', '\n': 'Newline', '\t': 'Tab' })[char] ?? char);
    }
    follow('Done');
  }
  const destination = 'https://node-17.example.net/v2/ingest?q=a%26b';
  const data = '<script>alert("x")</script>&\'\n\t';
  const headers = '{"Content-Type":"text/plain","X-Test":"a<&\\\""}';
  type('destination', destination); type('body', data); type('headers', headers);
  follow('Edit body'); follow('Unicode character');
  for (const digit of '1F680') follow(digit);
  follow('Append Unicode character'); follow('Back to all tokens');
  for (const label of ['https://', 'a', 'Z', '7', '&', '{"', 'Content-Type']) find(html, label);
  follow('Done');
  follow('Edit body'); follow('Backspace'); follow('Cancel editing'); // Cancel restores the rocket too.
  follow('Edit headers'); follow('Clear field'); follow('Cancel editing');
  follow('Edit timeout'); follow('Set 5000 ms'); follow('Done');
  follow('Change response mode'); follow('raw');
  follow('Review request');
  const config = parseRequest(find(html, 'Execute request'));
  assert.equal(config.target.href, destination);
  assert.equal(config.data, data + '🚀');
  assert.equal(config.headers['x-test'], 'a<&"');
  assert.equal(config.mode, 'raw'); assert.equal(config.timeout, 5000);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  follow('Edit request'); follow('Edit body'); follow('Backspace'); follow('Done'); follow('Review request');
  assert.equal(parseRequest(find(html, 'Execute request')).data, data);
  follow('Start over'); assert.ok(!html.includes('node-17'));
});

test('invalid complete requests cannot expose an Execute link; converter validation is preserved', () => {
  for (const fields of [
    { 0: 'http://example.org' }, { 0: 'https://127.0.0.1' }, { 0: 'https://[::1]' },
    { 0: 'https://user:pass@example.org' }, { 0: 'https://example.org:444' },
    { 2: '{' }, { 2: '[]' }, { 2: '{"Host":"example.org"}' }, { 2: '{"X-Test":3}' },
    { 4: '0' }, { 4: '20001' }, { 4: '5.5' }, { 1: '%'.repeat(4400) },
  ]) {
    const result = renderBuilder(stateUrl(requestState(fields)));
    assert.equal(result.status, 200);
    assert.match(result.html, /Request needs an edit/);
    assert.ok(!links(result.html).some((item) => item.href.startsWith('/api/post?')));
  }
});

test('malformed encodings, schemas, and action parameters fail closed without reflecting input', () => {
  const invalidStates = [null, [], { v: 1 }, requestState({}, [99, '', '']), requestState({}, [0, {}, '']),
    requestState({}, [0, '', '1234567']), requestState({ 3: 'execute' }), requestState({ 1: '\ud800' }),
    { ...requestState({}), extra: '<script>bad</script>' }, requestState({}, [0, '', 'GG']),
  ];
  const urls = ['/builder?state=', '/builder?state=***', '/builder?state=Zg==', '/builder?state=_w',
    '/builder?view=execute', '/builder?op=execute', '/builder?view=summary&view=review',
    '/builder?view=edit', '/builder?group=__proto__', ...invalidStates.map((state) => stateUrl(state)),
    stateUrl(requestState({}, [0, 'draft', '']), 'summary')];
  for (const url of urls) {
    const result = renderBuilder(url); assert.equal(result.status, 400, url);
    assert.doesNotMatch(result.html, /<script>|href="\/api\/post/);
  }
  assert.equal(renderBuilder('/builder?state=' + 'A'.repeat(MAX_URL_BYTES)).status, 414);
});

test('Unicode composer rejects surrogates and values outside Unicode; scalar deletion is whole-character', () => {
  for (const hex of ['D800', 'DFFF', '110000', 'FFFFFF', '']) {
    const result = renderBuilder(stateUrl(requestState({}, [1, '', hex]), 'edit', 'unicode'));
    assert.equal(result.status, 200); assert.ok(!links(result.html).some((item) => item.label === 'Append Unicode character'));
  }
  const html = renderBuilder(stateUrl(requestState({}, [1, 'a🚀', '']), 'edit')).html;
  const back = renderBuilder(find(html, 'Backspace')).html;
  const review = renderBuilder(find(back, 'Review request')).html;
  assert.equal(parseRequest(find(review, 'Execute request')).data, 'a');
});

test('every emitted builder link fits the limit, including at the encoding boundary', () => {
  let size = MAX_URL_BYTES;
  let url;
  do { url = stateUrl(requestState({ 1: 'x'.repeat(size--) }, [4, '15000', '']), 'edit', 'numbers'); } while (Buffer.byteLength(url) > MAX_URL_BYTES);
  const result = renderBuilder(url);
  assert.equal(result.status, 200); assert.match(result.html, /\(URL limit\)/);
  for (const item of links(result.html).filter((item) => item.href.startsWith('/builder'))) {
    assert.ok(Buffer.byteLength(item.href) <= MAX_URL_BYTES);
    const next = renderBuilder(item.href);
    assert.ok([200, 400].includes(next.status));
  }
});

test('builder handles HEAD and unsupported methods without cookies or execution', () => {
  for (const method of ['HEAD', 'POST', 'OPTIONS']) {
    const headers = {}; let body;
    const res = { setHeader: (key, value) => { headers[key] = value; }, end: (value) => { body = value; } };
    builder({ method, url: '/builder' }, res);
    assert.equal(res.statusCode, method === 'HEAD' ? 200 : 405);
    if (method === 'HEAD') assert.equal(body, undefined);
    assert.equal(headers['Cache-Control'], 'no-store, max-age=0');
    assert.match(headers['Content-Security-Policy'], /form-action 'none'/);
    assert.equal(headers['Set-Cookie'], undefined);
  }
});

test('the public builder route and discovery links are configured', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.ok(config.rewrites.some((rule) => rule.source === '/builder' && rule.destination === '/api/builder'));
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.ok(links(html).some((item) => item.href === '/builder'));
});

test('method presets and custom tokens reach review and execution; old links default to POST', () => {
  for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'CONNECT', 'PROPFIND']) {
    let html = renderBuilder(stateUrl(requestState({ 0: 'https://example.org/' }), 'summary')).html;
    const follow = (label) => { const result = renderBuilder(find(html, label)); assert.equal(result.status, 200); html = result.html; };
    follow('Edit method');
    if (method === 'PROPFIND') {
      follow('Clear field');
      for (const letter of method) follow(letter);
    } else follow(`Set ${method}`);
    follow('Done'); follow('Review request');
    assert.equal(parseRequest(find(html, 'Execute request')).method, method);
    assert.ok(html.includes(`<h3>${method} https://example.org/</h3>`));
    follow('Edit request'); follow('Edit method'); follow('Set DELETE'); follow('Cancel editing'); follow('Review request');
    assert.equal(parseRequest(find(html, 'Execute request')).method, method);
  }
  const old = renderBuilder(stateUrl(requestState({})));
  assert.equal(parseRequest(find(old.html, 'Execute request')).method, 'POST');
  const invalid = { v: 2, fields: [...requestState({}).fields, 'GET POST'], edit: null };
  assert.match(renderBuilder(stateUrl(invalid)).html, /Request needs an edit/);
  assert.ok(!links(renderBuilder(stateUrl(invalid)).html).some((item) => item.label === 'Execute request'));
  assert.equal(renderBuilder(stateUrl(requestState({}, [5, 'DELETE', '']), 'edit')).status, 400);
});
