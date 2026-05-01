# Contributing

Thanks for helping improve Cap Worker.

## Local Setup

```sh
npm ci
copy .dev.vars.example .dev.vars
npm run dev
```

## Before Opening a PR

Run the same checks used by CI:

```sh
npm run check
npm run typecheck
npm run test
npm run build
```

If you change `wrangler.jsonc`, bindings, or Durable Object declarations, regenerate Worker types:

```sh
npm run cf-typegen
```

## Guidelines

- Keep API behavior compatible with the Cap widget routes.
- Do not commit secrets, `.dev.vars`, local Wrangler state, or generated build output.
- Keep challenge and token state short-lived.
- Prefer Cloudflare bindings and platform APIs over external REST calls from the Worker.
- Add or update tests for security, storage, and request validation changes.
