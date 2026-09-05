import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { neon } from '@neondatabase/serverless';

// Run manually with the owner connection available only to this local process.
// Never execute migrations with app-controlled input or deploy the owner URL.
const ownerUrl = process.env.DATABASE_URL;
if (!ownerUrl) throw new Error('Set DATABASE_URL to the Neon owner connection for setup.');
const output = process.argv[2];
if (!output) throw new Error('Supply an ignored output file path for the runtime connection.');
const sql = neon(ownerUrl);
const migration = await readFile(new URL('../db/001-request-logs.sql', import.meta.url), 'utf8');
try {
  const statements = migration.split(';').map((statement) => statement.trim()).filter((statement) => statement && !/^--[^\n]*$/.test(statement));
  // The file contains only known DDL statements, not user values.
  await sql.transaction(statements.filter((statement) => /\b(CREATE|REVOKE)\b/.test(statement)).map((statement) => sql.query(statement, [])));
  const role = 'get2post_log_writer';
  const existing = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
  if (existing.length) throw new Error('Writer role already exists; preserve its existing credential instead of silently rotating it.');
  const password = randomBytes(32).toString('hex');
  // Identifiers are fixed; password is generated hex, never request input.
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = role; runtimeUrl.password = password;
  // Reserve the file before creating a credential, so an existing output or a
  // filesystem failure cannot leave an unrecoverable randomly generated role.
  await writeFile(output, `REQUEST_LOG_DATABASE_URL=${JSON.stringify(runtimeUrl.href)}\n`, { mode: 0o600, flag: 'wx' });
  await sql.transaction([
    sql.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS`, []),
    sql.query(`GRANT USAGE ON SCHEMA request_logging TO ${role}`, []),
    sql.query(`GRANT INSERT ON request_logging.requests, request_logging.outcomes TO ${role}`, []),
  ]);
  console.log('Schema and insert-only runtime role created. Connection saved to the requested private file.');
} catch {
  // Driver errors can include connection details. Inspect failures locally with
  // trusted tools, never echo the owner URL, SQL values, or database password.
  console.error('Database setup failed. Check schema/role state in Neon before retrying.');
  process.exitCode = 1;
}
