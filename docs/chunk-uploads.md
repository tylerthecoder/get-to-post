# Bounded GET-only chunk uploads

The direct API puts the entire body in a 12 KiB URL. `/api/chunks` instead accepts
numbered pieces and forwards one assembled body. This is an optional API protocol;
the stateless, link-only builder continues to use the direct API.

## Protocol

Every call uses GET, URL-encoded parameters, and (if configured) the same incoming
`Authorization: Bearer …` key as `/api/post`. No GET request bodies. HEAD, OPTIONS,
and recognized prefetches do not access upload storage. All responses are JSON
except execution, which honors `response=raw|json` as the direct API does.

1. Generate a **fresh cryptographically random 32-byte token**, encoded as 64
   lowercase hex characters. Prepare the exact body bytes, its lowercase SHA-256,
   and a fixed Unix expiry in seconds, no more than 15 minutes in the future.
2. `GET /api/chunks?action=create&token=…&url=…&bytes=…&chunks=…&sha256=…&expires=…`
   freezes the destination and optional `headers`, `response`, and `timeout`.
   `bytes` is 1–262144; `chunks` must equal `ceil(bytes / 4096)`.
3. Split the bytes into 4096-byte pieces; only the last may be shorter.
   `GET /api/chunks?action=put&token=…&index=0&chunk=…` stores an unpadded,
   canonical **base64url** piece. Indexes start at zero. This supports exact UTF-8
   and binary bodies, even if a multibyte character spans chunks. No compression
   or decompression is performed.
4. `GET /api/chunks?action=status&token=…` returns
   `{state, bytes, chunks, expiresAt, received:[0,1,…]}`. It never returns body
   bytes or destination credentials. Complete all missing indexes.
5. `GET /api/chunks?action=execute&token=…` atomically verifies the body length and
   SHA-256 and claims one forwarding attempt. Destination DNS is resolved and
   vetted at execution through the existing proxy. No redirects or retries.

Create/put/status return HTTP 200 and the status object. Identical create/put
retries are safe **within the fixed lifetime** and still cost a budget operation.
Changed creation parameters or changed bytes at an existing index return 409.
Expired create URLs cannot recreate an upload. Never reuse a token for another
upload, even after expiry. A status lookup cannot reveal whether a random token
was previously used; unknown/expired uploads both return 404.

Execution states are `open`, `claimed`, and `done`. `claimed` means a forwarding
attempt was reserved, and `done` means its handler finished; **neither proves the
upstream action succeeded**. Use the execution response and upstream records.
Execution removes stored chunks immediately. After a claim, every further execute
returns 409, including after a logging outage, DNS failure, crash, or timeout.
A missing/lost response never triggers an automatic retry. This is at most one
attempt per upload, not an exactly-once delivery guarantee. Use upstream idempotency
keys when supported; do not start another upload to retry an uncertain action.
The last minute before expiry is reserved for safe completion (execute returns 410).

## Hard application bounds

These are fixed in the database function, shared across every instance using that
upload database. They are not caller-configurable and do not trust IP headers.

| Resource | Limit |
| --- | --- |
| Encoded request URL | 12 KiB, checked before any upload DB call |
| Routing options at creation | 8 KiB encoded |
| Body / chunk / chunks | 256 KiB / 4 KiB / 64 |
| Live uploads, including consumed tombstones | 32 |
| Live logical payload storage | At most 8 MiB, plus at most 256 KiB routing metadata and row/index overhead |
| Lifetime | Fixed expiry at most 15 minutes; retries never extend it |
| New uploads per shared 24-hour window | 64 |
| Reserved body bytes per shared 24-hour window | 16 MiB; charged on creation, never refunded |
| Public storage operations | 240 per shared minute window and 6000 per shared 24-hour window |
| Concurrent chunk forwarding attempts | 4; interrupted claims occupy their slot until expiry |
| Upstream response / deadline | Existing 1 MiB / 20 seconds |
| Database / function deadline | 2-second role statement timeout, 100-ms lock timeout, 3-second client timeout / 40 seconds |

The windows start on first use/reset, not at calendar midnight. Fixed-window
boundaries can permit two windows' allowance in a short interval. The concurrent
storage bound still applies. Invalid token lookups and conflicting retries consume
operation budget; malformed HTTP input is rejected without a DB call. Internal
completion can release a claimed execution slot after the public budget is spent.
Full storage or exhausted budgets fail closed with 429 and `Retry-After` (60 seconds
for minute/storage limits, 30 for execution slots, 86400 for daily limits; these
are conservative delays, not a promise that capacity will be available).

Expired uploads and chunks are deleted on the next admitted database call, even
if that call is over budget. No traffic means expired bytes may remain physically
stored until another call or operator cleanup. The fixed live-data bound applies
in either case. PostgreSQL MVCC/WAL, backups, provider logs, and table/index overhead
are not an 8 MiB disk/billing guarantee; normal vacuum and provider retention still
apply. No chunk/status/rejection creates an append-only audit row. Only an admitted
execution uses the existing logger (at most 64 per creation window).

