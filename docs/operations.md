# Operations and maintenance

Maintainer reference for the GET2POST deployment, request logging, and link-only builder. For usage and the API reference, see the [website](https://www.postviaget.com). Shell commands assume the repository root.

## Run and deploy

Use Node.js 24 (the Vercel runtime).

```sh
npm ci
npm test
npm run build
node --env-file=.env.local scripts/dev.mjs # http://127.0.0.1:3000
```

Vercel serves `public/` and deploys `api/post.js`. Set `REQUEST_LOG_DATABASE_URL` to the insert-only Neon connection in a Git-ignored, mode-0600 `.env.local` for local development. Without it, the API returns 503 without sending an upstream request; the docs still work. Unit tests need no credentials. The local server binds only to loopback.

## Request logging

Each invocation of `/api/post` records a request row **before** forwarding, including rejected requests, HEAD, and OPTIONS. A second insert records the outcome before returning. Both writes are awaited with separate 3-second limits; the upstream deadline remains 20 seconds maximum (Vercel function budget: 30 seconds).

- `request_logging.requests`: UUID, time, method/path, query parameters (array preserving duplicates), incoming headers, URL size, truncation flag, environment, deployment. Query parameters include destination, body, and explicit upstream headers. Proxy headers can include client IPs.
- `request_logging.outcomes`: request UUID, finish time, HTTP/upstream status, error code, duration, and response byte count. Response bodies are not logged.
- Common credential fields are redacted in headers, URLs, JSON, and form bodies. Invalid structured input is omitted. Text/XML bodies are retained verbatim; arbitrary secrets cannot reliably be identified. Logging caps URL input and incoming header values at 16 KiB each, and structured nesting at 20 levels. Oversized input retains metadata with omission markers. The API's 12 KiB URL limit applies independently.
- The runtime role has only schema USAGE and table INSERT, with no SELECT/UPDATE/DELETE/DDL privileges. There is no log-reading route or frontend database client. Administrative access depends on Neon/Vercel account permissions, database credentials, and delegated tools or people; the source cannot prove exclusive access or deployed permissions.
- Start-write failure returns `503 logging_unavailable` with no upstream request. If the outcome write fails, the durable request remains and the actual upstream response is preserved with `X-Request-Log-Status: request-only`. Never encourage retries of a completed action because logging failed. Interrupted invocations can leave rows without outcomes.
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

To view logs, open the production database in the personal Vercel team's Storage dashboard, choose **Open in Neon**, and use **SQL Editor** with the owner role. Run the query above, or use [`db/read-logs.sql`](../db/read-logs.sql) to include request headers and identify incomplete outcomes. The tables are `request_logging.requests` and `request_logging.outcomes` in `neondb`. No logs are published in this repository.

The homepage contains the disclosure, curl quick start, and API reference without client-side JavaScript; link-only editing lives separately at `/builder`. `/llms.txt` contains the same policy and full agent-oriented API reference.

## Operational boundaries

- Public HTTPS destinations, port 443 only. Blocks private/special-use IP ranges, mixed private/public DNS answers, URL credentials, and redirects. DNS is resolved once and the HTTPS connection is pinned to a vetted IP while preserving hostname and TLS verification. No connection pooling or retries.
- Maximum encoded request URL: 12 KiB; upstream response: 1 MiB; deadline: 20 seconds. Clients and hosting infrastructure may impose smaller URL limits. No streaming or binary uploads.
- Blocks hop-by-hop, Host, Content-Length, Accept-Encoding, proxy, forwarded, and Vercel internal request headers. It never forwards incoming caller cookies or credentials automatically. Explicit upstream headers can contain credentials, with the URL exposure caveat below.
- Raw HTML/text is served as plain text; arbitrary other types as application/octet-stream. CSP sandbox, nosniff, no-store, no-referrer and noindex are set. Upstream Set-Cookie/Location are never forwarded as HTTP headers.
- GET intentionally has upstream side effects. Incoming HEAD, OPTIONS, and known prefetch requests send no upstream request. Ordinary crawlers/retries may still execute requests. Use upstream idempotency keys; timeout does not imply the action was undone.
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

## Builder implementation

Navigation encodes `{v:2, fields:[url, data, headers, response, timeout, method], edit:null | [fieldIndex, draft, unicodeHex]}` as base64url JSON in `state`. Version 1 links with five fields are upgraded with method POST. All field values are strings, including header JSON so incomplete edits are possible. Optional `view` selects the screen; `group=unicode` opens the Unicode composer. Older links naming other groups still work and now show all standard tokens together. Every request validates the state shape, encoding, and URL size. There are no sessions, cookies, forms, scripts, redirects, or database writes in the builder.

A separate review page validates through the existing `parseRequest` and exposes a normal `/api/post?...` Execute link only for a valid request. It never resolves a destination or sends the selected HTTP request itself. Executing still uses all existing destination, DNS, size, timeout, prefetch, and logging protections. The final link is intentionally capable of side effects; crawlers that follow it can trigger an upstream request.

Builder pages use no-store, noindex/nofollow, no-referrer, and a restrictive CSP. Displayed state is HTML-escaped. Only user-supplied request values are carried in links; no server credentials are exposed. **Encoded state is not private:** bodies and headers are displayed and can appear in infrastructure logs or client history. Builder navigation is excluded from the Neon request-log database. Each builder URL is limited to 12 KiB; the saved value/draft overhead can constrain requests sooner than the direct API limit.

`api/builder.js` serves the pure renderer in `lib/builder.js`; Vercel rewrites `/builder` to that function. The local development server supports the same route. The homepage remains documentation, with a link to the separate builder.


## Search discovery and measurement

The homepage is the public documentation and canonical search landing page:
`https://www.postviaget.com/`. The apex domain `https://postviaget.com/` redirects to this `www` address.
The original `https://get2post.vercel.app/` address also works as an alternative.
Its title, description, canonical link, and social
metadata describe the GET-to-HTTP use case. `/sitemap.xml` lists only the homepage;
`/llms.txt` is a linked alternative reference for agents, not a separate landing
page or a guaranteed search ranking signal.

`robots.txt` permits documentation crawlers and disallows `/api/`. Preserve the
API restriction: fetching an execution URL can send an upstream request. Builder pages retain
`noindex, nofollow` and are excluded from the sitemap, along with request state
and execution URLs. Never submit generated request URLs to an indexing service.
If adding crawler-specific robots groups, repeat the API restriction in each
applicable group; a more specific group can override the wildcard group's rules.

After deploying changes to production:

1. Verify ownership of `https://www.postviaget.com/` in
   [Google Search Console](https://search.google.com/search-console) and
   [Bing Webmaster Tools](https://www.bing.com/webmasters/). Use the verification
   artifact issued by the provider; do not add placeholder verification tokens.
2. Submit `https://www.postviaget.com/sitemap.xml` in both accounts. Inspect the
   homepage's indexing status, selected canonical, and crawl errors. Confirm that
   the property is eligible for Google's generative AI search features.
3. Check Vercel's firewall/bot settings for the production project. Documentation
   should be accessible without a login or browser challenge to legitimate search
   crawlers, including OAI-SearchBot. Verify crawler identity using the provider's
   published guidance instead of trusting a user-agent string alone. Scope any
   necessary exception to documentation; retain API protections.
4. Record a baseline and compare it after several weeks: indexed homepage status,
   search queries, impressions, clicks, and Bing's AI Performance citations.
   Keep discovery metrics separate from API request volume. User-agent labels
   alone do not prove AI referrals, and API logs exclude static-page visits.

These are owner-account and production steps; adding a sitemap to Git does not
verify ownership, submit URLs, or establish indexing. No analytics script or new
request logging is needed for the search-provider reports. Search indexing and
AI citations are not guaranteed.

For distribution, keep the repository's About description and website current.
Suggested description: “GET-to-HTTP proxy for AI agents with GET-only tools.
Static API documentation and a link-only request builder.” Relevant repository
topics include `ai-agents`, `http-proxy`, and `developer-tools`. Share concrete,
tested examples with relevant projects or tool collections where appropriate;
avoid bulk directory submissions and unsupported compatibility claims.

References:

- [Google: optimizing for generative AI search](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)
- [OpenAI: search and training crawlers](https://developers.openai.com/api/docs/bots)
- [Bing: sitemap discovery](https://blogs.bing.com/webmaster/July-2025/Keeping-Content-Discoverable-with-Sitemaps-in-AI-Powered-Search)
- [Bing: AI Performance reports](https://blogs.bing.com/webmaster/February-2026/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview)
