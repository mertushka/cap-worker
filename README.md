# CAP Worker

> A Cloudflare Worker implementation of `@cap.js/server` with Hono framework, Durable Objects, and comprehensive security features.

---

#### What is Cap?

[Cap](https://github.com/tiagorangel1/cap) is a fast, private, and simple CAPTCHA alternative that uses proof-of-work instead of tracking or complex puzzles.

Learn more: [capjs.js.org](https://capjs.js.org/)

---

## Features

- **Fast & Lightweight**: Runs on Cloudflare's edge network for global low latency
- **Durable Objects**: Durable Objects with Storage API for reliable challenge/solution coordination
- **Secure by Design**: Built-in secure headers and CORS protection
- **Rate Limiting**: IP-based rate limiting to prevent API abuse and spam
- **TypeScript**: Full type safety included
- **CORS Enabled**: Configurable cross-origin resource sharing

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/)

### Installation

1. Install dependencies:
   ```sh
   npm install
   ```
2. Configure your `wrangler.jsonc` as needed.

### Development

Start a local development server:

```sh
npm run dev
```

### Types

Generate TypeScript definitions for Cloudflare bindings:

```sh
npm run cf-typegen
```

### Deployment

Deploy to Cloudflare:

```sh
npm run deploy
```

## References

- [CAP GitHub Repository](https://github.com/tiagorangel1/cap)
- [CAP Documentation](https://capjs.js.org/)
- [Hono Framework](https://hono.dev/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Durable Objects](https://developers.cloudflare.com/workers/runtime-apis/durable-objects/)

## License

MIT
