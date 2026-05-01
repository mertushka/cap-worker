import {
	createExecutionContext,
	reset,
	waitOnExecutionContext,
} from "cloudflare:test";
import { env as cloudflareEnv } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { sha256 } from "../src/cap";
import type { CapStore } from "../src/cap-store";
import worker from "../src/index";

type TestEnv = Omit<CloudflareBindings, "CAP_ALLOWED_ORIGINS" | "CAP_STORE"> & {
	CAP_STORE: DurableObjectNamespace<CapStore>;
	CAP_ALLOWED_ORIGINS?: string;
	CAP_SITE_SECRET?: string;
	CHALLENGE_RATE_LIMITER: RateLimit;
	REDEEM_RATE_LIMITER: RateLimit;
	VERIFY_RATE_LIMITER: RateLimit;
};

type ChallengeResponse = {
	challenge: {
		c: number;
		s: number;
		d: number;
	};
	token: string;
	expires: number;
};

afterEach(async () => {
	await reset();
});

describe("cap worker", () => {
	it("exposes API metadata away from the public tester root", async () => {
		const testEnv = createTestEnv();
		const response = await fetchWorker("http://example.com/api", testEnv);

		await expect(response.json()).resolves.toMatchObject({
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
						challengeCount: 50,
						challengeSize: 32,
						challengeDifficulty: 4,
						expiresMs: 600000,
					},
				},
			},
		});
	});

	it("creates challenges with production defaults when no body is provided", async () => {
		const testEnv = createTestEnv();
		const challengeResponse = await fetchWorker(
			"http://example.com/challenge",
			testEnv,
			{
				method: "POST",
			},
		);
		const challenge = await challengeResponse.json<ChallengeResponse>();

		expect(challengeResponse.status).toBe(200);
		expect(challenge.challenge).toEqual({ c: 50, s: 32, d: 4 });
		expect(challenge.token).toBeTruthy();
	});

	it("rejects challenge configuration below production defaults", async () => {
		const testEnv = createTestEnv();
		const response = await fetchWorker(
			"http://example.com/challenge",
			testEnv,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ challengeDifficulty: 1 }),
			},
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			success: false,
			message: "Invalid body",
		});
	});

	it("validates a durable token from a bearer header", async () => {
		const testEnv = createTestEnv();
		const token = await seedVerificationToken(testEnv);

		const validateResponse = await fetchWorker(
			"http://example.com/validate",
			testEnv,
			{
				method: "POST",
				headers: { authorization: `Bearer ${token}` },
			},
		);

		expect(validateResponse.status).toBe(200);
		await expect(validateResponse.json()).resolves.toEqual({ success: true });
	});

	it("validates a durable token through the siteverify compatibility endpoint", async () => {
		const testEnv = createTestEnv();
		const token = await seedVerificationToken(testEnv);
		const response = await fetchWorker(
			"http://example.com/siteverify",
			testEnv,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ response: token }),
			},
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ success: true });
	});

	it("rate-limits challenge creation by client", async () => {
		const testEnv = createTestEnv();

		for (let index = 0; index < 30; index += 1) {
			const response = await fetchWorker(
				"http://example.com/challenge",
				testEnv,
				{
					method: "POST",
				},
			);

			expect(response.status).toBe(200);
		}

		const blocked = await fetchWorker("http://example.com/challenge", testEnv, {
			method: "POST",
		});

		expect(blocked.status).toBe(429);
		expect(blocked.headers.get("retry-after")).toBeTruthy();
		await expect(blocked.json()).resolves.toEqual({
			success: false,
			message: "Rate limit exceeded",
		});
	});

	it("allows configured browser origins on public widget routes", async () => {
		const testEnv = createTestEnv({
			CAP_ALLOWED_ORIGINS: "https://site.example",
		});
		const response = await fetchWorker(
			"http://example.com/challenge",
			testEnv,
			{
				method: "OPTIONS",
				headers: {
					origin: "https://site.example",
					"access-control-request-headers": "content-type",
				},
			},
		);

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(
			"https://site.example",
		);
		expect(response.headers.get("access-control-allow-methods")).toContain(
			"POST",
		);
	});

	it("rejects challenge configuration above fixed limits", async () => {
		const testEnv = createTestEnv();
		const response = await fetchWorker(
			"http://example.com/challenge",
			testEnv,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ challengeDifficulty: 65 }),
			},
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toEqual({
			success: false,
			message: "Invalid body",
		});
	});
});

async function fetchWorker(
	input: string,
	testEnv: TestEnv,
	init?: RequestInit,
): Promise<Response> {
	const request = new Request(input, init);
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, testEnv, ctx);

	await waitOnExecutionContext(ctx);

	return response;
}

function createTestEnv(overrides: Partial<TestEnv> = {}): TestEnv {
	return {
		...cloudflareEnv,
		CAP_STORE: cloudflareEnv.CAP_STORE as DurableObjectNamespace<CapStore>,
		CHALLENGE_RATE_LIMITER: createMemoryRateLimit(30),
		REDEEM_RATE_LIMITER: createMemoryRateLimit(60),
		VERIFY_RATE_LIMITER: createMemoryRateLimit(120),
		...overrides,
	};
}

function createMemoryRateLimit(limit: number): RateLimit {
	const counts = new Map<string, number>();

	return {
		async limit({ key }) {
			const count = counts.get(key) ?? 0;

			if (count >= limit) {
				return { success: false };
			}

			counts.set(key, count + 1);

			return { success: true };
		},
	};
}

async function seedVerificationToken(testEnv: TestEnv): Promise<string> {
	const id = "a1a1a1a1a1a1a1a1";
	const verificationToken = "verification-token";
	const hash = await sha256(verificationToken);
	const tokenKey = `${id}:${hash}`;

	await testEnv.CAP_STORE.getByName(`token:${id.slice(0, 2)}`).storeToken(
		tokenKey,
		Date.now() + 60_000,
	);

	return `${id}:${verificationToken}`;
}
