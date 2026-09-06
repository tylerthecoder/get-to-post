import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

// Separate role from the insert-only logger. Never grant table access to either
// app role and never deploy DATABASE_URL. Run this only against an isolated DB
// or the operator-selected environment; preview and production must be separate.
const output = process.argv[2];
if (!process.env.DATABASE_URL || !output) throw new Error('Set DATABASE_URL and supply a private ignored output path.');
try {
  const sql = neon(process.env.DATABASE_URL);
  const existing = await sql`SELECT 1 FROM pg_roles WHERE rolname = 'get2post_chunk_runtime'`;
  if (existing.length) throw new Error('Existing role; preserve its credentials.');
  const migration = await readFile(new URL('../db/002-chunk-uploads.sql', import.meta.url), 'utf8');
  // The complete trusted migration includes a PL/pgSQL body; never split on ';'.
  // Neon HTTP prepared queries accept one statement: pass the DDL through a
  // fixed DO block (the outer migration transaction is handled by Neon).
  const ddl = migration.replace(/^BEGIN;$/m, '').replace(/^COMMIT;$/m, '');
  const password = randomBytes(32).toString('hex');
  const url = new URL(process.env.DATABASE_URL);
  url.username = 'get2post_chunk_runtime'; url.password = password;
  await writeFile(output, `CHUNK_DATABASE_URL=${JSON.stringify(url.href)}\n`, { flag: 'wx', mode: 0o600 });
  await sql.transaction([
    sql.query(`DO $migration$ BEGIN ${ddl} END $migration$;`, []),
    sql.query(`CREATE ROLE get2post_chunk_runtime LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8`, []),
    sql.query('ALTER ROLE get2post_chunk_runtime SET statement_timeout = \'2s\'', []),
    sql.query('ALTER ROLE get2post_chunk_runtime SET idle_in_transaction_session_timeout = \'3s\'', []),
    sql.query('GRANT USAGE ON SCHEMA chunk_uploads TO get2post_chunk_runtime', []),
    sql.query('GRANT EXECUTE ON FUNCTION chunk_uploads.operate(text,text,text,integer,integer,text,integer,bytea,bigint) TO get2post_chunk_runtime', []),
  ]);
  console.log('Chunk schema and function-only role created. Enable uploads only after deployment safeguards are configured.');
} catch {
  console.error('Chunk setup failed. Inspect schema, role, and output file locally before retrying. Existing credentials were not rotated.');
  process.exitCode = 1;
}
