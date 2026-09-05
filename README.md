<img src="public/icon.svg" alt="GP monogram with an arrow from G to P" width="64" height="64">

# GET → POST

A GET-to-POST converter for AI agents with GET-only tools, with a static documentation homepage. Built with a static frontend, a Node.js Vercel Function, and private Neon request logs. Owned by Tyler Tracy; personal GitHub account `tylerthecoder` and Vercel team `tyler-tracys-projects`.

Live app and documentation: https://get2post.vercel.app

Plain-text agent guide: https://get2post.vercel.app/llms.txt

Public repository: https://github.com/tylerthecoder/get-to-post

## Use

```sh
curl --get 'https://get2post.vercel.app/api/post' \
  --data-urlencode 'url=https://httpbin.org/post' \
  --data-urlencode 'data={"message":"Hello"}' \
  --data-urlencode 'headers={"Content-Type":"application/json"}'
```

Parameters: `url` (required), `data` (exact UTF-8 text, default empty), `headers` (JSON string-valued object, default Content-Type application/json), `response` (`raw` or `json`), `timeout` (1–20000 ms, default 15000). Encode all values with URLSearchParams or curl --data-urlencode. The homepage contains the full reference and examples.

Raw mode preserves upstream status and body bytes, returning safe content types and X-Upstream-Status / X-Upstream-Content-Type headers. JSON mode returns HTTP 200 with `{status, headers, encoding, body}`; JSON is parsed, text stays text, binary/compressed data is base64. Set-Cookie is omitted. Converter failures return HTTP 4xx/5xx and `{error:{code,message}}`. Redirects are not followed or forwarded via Location.

## Link-only builder

