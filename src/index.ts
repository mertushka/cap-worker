import { type Context, Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { validator } from "hono/validator";
import {
	Cap,
	type ChallengeConfig,
	type Solution,
	type StorageHooks,
	type TokenConfig,
} from "./cap";
import { CapStore } from "./cap-store";

export { CapStore };

type AppBindings = {
	Bindings: RuntimeBindings;
};

type JsonRecord = Record<string, unknown>;
type RuntimeBindings = Omit<
	CloudflareBindings,
	"CAP_ALLOWED_ORIGINS" | "CAP_STORE"
> & {
	CAP_STORE: DurableObjectNamespace<CapStore>;
	CAP_ALLOWED_ORIGINS?: string;
	CAP_SITE_SECRET?: string;
};
type ValidateTokenBody = TokenConfig & {
	token?: string;
};
type SiteVerifyBody = TokenConfig & {
	secret?: string;
	response?: string;
};
type RouteRateLimitOptions = {
	name: string;
	binding:
		| "CHALLENGE_RATE_LIMITER"
		| "REDEEM_RATE_LIMITER"
		| "VERIFY_RATE_LIMITER";
	limit: number;
	period: number;
};

const app = new Hono<AppBindings>();

const SHA256_HEX_LENGTH = 64;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const DEFAULT_CHALLENGE_COUNT = 50;
const DEFAULT_CHALLENGE_SIZE = 32;
const DEFAULT_CHALLENGE_DIFFICULTY = 4;
const DEFAULT_CHALLENGE_EXPIRES_MS = 10 * 60 * 1000;
const MAX_CHALLENGE_COUNT = 100;
const MAX_CHALLENGE_SIZE = 128;
const MAX_CHALLENGE_DIFFICULTY = 8;
const MAX_CHALLENGE_EXPIRES_MS = 30 * 60 * 1000;
const MIN_CHALLENGE_EXPIRES_MS = 60 * 1000;
const CHALLENGE_RATE_LIMIT = {
	name: "challenge",
	binding: "CHALLENGE_RATE_LIMITER",
	limit: 30,
	period: 60,
} satisfies RouteRateLimitOptions;
const REDEEM_RATE_LIMIT = {
	name: "redeem",
	binding: "REDEEM_RATE_LIMITER",
	limit: 60,
	period: 60,
} satisfies RouteRateLimitOptions;
const VALIDATE_RATE_LIMIT = {
	name: "validate",
	binding: "VERIFY_RATE_LIMITER",
	limit: 120,
	period: 60,
} satisfies RouteRateLimitOptions;

for (const route of ["/challenge", "/redeem", "/validate"]) {
	app.use(
		route,
		cors({
			origin: corsOrigin,
			allowMethods: ["POST", "OPTIONS"],
			allowHeaders: ["content-type", "authorization"],
			exposeHeaders: ["x-ratelimit-limit", "x-ratelimit-period", "retry-after"],
			maxAge: 600,
		}),
	);
}

const jsonBodyLimit = bodyLimit({
	maxSize: MAX_JSON_BODY_BYTES,
	onError: (c) => c.json({ success: false, message: "Payload too large" }, 413),
});

const redeemBodyValidator = validator(
	"json",
	(value, c): Solution | Response => {
		if (
			!isJsonRecord(value) ||
			typeof value.token !== "string" ||
			!isNumberArray(value.solutions)
		) {
			return invalidBody(c);
		}

		return {
			token: value.token,
			solutions: value.solutions,
		};
	},
);

const routes = app
	.get("/api", (c) => {
		return c.json({
			name: "cap-worker",
			publicTester: "GET /",
			endpoints: {
				createChallenge: "POST /challenge",
				redeemChallenge: "POST /redeem",
				validateToken: "POST /validate",
				siteVerify: "POST /siteverify",
			},
			limits: {
				challenge: {
					defaults: {
						challengeCount: DEFAULT_CHALLENGE_COUNT,
						challengeSize: DEFAULT_CHALLENGE_SIZE,
						challengeDifficulty: DEFAULT_CHALLENGE_DIFFICULTY,
						expiresMs: DEFAULT_CHALLENGE_EXPIRES_MS,
					},
					max: {
						challengeCount: MAX_CHALLENGE_COUNT,
						challengeSize: MAX_CHALLENGE_SIZE,
						challengeDifficulty: MAX_CHALLENGE_DIFFICULTY,
						expiresMs: MAX_CHALLENGE_EXPIRES_MS,
					},
				},
				rate: {
					challenge: `${CHALLENGE_RATE_LIMIT.limit}/min`,
					redeem: `${REDEEM_RATE_LIMIT.limit}/min`,
					validate: `${VALIDATE_RATE_LIMIT.limit}/min`,
				},
			},
		});
	})
	.post(
		"/challenge",
		rateLimit(CHALLENGE_RATE_LIMIT),
		jsonBodyLimit,
		async (c) => {
			const config = await readChallengeConfigBody(c);

			if (config instanceof Response) return config;

			const cap = createCap(c.env);
			const challenge = await cap.createChallenge(
				withChallengeDefaults(config),
			);

			return c.json(challenge);
		},
	)
	.post(
		"/redeem",
		rateLimit(REDEEM_RATE_LIMIT),
		jsonBodyLimit,
		redeemBodyValidator,
		async (c) => {
			const cap = createCap(c.env);
			const result = await cap.redeemChallenge(c.req.valid("json"));

			return c.json(result, result.success ? 200 : 400);
		},
	)
	.post(
		"/validate",
		rateLimit(VALIDATE_RATE_LIMIT),
		jsonBodyLimit,
		async (c) => {
			const body = await readValidateTokenBody(c);

			if (body instanceof Response) return body;

			const headerToken = readBearerToken(c.req.header("Authorization"));
			const token = body.token ?? headerToken;
			const cap = createCap(c.env);
			const result = await cap.validateToken(token ?? "", body);

			return c.json(result, result.success ? 200 : 401);
		},
	)
	.post(
		"/siteverify",
		rateLimit(VALIDATE_RATE_LIMIT),
		jsonBodyLimit,
		async (c) => {
			const body = await readSiteVerifyBody(c);

			if (body instanceof Response) return body;

			const isSecretValid = await verifySiteSecret(c.env, body.secret);

			if (!isSecretValid) {
				return c.json(
					{ success: false, "error-codes": ["invalid-input-secret"] },
					200,
				);
			}

			const cap = createCap(c.env);
			const result = await cap.validateToken(body.response ?? "", body);

			return c.json(
				result.success
					? { success: true }
					: { success: false, "error-codes": ["invalid-input-response"] },
				200,
			);
		},
	);

app.notFound((c) => c.json({ success: false, message: "Not found" }, 404));

app.onError((error, c) => {
	if (error instanceof HTTPException) {
		return c.json({ success: false, message: error.message }, error.status);
	}

	console.error(
		JSON.stringify({
			level: "error",
			event: "request_failed",
			error: String(error),
		}),
	);

	return c.json({ success: false, message: "Internal server error" }, 500);
});

export type AppType = typeof routes;

function createCap(env: RuntimeBindings): Cap {
	return new Cap({
		disableAutoCleanup: true,
		noFSState: true,
		storage: createDurableObjectStorage(env),
	});
}

function createDurableObjectStorage(env: RuntimeBindings): StorageHooks {
	return {
		challenges: {
			store: (token, data) =>
				challengeShard(env, token).storeChallenge(token, data),
			read: (token) => challengeShard(env, token).readChallenge(token),
			delete: (token) => challengeShard(env, token).deleteChallenge(token),
			take: (token) => challengeShard(env, token).takeChallenge(token),
			deleteExpired: () => Promise.resolve(),
		},
		tokens: {
			store: (tokenKey, expires) =>
				tokenShard(env, tokenKey).storeToken(tokenKey, expires),
			get: (tokenKey) => tokenShard(env, tokenKey).getToken(tokenKey),
			delete: (tokenKey) => tokenShard(env, tokenKey).deleteToken(tokenKey),
			consume: (tokenKey, keepToken) =>
				tokenShard(env, tokenKey).consumeToken(tokenKey, keepToken),
			deleteExpired: () => Promise.resolve(),
		},
	};
}

function invalidBody(c: Context<AppBindings>): Response {
	return c.json({ success: false, message: "Invalid body" }, 400);
}

function invalidSiteVerifyBody(c: Context<AppBindings>): Response {
	return c.json({ success: false, "error-codes": ["bad-request"] }, 400);
}

async function readChallengeConfigBody(
	c: Context<AppBindings>,
): Promise<ChallengeConfig | Response> {
	if (!hasRequestBody(c.req.raw)) return {};

	let value: unknown;

	try {
		value = await c.req.json();
	} catch {
		return invalidBody(c);
	}

	if (!isJsonRecord(value)) return invalidBody(c);

	const challengeCount = optionalBoundedInteger(
		value.challengeCount,
		DEFAULT_CHALLENGE_COUNT,
		MAX_CHALLENGE_COUNT,
	);
	const challengeSize = optionalBoundedInteger(
		value.challengeSize,
		DEFAULT_CHALLENGE_SIZE,
		MAX_CHALLENGE_SIZE,
	);
	const challengeDifficulty = optionalBoundedInteger(
		value.challengeDifficulty,
		DEFAULT_CHALLENGE_DIFFICULTY,
		Math.min(MAX_CHALLENGE_DIFFICULTY, SHA256_HEX_LENGTH),
	);
	const expiresMs = optionalBoundedInteger(
		value.expiresMs,
		MIN_CHALLENGE_EXPIRES_MS,
		MAX_CHALLENGE_EXPIRES_MS,
	);
	const store = optionalBoolean(value.store);

	if (
		challengeCount === null ||
		challengeSize === null ||
		challengeDifficulty === null ||
		expiresMs === null ||
		store === null
	) {
		return invalidBody(c);
	}

	return {
		challengeCount,
		challengeSize,
		challengeDifficulty,
		expiresMs,
		store,
	};
}

function withChallengeDefaults(config: ChallengeConfig): ChallengeConfig {
	return {
		challengeCount: config.challengeCount ?? DEFAULT_CHALLENGE_COUNT,
		challengeSize: config.challengeSize ?? DEFAULT_CHALLENGE_SIZE,
		challengeDifficulty:
			config.challengeDifficulty ?? DEFAULT_CHALLENGE_DIFFICULTY,
		expiresMs: config.expiresMs ?? DEFAULT_CHALLENGE_EXPIRES_MS,
		store: config.store,
	};
}

async function readValidateTokenBody(
	c: Context<AppBindings>,
): Promise<ValidateTokenBody | Response> {
	if (!hasRequestBody(c.req.raw)) return {};

	let value: unknown;

	try {
		value = await c.req.json();
	} catch {
		return invalidBody(c);
	}

	if (!isJsonRecord(value)) return invalidBody(c);

	const keepToken = optionalBoolean(value.keepToken);

	if (
		(value.token !== undefined && typeof value.token !== "string") ||
		keepToken === null
	) {
		return invalidBody(c);
	}

	return {
		token: value.token,
		keepToken,
	};
}

async function readSiteVerifyBody(
	c: Context<AppBindings>,
): Promise<SiteVerifyBody | Response> {
	if (!hasRequestBody(c.req.raw)) return invalidSiteVerifyBody(c);

	let value: unknown;

	try {
		value = await parseRequestBody(c);
	} catch {
		return invalidSiteVerifyBody(c);
	}

	if (!isJsonRecord(value)) return invalidSiteVerifyBody(c);

	const keepToken = optionalBoolean(value.keepToken);

	if (
		(value.secret !== undefined && typeof value.secret !== "string") ||
		(value.response !== undefined && typeof value.response !== "string") ||
		keepToken === null
	) {
		return invalidSiteVerifyBody(c);
	}

	return {
		secret: value.secret,
		response: value.response,
		keepToken,
	};
}

async function parseRequestBody(c: Context<AppBindings>): Promise<unknown> {
	const contentType = c.req.header("content-type")?.toLowerCase() ?? "";

	if (
		contentType.includes("application/x-www-form-urlencoded") ||
		contentType.includes("multipart/form-data")
	) {
		return await c.req.parseBody();
	}

	return await c.req.json();
}

function hasRequestBody(request: Request): boolean {
	const contentLength = request.headers.get("content-length");

	if (contentLength !== null) {
		return Number(contentLength) > 0;
	}

	return request.body !== null || request.headers.has("transfer-encoding");
}

function challengeShard(
	env: RuntimeBindings,
	token: string,
): DurableObjectStub<CapStore> {
	return env.CAP_STORE.getByName(`challenge:${shardKey(token)}`);
}

function tokenShard(
	env: RuntimeBindings,
	tokenKey: string,
): DurableObjectStub<CapStore> {
	const [id] = tokenKey.split(":");

	return env.CAP_STORE.getByName(`token:${shardKey(id)}`);
}

function shardKey(value: string): string {
	return value.slice(0, 2) || "default";
}

function rateLimit(
	options: RouteRateLimitOptions,
): MiddlewareHandler<AppBindings> {
	return async (c, next) => {
		const clientKey = rateLimitKey(c, options.name);
		const result = await c.env[options.binding].limit({ key: clientKey });

		setRateLimitHeaders(c, options);

		if (!result.success) {
			c.header("retry-after", String(options.period));

			return c.json({ success: false, message: "Rate limit exceeded" }, 429);
		}

		await next();
	};
}

function rateLimitKey(c: Context<AppBindings>, name: string): string {
	const clientId =
		c.req.header("authorization") ??
		c.req.query("siteKey") ??
		c.req.header("cf-connecting-ip") ??
		c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
		"local";

	return `${name}:${clientId}`;
}

function setRateLimitHeaders(
	c: Context<AppBindings>,
	options: RouteRateLimitOptions,
): void {
	c.header("x-ratelimit-limit", String(options.limit));
	c.header("x-ratelimit-period", String(options.period));
}

function corsOrigin(origin: string, c: Context<AppBindings>): string | null {
	const allowedOrigins = parseAllowedOrigins(c.env.CAP_ALLOWED_ORIGINS);

	if (allowedOrigins.includes("*")) return origin || "*";
	if (!origin || !allowedOrigins.includes(origin)) return null;

	return origin;
}

function parseAllowedOrigins(value: string | undefined): string[] {
	return (
		value
			?.split(",")
			.map((origin) => origin.trim())
			.filter(Boolean) ?? []
	);
}

async function verifySiteSecret(
	env: RuntimeBindings,
	provided: string | undefined,
): Promise<boolean> {
	if (!env.CAP_SITE_SECRET) return true;
	if (!provided) return false;

	return await timingSafeStringEqual(provided, env.CAP_SITE_SECRET);
}

async function timingSafeStringEqual(a: string, b: string): Promise<boolean> {
	const [aHash, bHash] = await Promise.all([
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(a)),
		crypto.subtle.digest("SHA-256", new TextEncoder().encode(b)),
	]);
	const aBytes = new Uint8Array(aHash);
	const bBytes = new Uint8Array(bHash);
	let diff = aBytes.length ^ bBytes.length;

	for (let index = 0; index < aBytes.length; index += 1) {
		diff |= aBytes[index] ^ bBytes[index];
	}

	return diff === 0;
}

function readBearerToken(value: string | undefined): string | undefined {
	if (!value) return undefined;

	const match = value.match(/^Bearer\s+(.+)$/i);

	return match?.[1];
}

function isJsonRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNumberArray(value: unknown): value is number[] {
	return (
		Array.isArray(value) &&
		value.every((item) => Number.isSafeInteger(item) && item >= 0)
	);
}

function optionalBoundedInteger(
	value: unknown,
	min: number,
	max: number,
): number | undefined | null {
	if (value === undefined) return undefined;
	if (typeof value !== "number") return null;

	return Number.isSafeInteger(value) && value >= min && value <= max
		? value
		: null;
}

function optionalBoolean(value: unknown): boolean | undefined | null {
	if (value === undefined) return undefined;

	return typeof value === "boolean" ? value : null;
}

export default app;
