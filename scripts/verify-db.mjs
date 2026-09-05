import assert from 'node:assert/strict';
import { neon } from '@neondatabase/serverless';
import { requestRecord, createRequestLogger } from '../lib/request-log.js';

if (!process.env.DATABASE_URL || !process.env.REQUEST_LOG_DATABASE_URL) throw new Error('Supply owner and insert-only runtime connections in the environment. Use the isolated preview database.');
const owner = neon(process.env.DATABASE_URL);
const writer = neon(process.env.REQUEST_LOG_DATABASE_URL);
const logger = createRequestLogger();
const record = requestRecord({
  method: 'GET',
  url: `/api/post?${new URLSearchParams({ url: 'https://httpbin.org/post', data: '{"message":"database-permission-test","token":"example-secret"}', headers: '{"Authorization":"Bearer example-secret"}' })}`,
  headers: { 'user-agent': 'get2post-db-verification' },
});
try {
  await logger.start(record);
  await logger.finish(record.id, { httpStatus: 200, upstreamStatus: 200, errorCode: null, durationMs: 1, responseBytes: 2 });
  const [saved] = await owner`SELECT r.query, o.http_status FROM request_logging.requests r JOIN request_logging.outcomes o ON o.request_id = r.id WHERE r.id = ${record.id}`;
  assert.equal(saved.http_status, 200);
  assert.ok(!JSON.stringify(saved.query).includes('example-secret'));
  for (const statement of [
    'SELECT * FROM request_logging.requests LIMIT 1',
    'SELECT * FROM request_logging.outcomes LIMIT 1',
    'UPDATE request_logging.requests SET method = method WHERE false',
    'DELETE FROM request_logging.requests WHERE false',
    'CREATE TABLE request_logging.should_be_denied (id int)',
  ]) {
    await assert.rejects(writer.query(statement, []), (error) => error.code === '42501');
  }
  console.log('PASS: real Neon request/outcome round trip and credential redaction.');
  console.log('PASS: runtime role cannot SELECT, UPDATE, DELETE, or CREATE in the logging schema.');
} catch (error) {
  console.error(`Database verification failed (${error.code ?? error.name}); connection details suppressed.`);
  process.exitCode = 1;
} finally {
  // Delete only the fixture created by this invocation, using owner authority.
  try {
    await owner`DELETE FROM request_logging.outcomes WHERE request_id = ${record.id}`;
    await owner`DELETE FROM request_logging.requests WHERE id = ${record.id}`;
  } catch {
    console.error(`Fixture cleanup failed for request ${record.id}; connection details suppressed.`);
    process.exitCode = 1;
  }
}