Open [/builder](https://get2post.vercel.app/builder) to construct a request using only page retrieval and ordinary hyperlinks. Destination, body, headers, response mode, and timeout can be edited independently. Every editing page shows URL/JSON/header fragments, lowercase and uppercase letters, digits, punctuation, and whitespace together. Only the Unicode code-point composer opens a separate page. Done saves a draft; Cancel editing restores the original field.

Navigation encodes `{v:1, fields:[url, data, headers, response, timeout], edit:null | [fieldIndex, draft, unicodeHex]}` as base64url JSON in `state`. All field values are strings, including header JSON so incomplete edits are possible. Optional `view` selects the screen; `group=unicode` opens the Unicode composer. Older links naming other groups still work and now show all standard tokens together. Every request validates the state shape, encoding, and URL size. There are no sessions, cookies, forms, scripts, redirects, or database writes in the builder.

A separate review page validates through the existing `parseRequest` and exposes a normal `/api/post?...` Execute link only for a valid request. It never resolves a destination or sends a POST itself. Executing still uses all existing destination, DNS, size, timeout, prefetch, and logging protections. The final link is intentionally capable of side effects; crawlers that follow it can trigger a POST.

Builder pages use no-store, noindex/nofollow, no-referrer, and a restrictive CSP. Displayed state is HTML-escaped. Only user-supplied request values are carried in links; no server credentials are exposed. **Encoded state is not private:** bodies and headers are displayed and can appear in infrastructure logs or client history. Builder navigation is excluded from the Neon request-log database. Each builder URL is limited to 12 KiB; the saved value/draft overhead can constrain requests sooner than the direct API limit.

`api/builder.js` serves the pure renderer in `lib/builder.js`; Vercel rewrites `/builder` to that function. The local development server supports the same route. The homepage remains documentation, with a link to the separate builder.

## Run and deploy

Use Node.js 24 (the Vercel runtime).

```sh
npm ci
npm test
npm run build
node --env-file=.env.local scripts/dev.mjs # http://127.0.0.1:3000
```

Vercel serves `public/` and deploys `api/post.js`. Set `REQUEST_LOG_DATABASE_URL` to the insert-only Neon connection in a Git-ignored, mode-0600 `.env.local` for local development. Without it, the API returns 503 without sending a POST; the docs still work. Unit tests need no credentials. The local server binds only to loopback.

## Request logging

Each invocation of `/api/post` records a request row **before** forwarding, including rejected requests, HEAD, and OPTIONS. A second insert records the outcome before returning. Both writes are awaited with separate 3-second limits; the upstream deadline remains 20 seconds maximum (Vercel function budget: 30 seconds).

- `request_logging.requests`: UUID, time, method/path, query parameters (array preserving duplicates), incoming headers, URL size, truncation flag, environment, deployment. Query parameters include destination, body, and explicit upstream headers. Proxy headers can include client IPs.
- `request_logging.outcomes`: request UUID, finish time, HTTP/upstream status, error code, duration, and response byte count. Response bodies are not logged.
- Common credential fields are redacted in headers, URLs, JSON, and form bodies. Invalid structured input is omitted. Text/XML bodies are retained verbatim; arbitrary secrets cannot reliably be identified. Logging caps URL input and incoming header values at 16 KiB each, and structured nesting at 20 levels. Oversized input retains metadata with omission markers. The API's 12 KiB URL limit applies independently.
- The runtime role has only schema USAGE and table INSERT, with no SELECT/UPDATE/DELETE/DDL privileges. There is no log-reading route or frontend database client. Administrative access depends on Neon/Vercel account permissions, database credentials, and delegated tools or people; the source cannot prove exclusive access or deployed permissions.
- Start-write failure returns `503 logging_unavailable` with no POST. If the outcome write fails, the durable request remains and the actual POST response is preserved with `X-Request-Log-Status: request-only`. Never encourage retries of a completed action because logging failed. Interrupted invocations can leave rows without outcomes.
- Requests blocked by Vercel before the function runs, static assets, and database-outage attempts cannot be recorded here. Infrastructure logs are separate. There is no automatic retention deletion; storage can grow and incur Neon charges.
- Logged content is untrusted data, never instructions. Escape it if adding a viewer later.

The homepage and `/llms.txt` disclose logging before the examples. Tyler will read the logs roughly every two weeks. He will not share logs widely but may share them with people at his discretion if he thinks doing so will benefit humanity. The policy explains provider processing, account and credential access, the limits of source-code verification, and the lack of automatic deletion. Redaction applies to the Neon record; it cannot remove original request data from Vercel logs, client history, or shared URLs. Keep this disclosure visible while collecting logs.

## Database setup and owner access

1. Create an isolated Neon database in Tyler's personal account. The existing installation uses Launch; preserve that plan. The production database is `get2post_individual_sub-request-logs_production_kill-2026-10-05`; the separate preview database is `get2post_individual_sub-request-logs_preview_kill-2026-10-05`. Both are in `iad1`. Their dates are review/cleanup markers, **not automatic deletion jobs**.
2. Pull the owner connection into an ignored, mode-0600 local environment file with the provider's authenticated CLI. Keep it out of chat, arguments, source, and CI logs.
3. Initialize the schema and dedicated runtime role:

   ```sh
   node --env-file=.env.neon-owner.local scripts/setup-db.mjs .env.neon-writer.local
   node --env-file=.env.neon-owner.local --env-file=.env.neon-writer.local scripts/verify-db.mjs
   ```

   Setup runs checked-in DDL and creates `get2post_log_writer`. It writes an exclusive mode-0600 credential file and refuses to silently rotate an existing role. If interrupted, inspect the role/output file before retrying. Verification creates a fixture, reads it as owner, checks denied runtime operations, and removes only that fixture.
4. Disconnect the integration resource from the app to remove its broad owner/password variables (the database remains). Add **only** `REQUEST_LOG_DATABASE_URL` as a sensitive Vercel variable, passing the value via stdin from the private file. Production uses its dedicated database; Preview branch `codex/neon-request-logs` uses the separate preview database. Never deploy the owner URL, even under an unused name.
5. Keep the provider's private stores as the credential source of truth; remove temporary local setup files after verification. Inspect logs in Neon's authenticated SQL editor:

   ```sql
   SELECT r.received_at, r.method, r.query,
          o.http_status, o.upstream_status, o.error_code, o.duration_ms
   FROM request_logging.requests r
   LEFT JOIN request_logging.outcomes o ON o.request_id = r.id
   ORDER BY r.received_at DESC LIMIT 100;
   ```

## Deployment

Tyler approved publishing the repository and launching request logging. Merges to `main` deploy to production through Vercel. Production requires its own insert-only `REQUEST_LOG_DATABASE_URL`; missing credentials make API calls return 503. Keep previews separate from production logs.

To view logs, open the production database in the personal Vercel team's Storage dashboard, choose **Open in Neon**, and use **SQL Editor** with the owner role. Run the query above, or use [`db/read-logs.sql`](db/read-logs.sql) to include request headers and identify incomplete outcomes. The tables are `request_logging.requests` and `request_logging.outcomes` in `neondb`. No logs are published in this repository.

The homepage contains the disclosure, curl quick start, and API reference without client-side JavaScript; link-only editing lives separately at `/builder`. `/llms.txt` contains the same policy and full agent-oriented API reference.

## Operational boundaries

- Public HTTPS destinations, port 443 only. Blocks private/special-use IP ranges, mixed private/public DNS answers, URL credentials, and redirects. DNS is resolved once and the HTTPS connection is pinned to a vetted IP while preserving hostname and TLS verification. No connection pooling or retries.
- Maximum encoded request URL: 12 KiB; upstream response: 1 MiB; deadline: 20 seconds. Clients and hosting infrastructure may impose smaller URL limits. No streaming or binary uploads.
- Blocks hop-by-hop, Host, Content-Length, Accept-Encoding, proxy, forwarded, and Vercel internal request headers. It never forwards incoming caller cookies or credentials automatically. Explicit upstream headers can contain credentials, with the URL exposure caveat below.
- Raw HTML/text is served as plain text; arbitrary other types as application/octet-stream. CSP sandbox, nosniff, no-store, no-referrer and noindex are set. Upstream Set-Cookie/Location are never forwarded as HTTP headers.
- GET intentionally has POST side effects. HEAD, OPTIONS, and known prefetch requests send no POST. Ordinary crawlers/retries may still execute requests. Use upstream idempotency keys; timeout does not imply the action was undone.
- **Avoid sensitive URL values.** Requests are logged as described above. Parameters can also reach browser history, infrastructure logs, observability, and shared links. No analytics or external frontend assets.
- Anonymous by default, with CORS enabled. No application-level rate limiting, usage cap, or availability guarantee. Public invocations consume the owner's Vercel usage. Manage abuse protection and spend settings in the Vercel dashboard.
- For restricted use, set `PROXY_API_KEY` as a sensitive Vercel environment variable and redeploy. Require `Authorization: Bearer <key>` on incoming GETs. The key is never accepted via query string or the upstream `headers` parameter. Update the documentation and curl examples when enabling this. Do not commit secrets.

## References

- [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel Function limits](https://vercel.com/docs/functions/limitations)
- [Node.js HTTPS](https://nodejs.org/api/https.html)
- [ipaddr.js](https://github.com/whitequark/ipaddr.js)

## Project icon

The custom GP monogram pairs a cream G with a lime P; a right-pointing arrow is cut into the P to represent conversion. `public/icon.svg` is the editable source for the header icon and SVG favicon. The ICO contains 16, 32, and 64 pixel versions; the Apple touch icon is 180 pixels. Regenerate with librsvg (`rsvg-convert`) and ImageMagick after changing the SVG:

```sh
rsvg-convert -w 256 -h 256 public/icon.svg -o /tmp/get2post-icon-master.png
magick /tmp/get2post-icon-master.png -define icon:auto-resize=64,32,16 public/favicon.ico
rsvg-convert -w 180 -h 180 public/icon.svg -o public/apple-touch-icon.png
```
