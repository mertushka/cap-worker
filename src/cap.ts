export type ChallengeTuple = [string, string];

export type ChallengeData = {
	challenge: {
		c: number;
		s: number;
		d: number;
	};
	expires: number;
};

export type ChallengeState = {
	challengesList: Record<string, ChallengeData>;
	tokensList: Record<string, number>;
};

export type ChallengeConfig = {
	challengeCount?: number;
	challengeSize?: number;
	challengeDifficulty?: number;
	expiresMs?: number;
	store?: boolean;
};

export type TokenConfig = {
	keepToken?: boolean;
};

export type Solution = {
	token: string;
	solutions: number[];
};

export type ChallengeStorage = {
	store(token: string, data: ChallengeData): Promise<void>;
	read(token: string): Promise<ChallengeData | null>;
	delete(token: string): Promise<void>;
	deleteExpired?(): Promise<void>;
	take?(token: string): Promise<ChallengeData | null>;
};

export type TokenStorage = {
	store(tokenKey: string, expires: number): Promise<void>;
	get(tokenKey: string): Promise<number | null>;
	delete(tokenKey: string): Promise<void>;
	deleteExpired?(): Promise<void>;
	consume?(tokenKey: string, keepToken?: boolean): Promise<boolean>;
};

export type StorageHooks = {
	challenges?: ChallengeStorage;
	tokens?: TokenStorage;
};

export type CapConfig = {
	tokens_store_path?: string;
	state: ChallengeState;
	noFSState: boolean;
	disableAutoCleanup?: boolean;
	storage?: StorageHooks;
};

const DEFAULT_TOKENS_STORE = ".data/tokensList.json";

export async function randomHex(bytesCount: number): Promise<string> {
	const bytes = new Uint8Array(bytesCount);
	crypto.getRandomValues(bytes);

	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

export async function sha256(value: string): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);

	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

