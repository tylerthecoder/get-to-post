import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { parseChunkRequest, createChunkStore, CHUNK_BYTES, MAX_PAYLOAD_BYTES } from '../lib/chunks.js';
import { createChunkHandler } from '../api/chunks.js';
import { ProxyError } from '../lib/proxy.js';

const token = () => randomBytes(32).toString('hex');
const digest = (body) => createHash('sha256').update(body).digest('hex');
const url = (params) => `/api/chunks?${new URLSearchParams(params)}`;
const create = (body, key = token(), extra = {}) => ({ action: 'create', token: key, url: 'https://example.com/post',
  bytes: String(body.length), chunks: String(Math.ceil(body.length / CHUNK_BYTES)), sha256: digest(body),
  expires: String(Math.floor(Date.now() / 1000) + 890), ...extra });
const logger = { start: async () => {}, finish: async () => {} };
const ok = { status: 201, headers: { 'content-type': 'text/plain' }, body: Buffer.from('sent') };

test('parser bounds bytes, chunks, encoding, options, tokens, and URLs before DB work', () => {
  const body = Buffer.from('a'); const good = create(body);
  assert.equal(parseChunkRequest(url(good)).bytes, 1);
  for (const patch of [{ bytes: '262145' }, { bytes: '0' }, { chunks: '0' }, { chunks: '65' },
    { bytes: '1e3' }, { bytes: '-1' }, { sha256: 'x' }, { token: 'abc' }, { expires: '' },
    { data: 'unbound body' }, { url: 'https://localhost' }, { headers: '{"host":"x"}' }]) {
    assert.throws(() => parseChunkRequest(url({ ...good, ...patch })));
  }
  assert.throws(() => parseChunkRequest(url(good) + '&action=create'));
  assert.throws(() => parseChunkRequest(url({ ...good, headers: 'x'.repeat(13000) })), { status: 414 });
  for (const chunk of ['', 'YQ=', 'YR', 'a', 'a'.repeat(5463)]) {
    assert.throws(() => parseChunkRequest(url({ action: 'put', token: good.token, index: '0', chunk })));
  }
  assert.deepEqual(parseChunkRequest(url({ action: 'put', token: good.token, index: '0', chunk: 'YQ' })).data, body);
});

