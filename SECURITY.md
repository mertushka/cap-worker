# Security Policy

## Reporting a Vulnerability

Please report vulnerabilities through GitHub private vulnerability reporting or a private security advisory. Do not open a public issue for an active vulnerability.

Include:

- Affected endpoint or file
- Reproduction steps
- Expected impact
- Any suggested fix

Do not include live secrets, production tokens, or private Cloudflare account details in the report.

## Secret Handling

`CAP_SITE_SECRET` must be stored with Wrangler secrets in production:

```sh
wrangler secret put CAP_SITE_SECRET
```

Never commit `.dev.vars`, `.env`, production tokens, or Cloudflare credentials.
