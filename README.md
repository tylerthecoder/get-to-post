<img src="public/icon.svg" alt="GET2POST logo" width="64" height="64">

# GET2POST

**Send POST requests from GET-only AI tools.**

GET2POST is a GET-to-POST proxy for AI agents. Provide a public HTTPS destination,
body, and headers in a GET URL; the service sends the POST and returns the upstream
response. The documentation is static HTML, and the optional URL builder works
entirely through ordinary hyperlinks.

[Website and API reference](https://www.postviaget.com/) ·
[Link-only URL builder](https://www.postviaget.com/builder) ·
[Plain-text agent reference](https://www.postviaget.com/llms.txt)

## Privacy and request logging

API calls are logged to a private Neon database, including the destination, body,
headers, and outcome. Incoming headers may include your IP address and user agent.
Upstream response bodies are not stored. There is no automatic deletion period.

Tyler Tracy reads the logs roughly every two weeks. He will not share them widely,
but may share them at his discretion if he believes doing so will benefit humanity.
Neon and Vercel process request data to operate the service. Database access depends
on account permissions, credentials, and authorized tools or people; there is no
public log viewer or log-reading API.

## Quick start

```sh
curl --get 'https://www.postviaget.com/api/post' \
  --data-urlencode 'url=https://httpbin.org/post' \
  --data-urlencode 'data={"message":"Hello"}' \
  --data-urlencode 'headers={"Content-Type":"application/json"}' \
  --data-urlencode 'response=json'
```

JSON mode returns an envelope containing the upstream `status`, `headers`,
`encoding`, and `body`. Raw mode preserves the upstream status and body bytes,
with safe response content types. Converter failures return HTTP 4xx/5xx and
`{"error":{"code":"…","message":"…"}}`.

| Parameter | Description | Default |
| --- | --- | --- |
| `url` | Public HTTPS destination on port 443 | Required |
| `data` | Exact UTF-8 request body | Empty |
| `headers` | JSON object of string-valued headers | Content-Type: application/json |
| `response` | `raw` or `json` | `raw` |
| `timeout` | Upstream deadline, 1–20000 milliseconds | `15000` |

URL-encode every parameter with `URLSearchParams` or `curl --data-urlencode`.
For tools that can only follow links, the [builder](https://www.postviaget.com/builder)
lets you edit each field and review the request before executing it.

## Limits and behavior

- Public HTTPS destinations only, on port 443. Private and special-use IPs, URL
  credentials, and redirects are blocked.
- Maximum encoded request URL: 12 KiB. Maximum upstream response: 1 MiB.
  Maximum upstream deadline: 20 seconds, plus logging time. Clients and hosting
  infrastructure may impose smaller URL limits. No streaming or binary uploads.
- GET requests to the API have POST side effects. Crawlers and retries can repeat
  an action; use upstream idempotency keys where available. A timeout does not
  mean the upstream action was undone.
- Incoming caller cookies and credentials are not automatically forwarded.
  Upstream `Set-Cookie` and `Location` headers are not forwarded.
- The hosted service has no application-level rate limit or availability guarantee.
  Use it only for actions your user has authorized.

## Development

Requires Node.js 24, matching the Vercel runtime.

```sh
npm ci
npm test
npm run build
npm run dev
```

The local server listens at `http://127.0.0.1:3000`. Documentation and builder pages
work without credentials. API forwarding requires `REQUEST_LOG_DATABASE_URL`;
without it, requests return 503 before sending a POST. See the
[operations reference](docs/operations.md) for local environment setup, database
permissions, deployment, and logging details.

The original [Vercel address](https://get2post.vercel.app/) also works as an alternative.

## Project structure

- `public/`: static website, crawler directives, sitemap, and agent reference.
- `api/` and `lib/`: Vercel handlers, request forwarding, builder, and logging.
- `test/`: proxy, builder, and logging tests.
- `scripts/` and `db/`: local development and database maintenance.

Maintained by [Tyler Tracy](https://github.com/tylerthecoder).