test('upload database invariants and HTTP lifecycle', async (t) => {
  // CI uses real PostgreSQL with a connection pool to exercise cross-connection
  // contention; the default local runner uses the same PostgreSQL SQL in WASM.
  const db = process.env.TEST_DATABASE_URL ? new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 12 }) : new PGlite();
  const exec = (text) => db.exec ? db.exec(text) : db.query(text);
  const migration = await readFile(new URL('../db/002-chunk-uploads.sql', import.meta.url), 'utf8');
  // Exercise the single-statement DO wrapper used by the Neon setup script too.
  await exec(`DO $migration$ BEGIN ${migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '')} END $migration$;`);
  t.after(async () => { await exec('DROP SCHEMA chunk_uploads CASCADE'); await (db.close ? db.close() : db.end()); });
  const store = createChunkStore({ connectionString: () => 'local-test', client: () => ({ query: async (query, values) => (await db.query(query, values.map((v, i) => db.exec && i === 7 && v ? Buffer.from(v.slice(2), 'hex') : v))).rows }) });
  const run = (params) => store.operate(parseChunkRequest(url(params)));
  const reset = () => exec("TRUNCATE chunk_uploads.parts, chunk_uploads.uploads; UPDATE chunk_uploads.budget SET enabled=true, minute_start='-infinity', minute_ops=0,day_start='-infinity',day_ops=0,day_creates=0,day_executions=0,day_bytes=0");
  const putAll = async (body, key) => {
    for (let index = 0; index < Math.ceil(body.length / CHUNK_BYTES); index++) {
      await run({ action: 'put', token: key, index, chunk: body.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64url') });
    }
  };
  const claim = (key) => store.operate({ action: 'claim', tokenHash: digest(key) });

  await t.test('out-of-order immutable chunks, exact binary bytes, digest and one atomic claim', async () => {
    const body = randomBytes(8193); const params = create(body);
    const first = await run(params);
    assert.deepEqual(await run(params), first);
    await assert.rejects(run({ ...params, url: 'https://example.org/' }), { code: 'upload_conflict' });
    await assert.rejects(claim(params.token), { code: 'upload_incomplete' });
    const last = { action: 'put', token: params.token, index: '2', chunk: body.subarray(8192).toString('base64url') };
    await run(last); await run(last);
    await assert.rejects(run({ ...last, chunk: Buffer.from([body[8192] ^ 255]).toString('base64url') }), { code: 'chunk_conflict' });
    await assert.rejects(run({ ...last, index: '3' }), { code: 'invalid_chunk' });
    await assert.rejects(run({ ...last, index: '0' }), { code: 'invalid_chunk' });
    await putAll(body, params.token);
    const claims = await Promise.allSettled(Array.from({ length: 10 }, () => claim(params.token)));
    assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
    const winner = claims.find(x => x.status === 'fulfilled').value;
    assert.deepEqual(Buffer.from(winner.body, 'base64'), body);
    assert.equal((await run({ action: 'status', token: params.token })).state, 'claimed');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM chunk_uploads.parts')).rows[0].n, 0);
    await assert.rejects(run(last), { code: 'upload_consumed' });
    assert.equal((await run(params)).state, 'claimed');
    await store.operate({ action: 'finish', tokenHash: digest(params.token) });
    await assert.rejects(claim(params.token), { code: 'upload_consumed' });
    const bad = create(Buffer.from('a')); await run(bad);
    await putAll(Buffer.from('b'), bad.token);
    await assert.rejects(claim(bad.token), { code: 'digest_mismatch' });
  });

  await t.test('maximum payload succeeds; capacity and quotas cannot race past their bounds', async () => {
    await reset();
    const body = Buffer.alloc(MAX_PAYLOAD_BYTES, 123); const params = create(body);
    await run(params); await putAll(body, params.token);
    assert.deepEqual(Buffer.from((await claim(params.token)).body, 'base64'), body);
    await reset();
    await Promise.allSettled(Array.from({ length: 40 }, () => run(create(Buffer.from('x')))));
    const count = (await db.query('SELECT count(*)::int AS n FROM chunk_uploads.uploads')).rows[0].n;
    assert.ok(count <= 32 && count > 0);
    // Fill sequentially if lock timeouts limited the concurrent batch.
    for (let i = count; i < 32; i++) await run(create(Buffer.from('x')));
    await assert.rejects(run(create(Buffer.from('x'))), { code: 'upload_capacity' });
    await reset();
    await exec('UPDATE chunk_uploads.budget SET day_creates=63, day_start=clock_timestamp()');
    const creates = await Promise.allSettled(Array.from({ length: 8 }, () => run(create(Buffer.from('x')))));
    assert.equal(creates.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal((await db.query('SELECT day_creates FROM chunk_uploads.budget')).rows[0].day_creates, 64);
    await reset();
    await exec('UPDATE chunk_uploads.budget SET day_bytes=16777215, day_start=clock_timestamp()');
    await assert.rejects(run(create(Buffer.from('xx'))), { code: 'upload_daily_limit' });
    await run(create(Buffer.from('x')));
    await assert.rejects(run(create(Buffer.from('x'))), { code: 'upload_daily_limit' });
  });

  await t.test('database rejects oversized input independently of the HTTP parser', async () => {
    await reset();
    const p = parseChunkRequest(url(create(Buffer.from('x'))));
    for (const patch of [{ bytes: 262145 }, { bytes: -1 }, { chunks: 65 }, { request: 'x'.repeat(8193) },
      { digest: 'bad' }, { expires: 4102444801 }]) await assert.rejects(store.operate({ ...p, ...patch }), { code: 'invalid_upload' });
    await store.operate(p);
    await assert.rejects(store.operate({ action: 'put', tokenHash: p.tokenHash, index: 0, data: Buffer.alloc(4097) }), { code: 'invalid_upload' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM chunk_uploads.parts')).rows[0].n, 0);
  });

  await t.test('expiry is fixed, expired create URLs cannot recreate, and cleanup is bounded', async () => {
    await reset(); const params = create(Buffer.from('x'));
    const first = await run(params); assert.equal((await run(params)).expiresAt, first.expiresAt);
    await assert.rejects(run({ ...params, expires: String(Math.floor(Date.now() / 1000) + 901) }), { code: 'invalid_expiry' });
    await assert.rejects(run({ ...params, expires: '1' }), { code: 'invalid_expiry' });
    await putAll(Buffer.from('x'), params.token);
    await exec("UPDATE chunk_uploads.uploads SET expires_at=clock_timestamp()+interval '30 seconds'");
    await assert.rejects(claim(params.token), { code: 'upload_expiring' });
    await exec("UPDATE chunk_uploads.uploads SET expires_at=clock_timestamp()-interval '1 second'");
    await assert.rejects(run({ action: 'status', token: params.token }), { code: 'upload_not_found' });
    assert.equal((await db.query('SELECT count(*)::int AS n FROM chunk_uploads.parts')).rows[0].n, 0);
    assert.equal((await db.query('SELECT day_creates FROM chunk_uploads.budget')).rows[0].day_creates, 1);
  });

  await t.test('invalid lookups consume fixed global rate budgets; completion can release saturated execution slots', async () => {
    await reset();
    const keys = [];
    for (let i = 0; i < 5; i++) { const p = create(Buffer.from('x')); keys.push(p.token); await run(p); await putAll(Buffer.from('x'), p.token); }
    for (const key of keys.slice(0, 4)) await claim(key);
    await assert.rejects(claim(keys[4]), { code: 'execution_capacity' });
    await exec('UPDATE chunk_uploads.budget SET minute_ops=239');
    await assert.rejects(run({ action: 'status', token: token() }), { code: 'upload_not_found' });
    await assert.rejects(run({ action: 'status', token: keys[0] }), { code: 'upload_rate_limited' });
    await store.operate({ action: 'finish', tokenHash: digest(keys[0]) });
    await exec("UPDATE chunk_uploads.budget SET minute_start=clock_timestamp()-interval '61 seconds'");
    await exec('UPDATE chunk_uploads.budget SET day_executions=64');
    await assert.rejects(claim(keys[4]), { code: 'upload_daily_limit' });
    await exec('UPDATE chunk_uploads.budget SET day_executions=63');
    await claim(keys[4]);
    assert.equal((await db.query('SELECT day_executions FROM chunk_uploads.budget')).rows[0].day_executions, 64);
    await exec('UPDATE chunk_uploads.budget SET day_ops=6000');
    await assert.rejects(run({ action: 'status', token: keys[0] }), { code: 'upload_daily_limit' });
    await exec("UPDATE chunk_uploads.budget SET day_start=clock_timestamp()-interval '25 hours'");
    assert.equal((await run({ action: 'status', token: keys[0] })).state, 'done');
    await exec('UPDATE chunk_uploads.budget SET enabled=false');
    await assert.rejects(run(create(Buffer.from('x'))), { code: 'uploads_disabled' });
  });

  await t.test('role can only call the bounded function, never read/write tables or logs', async () => {
    await reset();
    await exec(`CREATE ROLE chunk_test_runtime; GRANT USAGE ON SCHEMA chunk_uploads TO chunk_test_runtime;
      GRANT EXECUTE ON FUNCTION chunk_uploads.operate(text,text,text,integer,integer,text,integer,bytea,bigint) TO chunk_test_runtime`);
    const connection = db.connect ? await db.connect() : db;
    try {
      await connection.query('SET ROLE chunk_test_runtime');
      for (const query of ['SELECT * FROM chunk_uploads.uploads', 'SELECT * FROM chunk_uploads.parts',
        'UPDATE chunk_uploads.budget SET day_ops=0', 'DELETE FROM chunk_uploads.uploads',
        'INSERT INTO chunk_uploads.budget DEFAULT VALUES']) await assert.rejects(connection.query(query), { code: '42501' });
      const result = await connection.query("SELECT chunk_uploads.operate('status',$1) AS result", [digest(token())]);
      assert.equal(result.rows[0].result.error, 'upload_not_found');
    } finally {
      await connection.query('RESET ROLE'); if (connection.release) connection.release();
      await exec('DROP OWNED BY chunk_test_runtime; DROP ROLE chunk_test_runtime');
    }
  });

  await t.test('HTTP executes once through logging and existing proxy, guards methods and omits payload logs', async () => {
    await reset(); let sends = 0; const records = [];
    const body = randomBytes(9000); const params = create(body, token(), { response: 'raw' });
    const server = createServer(createChunkHandler({ enabled: () => true, store,
      send: async config => { sends++; assert.deepEqual(config.data, body); return ok; },
      logger: { start: async record => records.push(record), finish: async () => {} } }));
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      for (const [options, expected] of [[{ method: 'HEAD' }, 405], [{ method: 'POST' }, 405], [{ method: 'OPTIONS' }, 204], [{ headers: { 'sec-purpose': 'prefetch' } }, 400]]) {
        const response = await fetch(base + url(params), options); assert.equal(response.status, expected); await response.arrayBuffer();
      }
      assert.equal((await db.query('SELECT count(*)::int AS n FROM chunk_uploads.uploads')).rows[0].n, 0);
      const created = await fetch(base + url(params)); assert.equal(created.status, 200); await created.arrayBuffer();
      await putAll(body, params.token);
      const responses = await Promise.all([fetch(base + url({ action: 'execute', token: params.token })), fetch(base + url({ action: 'execute', token: params.token }))]);
      assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
      for (const r of responses) { assert.match(r.headers.get('cache-control'), /no-store/); await r.arrayBuffer(); }
      assert.equal(sends, 1); assert.equal(records.length, 1);
      assert.ok(!JSON.stringify(records).includes(params.token));
      assert.ok(!JSON.stringify(records).includes(body.toString('base64')));
      assert.equal(records[0].path, '/api/chunks');
      assert.ok(records[0].query.some(([key, value]) => key === 'url' && value === params.url));
    } finally { server.close(); }
  });

  await t.test('lost claim reply and upstream timeout never reopen an upload; failed finish retains a bounded lease', async () => {
    for (const failure of ['claim-reply', 'upstream', 'finish']) {
      await reset(); const params = create(Buffer.from('x')); await run(params); await putAll(Buffer.from('x'), params.token);
      let sends = 0;
      const unreliableStore = { operate: async input => {
        if (failure === 'finish' && input.action === 'finish') throw new Error('lost completion');
        const result = await store.operate(input);
        if (failure === 'claim-reply' && input.action === 'claim') throw new Error('lost claim reply');
        return result;
      } };
      const handler = createChunkHandler({ enabled: () => true, store: unreliableStore, logger,
        send: async () => { sends++; if (failure === 'upstream') throw new ProxyError(504, 'upstream_timeout', 'unknown outcome'); return ok; } });
      const response = () => ({ statusCode: 200, setHeader() {}, end(body) { this.body = body; } });
      const req = { method: 'GET', headers: {}, url: url({ action: 'execute', token: params.token }) };
      await handler(req, response()); const second = response(); await handler(req, second);
      assert.equal(second.statusCode, 409); assert.equal(sends, failure === 'claim-reply' ? 0 : 1);
      const status = await run({ action: 'status', token: params.token });
      assert.equal(status.state, failure === 'upstream' ? 'done' : 'claimed');
    }
  });

  await t.test('logging failure consumes claim without forwarding; no silent second attempt', async () => {
    await reset(); const params = create(Buffer.from('x')); await run(params); await putAll(Buffer.from('x'), params.token);
    let sends = 0;
    const handler = createChunkHandler({ enabled: () => true, store, send: async () => { sends++; return ok; },
      logger: { start: async () => { throw new Error('down'); } } });
    const response = () => ({ statusCode: 200, setHeader() {}, end(body) { this.body = body; } });
    const req = { method: 'GET', headers: {}, url: url({ action: 'execute', token: params.token }) };
    const first = response(); await handler(req, first); assert.equal(first.statusCode, 503);
    const second = response(); await handler(req, second); assert.equal(second.statusCode, 409); assert.equal(sends, 0);
  });
});

test('disabled, unauthorized, malformed, prefetch and GET bodies never reach storage or logs', async () => {
  let calls = 0; const store = { operate: async () => { calls++; } };
  const req = { method: 'GET', headers: {}, url: url(create(Buffer.from('x'))) };
  const response = () => ({ statusCode: 200, setHeader() {}, end(body) { this.body = body; } });
  const disabled = response(); await createChunkHandler({ store, logger, enabled: () => false })(req, disabled);
  assert.equal(disabled.statusCode, 503);
  const handler = createChunkHandler({ store, logger, enabled: () => true });
  const old = process.env.PROXY_API_KEY; process.env.PROXY_API_KEY = 'test-key';
  try { const res = response(); await handler(req, res); assert.equal(res.statusCode, 401); }
  finally { if (old === undefined) delete process.env.PROXY_API_KEY; else process.env.PROXY_API_KEY = old; }
  for (const patch of [{ url: '/api/chunks?action=finish' }, { headers: { 'content-length': '1000000000' } },
    { headers: { 'transfer-encoding': 'chunked' } }, { headers: { purpose: 'prefetch' } }]) {
    const res = response(); await handler({ ...req, ...patch }, res); assert.equal(res.statusCode, 400);
  }
  assert.equal(calls, 0);
});
