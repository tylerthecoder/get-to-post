# GET → POST

A public GET-to-POST converter with a documented request builder. Built with a static frontend and a Node.js Vercel Function. Owned by Tyler Tracy; personal GitHub account `tylerthecoder` and Vercel team `tyler-tracys-projects`.

## Use

```sh
curl --get 'https://YOUR-DEPLOYMENT.vercel.app/api/post' \
  --data-urlencode 'url=https://httpbin.org/post' \
  --data-urlencode 'data={"message":"Hello"}' \
  --data-urlencode 'headers={"Content-Type":"application/json"}'
```

Parameters: `url` (required), `data` (exact UTF-8 text, default empty), `headers` (JSON string-valued object, default Content-Type application/json), `response` (`raw` or `json`), `timeout` (1–20000 ms, default 15000). Encode all values with URLSearchParams or curl --data-urlencode. The homepage contains the full reference and examples.

Raw mode preserves upstream status and body bytes, returning safe content types and X-Upstream-Status / X-Upstream-Content-Type headers. JSON mode returns HTTP 200 with `{status, headers, encoding, body}`; JSON is parsed, text stays text, binary/compressed data is base64. Set-Cookie is omitted. Converter failures return HTTP 4xx/5xx and `{error:{code,message}}`. Redirects are not followed or forwarded via Location.

## Run and deploy

Use Node.js 24 (the Vercel runtime).

```sh
npm ci
npm test
npm run build
npm run dev # http://127.0.0.1:3000
vercel --prod --scope tyler-tracys-projects
```

Vercel serves `public/` and deploys `api/post.js`. No database, storage, or runtime credentials are required. Dependency versions are locked. Tests exercise input handling, SSRF prevention and DNS pinning, limits, header filtering, response fidelity, methods, and prefetch handling. The local dev server is loopback-only.

## Operational boundaries

- Public HTTPS destinations, port 443 only. Blocks private/special-use IP ranges, mixed private/public DNS answers, URL credentials, and redirects. DNS is resolved once and the HTTPS connection is pinned to a vetted IP while preserving hostname and TLS verification. No connection pooling or retries.
- Maximum encoded request URL: 12 KiB; upstream response: 1 MiB; deadline: 20 seconds. Clients and hosting infrastructure may impose smaller URL limits. No streaming or binary uploads.
- Blocks hop-by-hop, Host, Content-Length, Accept-Encoding, proxy, forwarded, and Vercel internal request headers. It never forwards incoming caller cookies or credentials automatically. Explicit upstream headers can contain credentials, with the URL exposure caveat below.
- Raw HTML/text is served as plain text; arbitrary other types as application/octet-stream. CSP sandbox, nosniff, no-store, no-referrer and noindex are set. Upstream Set-Cookie/Location are never forwarded as HTTP headers.
- GET intentionally has POST side effects. HEAD, OPTIONS, and known prefetch requests send no POST. Ordinary crawlers/retries may still execute requests. Use upstream idempotency keys; timeout does not imply the action was undone.
- **Avoid sensitive URL values.** Request parameters can reach history, access logs, observability, and shared links. The app does not explicitly log/store requests; provider infrastructure may. No analytics or external frontend assets.
- Anonymous by default, with CORS enabled. No application-level rate limiting, usage cap, or availability guarantee. Public invocations consume the owner's Vercel usage. Manage abuse protection and spend settings in the Vercel dashboard.
- For restricted use, set `PROXY_API_KEY` as a sensitive Vercel environment variable and redeploy. Require `Authorization: Bearer <key>` on incoming GETs. The key is never accepted via query string or the upstream `headers` parameter. Update the homepage's public/no-sign-up messaging when enabling this; its built-in sender currently supports anonymous mode only. Do not commit secrets.

## References

- [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)
- [Vercel Function limits](https://vercel.com/docs/functions/limitations)
- [Node.js HTTPS](https://nodejs.org/api/https.html)
- [ipaddr.js](https://github.com/whitequark/ipaddr.js)