export function prng(seed: string, length: number): string {
	function fnv1a(value: string) {
		let hash = 2166136261;

		for (let index = 0; index < value.length; index += 1) {
			hash ^= value.charCodeAt(index);
			hash +=
				(hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
		}

		return hash >>> 0;
	}

	let state = fnv1a(seed);
	let result = "";

	function next() {
		state ^= state << 13;
		state ^= state >>> 17;
		state ^= state << 5;

		return state >>> 0;
	}

	while (result.length < length) {
		const random = next();
		result += random.toString(16).padStart(8, "0");
	}

	return result.substring(0, length);
}

export class Cap {
	private cleanupPromise: Promise<void> | null;
	private lastCleanup: number;
	readonly config: CapConfig;

	constructor(configObj: Partial<CapConfig> = {}) {
		this.cleanupPromise = null;
		this.lastCleanup = 0;
		this.config = {
			tokens_store_path: DEFAULT_TOKENS_STORE,
			noFSState: true,
			state: {
				challengesList: {},
				tokensList: {},
			},
			...configObj,
		};
	}

	private async lazyCleanup(): Promise<void> {
		if (this.config.disableAutoCleanup) return;

		const now = Date.now();
		const fiveMinutes = 5 * 60 * 1000;

		if (now - this.lastCleanup > fiveMinutes) {
			await this.cleanExpiredTokens().catch((error: unknown) => {
				console.error(
					JSON.stringify({
						level: "error",
						event: "cap_cleanup_failed",
						error: String(error),
					}),
				);
			});
			this.lastCleanup = now;
		}
	}

	private async getChallenge(token: string): Promise<ChallengeData | null> {
		if (this.config.storage?.challenges?.read) {
			return (await this.config.storage.challenges.read(token)) || null;
		}

		return this.config.state.challengesList[token] || null;
	}

	private async deleteChallenge(token: string): Promise<void> {
		if (this.config.storage?.challenges?.delete) {
			await this.config.storage.challenges.delete(token);
			return;
		}

		delete this.config.state.challengesList[token];
	}

	private async takeChallenge(token: string): Promise<ChallengeData | null> {
		if (this.config.storage?.challenges?.take) {
			return (await this.config.storage.challenges.take(token)) || null;
		}

		const challengeData = await this.getChallenge(token);
		await this.deleteChallenge(token);

		return challengeData;
	}

	async createChallenge(conf?: ChallengeConfig): Promise<{
		challenge: { c: number; s: number; d: number };
		token?: string;
		expires: number;
	}> {
		await this.lazyCleanup();

		const challenge = {
			c: conf?.challengeCount ?? 50,
			s: conf?.challengeSize ?? 32,
			d: conf?.challengeDifficulty ?? 4,
		};

		const token = await randomHex(25);
		const expires = Date.now() + (conf?.expiresMs ?? 600000);

		if (conf?.store === false) {
			return { challenge, expires };
		}

		const challengeData = { expires, challenge };

		if (this.config.storage?.challenges?.store) {
			await this.config.storage.challenges.store(token, challengeData);
		} else {
			this.config.state.challengesList[token] = challengeData;
		}

		return { challenge, token, expires };
	}

	async redeemChallenge({ token, solutions }: Solution): Promise<{
		success: boolean;
		message?: string;
		token?: string;
		expires?: number;
	}> {
		if (
			!token ||
			!solutions ||
			!Array.isArray(solutions) ||
			solutions.some((solution) => typeof solution !== "number")
		) {
			return { success: false, message: "Invalid body" };
		}

		await this.lazyCleanup();

		const challengeData = await this.takeChallenge(token);

		if (!challengeData || challengeData.expires < Date.now()) {
			return { success: false, message: "Challenge invalid or expired" };
		}

		let index = 0;
		const challenges: ChallengeTuple[] = Array.from(
			{ length: challengeData.challenge.c },
			() => {
				index += 1;

				return [
					prng(`${token}${index}`, challengeData.challenge.s),
					prng(`${token}${index}d`, challengeData.challenge.d),
				];
			},
		);

		const hashes = await Promise.all(
			challenges.map(async ([salt, target], challengeIndex) => {
				if (typeof solutions[challengeIndex] !== "number") return null;

				return {
					hash: await sha256(salt + solutions[challengeIndex]),
					target,
				};
			}),
		);

		const isValid = hashes.every((pair) => pair?.hash.startsWith(pair.target));

		if (!isValid) return { success: false, message: "Invalid solution" };

		const verificationToken = await randomHex(15);
		const expires = Date.now() + 20 * 60 * 1000;
		const hash = await sha256(verificationToken);
		const id = await randomHex(8);
		const tokenKey = `${id}:${hash}`;

		if (this.config.storage?.tokens?.store) {
			await this.config.storage.tokens.store(tokenKey, expires);
		} else {
			this.config.state.tokensList[tokenKey] = expires;
		}

		return { success: true, token: `${id}:${verificationToken}`, expires };
	}

	private async getToken(tokenKey: string): Promise<number | null> {
		if (this.config.storage?.tokens?.get) {
			return await this.config.storage.tokens.get(tokenKey);
		}

		return this.config.state.tokensList[tokenKey] || null;
	}

	private async deleteToken(tokenKey: string): Promise<void> {
		if (this.config.storage?.tokens?.delete) {
			await this.config.storage.tokens.delete(tokenKey);
			return;
		}

		delete this.config.state.tokensList[tokenKey];
	}

	async validateToken(
		token: string,
		conf?: TokenConfig,
	): Promise<{ success: boolean }> {
		await this.lazyCleanup();

		if (!token || typeof token !== "string") {
			return { success: false };
		}

		const parts = token.split(":");

		if (parts.length !== 2 || !parts[0] || !parts[1]) {
			return { success: false };
		}

		const [id, verificationToken] = parts;
		const hash = await sha256(verificationToken);
		const key = `${id}:${hash}`;

		if (this.config.storage?.tokens?.consume) {
			return {
				success: await this.config.storage.tokens.consume(key, conf?.keepToken),
			};
		}

		const tokenExpires = await this.getToken(key);

		if (tokenExpires && tokenExpires > Date.now()) {
			if (!conf?.keepToken) {
				await this.deleteToken(key);
			}

			return { success: true };
		}

		return { success: false };
	}

	private async cleanExpiredTokens(): Promise<boolean> {
		const now = Date.now();
		let tokensChanged = false;

		if (this.config.storage?.challenges?.deleteExpired) {
			await this.config.storage.challenges.deleteExpired();
		} else if (!this.config.storage?.challenges) {
			const expired = Object.entries(this.config.state.challengesList)
				.filter(([, value]) => value.expires < now)
				.map(([key]) => key);

			await Promise.all(expired.map((key) => this.deleteChallenge(key)));
		}

		if (this.config.storage?.tokens?.deleteExpired) {
			await this.config.storage.tokens.deleteExpired();
		} else if (!this.config.storage?.tokens) {
			for (const key in this.config.state.tokensList) {
				if (this.config.state.tokensList[key] < now) {
					await this.deleteToken(key);
					tokensChanged = true;
				}
			}
		}

		return tokensChanged;
	}

	async cleanup(): Promise<void> {
		if (this.cleanupPromise) return this.cleanupPromise;

		this.cleanupPromise = (async () => {
			await this.cleanExpiredTokens();
		})();

		return this.cleanupPromise;
	}
}
