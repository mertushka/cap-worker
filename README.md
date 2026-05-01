# Cap Worker

Cloudflare Worker implementation of a Cap-compatible proof-of-work challenge service. It exposes the endpoints needed by `@cap.js/widget`, stores short-lived challenge and verification state in SQLite-backed Durable Objects, and includes a public tester at `/`.

## Architecture

- Hono handles the HTTP API, validation, request body limits, and JSON responses.
- Durable Objects store challenge data and one-time verification tokens, sharded by token prefix.
- Cloudflare Rate Limiting bindings protect `/challenge`, `/redeem`, `/validate`, and `/siteverify`.
- Web Crypto is used for random tokens and SHA-256 hashing.
- `public/index.html` is served as the root test page.

## Requirements

- Node.js 22 or newer
- npm
- Cloudflare account with Workers, Durable Objects, and Workers Rate Limiting API access
- Wrangler 4.36.0 or newer. This repo is locked to Wrangler 4.87.0.

## Quick Start

```sh
npm ci
copy .dev.vars.example .dev.vars
npm run dev
```

Open the local Worker URL and use the tester at `/`. API metadata is available at `/api`.

## Scripts

```sh
npm run dev          # Start Wrangler dev
npm run check        # Biome format/lint check
npm run format       # Apply Biome formatting
npm run lint         # Biome lint only
npm run typecheck    # TypeScript typecheck
npm run test         # Vitest with the Cloudflare Workers pool
npm run build        # Wrangler deploy dry run into dist/
npm run deploy       # Deploy to Cloudflare
npm run cf-typegen   # Regenerate worker-configuration.d.ts
```

## API

```txt
GET  /api
POST /challenge
POST /redeem
POST /validate
POST /siteverify
```

`/challenge` accepts an optional JSON body. Public clients cannot lower the production defaults.

```json
{
  "challengeCount": 50,
  "challengeSize": 32,
  "challengeDifficulty": 4,
  "expiresMs": 600000
}
```

`/redeem` exchanges solved challenge work for a short-lived verification token.

```json
{
  "token": "<challenge-token>",
  "solutions": [1, 2, 3]
}
```

`/validate` validates a verification token. Tokens are consumed unless `keepToken` is true.

```json
{
  "token": "<id:verification-token>",
  "keepToken": false
}
```

You can also validate with a bearer token and no request body.

```txt
Authorization: Bearer <id:verification-token>
```

`/siteverify` is the server-side compatibility endpoint for applications that expect a reCAPTCHA-like verification response.

```json
{
  "response": "<id:verification-token>",
  "secret": "<site-secret>"
}
```

It also accepts `application/x-www-form-urlencoded`:

```txt
response=<id:verification-token>&secret=<site-secret>
```

## Website Usage

For same-origin usage, point the Cap widget at `/`:

```html
<script src="https://cdn.jsdelivr.net/npm/@cap.js/widget@0.1.26"></script>

<cap-widget data-cap-api-endpoint="/"></cap-widget>
```

For a separate Worker domain, point the widget at the Worker origin:

```html
<cap-widget data-cap-api-endpoint="https://cap.example.com/"></cap-widget>
```

After the widget emits a token, submit that token with your form to your own backend. Your backend should call `/siteverify` and accept the form only when the response is `{ "success": true }`.

```ts
const response = await fetch("https://cap.example.com/siteverify", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    response: capTokenFromForm,
    secret: process.env.CAP_SITE_SECRET,
  }),
});

const result = await response.json();
```

`CAP_SITE_SECRET` is your private site secret. Generate a long random value, store it with `wrangler secret put CAP_SITE_SECRET`, and use the same value from your backend when calling `/siteverify`. Do not put this secret in browser code.

## Configuration

Rate limits are configured in `wrangler.jsonc`.

```txt
POST /challenge: 30/min/client
POST /redeem: 60/min/client
POST /validate and /siteverify: 120/min/client
```

The configured rate-limit namespace IDs must be unique positive integers in your Cloudflare account. Change `1001`, `1002`, and `1003` if they conflict with another Worker.

Use `.dev.vars` for local-only secrets. Use Wrangler secrets for production:

```sh
wrangler secret put CAP_SITE_SECRET
```

If your website calls the Worker from a different browser origin, set `CAP_ALLOWED_ORIGINS` in `wrangler.jsonc` to a comma-separated list of allowed origins.

## Deployment

```sh
npm run cf-typegen
npm run check
npm run typecheck
npm run test
npm run build
npm run deploy
```

The root path `/` is intentionally the public tester. Use `/api` for service metadata.

## License

MIT License. See `LICENSE`.