A singleton row lock makes admission, cleanup, slot checks, immutable writes, and
claims atomic. Lock contention returns 503 storage unavailable rather than waiting
indefinitely. The runtime role has EXECUTE on one fixed, security-definer function
with a locked search path, no table access, and no request-log access. The existing
insert-only logger role is unchanged. No arbitrary query/DDL is constructed from
request input. Stored destination options are revalidated before forwarding.

## Exposure, logs, and abuse limits

The token is a **bearer capability**: anyone holding it can upload/status/execute
that one request. Generate it securely and share it only with authorized clients.
Only its SHA-256 is stored in the upload table, but the original token, raw chunks,
and request options travel in URLs and can appear in client history, shared links,
and infrastructure logs. GET navigation can have side effects; ordinary scanners
are not reliably distinguishable from intentional clients. No capability links
are placed in public pages. Do not upload confidential data.

The temporary upload database stores the **original body and explicit headers**;
redacting them would change the forwarded request. Provider processing and owner
access/sharing policy are the same as the homepage disclosure. Permanent execution
logs retain bounded routing metadata and an omitted-body marker, **not** the
capability, raw chunks, or assembled body. Incoming Referer/credentials are still
redacted by the existing logger. Upstream responses are not stored.

These limits bound the new feature's retained data and forwarding work. They do
**not** bound total function invocations, denied traffic, Neon queries/WAL, or the
owner's bill. One anonymous user can exhaust the shared budget and temporarily
starve other upload users. The existing direct API has its own unchanged risk:
it does not inherit these upload quotas. Static documentation needs neither DB.

Before enabling, configure a Vercel WAF rate-limit rule matching `/api/chunks` on
all deployments, with a per-source-IP limit appropriate to a sequential 64-chunk
upload (for example 120 requests/minute). Use an account spend alert/action and
review database usage. Restrict with `PROXY_API_KEY` if public access is not needed.
These provider controls must be configured separately and are not installed by
this PR. Application checks alone cannot prevent a volumetric/cost attack.

References: [Vercel WAF rate limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting),
[Vercel DDoS mitigation](https://vercel.com/docs/vercel-firewall/ddos-mitigation).

## Setup and rollback

Uploads default to disabled: both `CHUNK_UPLOADS_ENABLED=1` and a working
`CHUNK_DATABASE_URL` are needed. This migration is intentionally not run on startup
or automatically against production. Preview must use a separate database from
production so preview activity cannot consume production quotas.

Using the selected environment's owner connection as process-scoped `DATABASE_URL`:

```sh
node --env-file=.env.neon-owner.local scripts/setup-chunks.mjs .env.chunk-runtime.local
```

The script creates the schema and a separate `get2post_chunk_runtime` login, writes
its connection into a new mode-0600 ignored file, and grants only schema USAGE and
function EXECUTE. It will not overwrite files, schemas, roles, or rotate existing
credentials. An interrupted/failed setup requires inspecting schema/role/file state
before retrying. Run `npm test` and verify the same negative permissions against
the selected database before activation. Keep the existing insert-only
`REQUEST_LOG_DATABASE_URL`; never deploy the owner connection.

Install `CHUNK_DATABASE_URL` as a sensitive runtime variable via the provider's
trusted secret workflow, configure edge protections, then set
`CHUNK_UPLOADS_ENABLED=1` and redeploy. Setup uses a trusted DDL transaction; an
owner may instead apply `db/002-chunk-uploads.sql` and grant the documented role
manually. Do not enable with the owner URL or reuse the logger credential.

For an immediate operator kill switch without redeployment:

```sql
UPDATE chunk_uploads.budget SET enabled = false WHERE id;
```

New chunk DB operations then fail closed; already claimed requests may finish.
The direct API and docs continue to work. Setting `CHUNK_UPLOADS_ENABLED=0` and
redeploying additionally prevents upload DB access. To remove retained expired
payloads without waiting for traffic, run as owner:

```sql
DELETE FROM chunk_uploads.uploads WHERE expires_at <= clock_timestamp();
```

Do not reset quotas/delete unexpired claims to recover a timed-out action.

## Validation

`npm test` runs the actual PL/pgSQL in PGlite locally. CI also runs it against
PostgreSQL 17 with separate pooled connections for races; set `TEST_DATABASE_URL`
to an **empty disposable local database** to run the same test there. Tests create
and drop the chunk schema and a test role. Never point this variable at a deployed
database. Tests cover full-sized bodies, immutable/out-of-order chunks, bad digest,
fixed expiry, quotas, concurrent claims/creation, role permissions, HTTP guards,
logging failure, and the execution/logging path with a mocked upstream transport.
