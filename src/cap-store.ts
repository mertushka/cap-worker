import { DurableObject } from "cloudflare:workers";
import type { ChallengeData } from "./cap";

type ChallengeRow = {
	data: string;
	expires: number;
};

type TokenRow = {
	expires: number;
};

export class CapStore extends DurableObject<CloudflareBindings> {
	constructor(ctx: DurableObjectState, env: CloudflareBindings) {
		super(ctx, env);

		this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS challenges (
        token TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_challenges_expires ON challenges (expires);
      CREATE TABLE IF NOT EXISTS tokens (
        token_key TEXT PRIMARY KEY,
        expires INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_expires ON tokens (expires);
    `);
	}

	async storeChallenge(token: string, data: ChallengeData): Promise<void> {
		this.deleteExpiredRows(Date.now());
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO challenges (token, data, expires) VALUES (?, ?, ?)",
			token,
			JSON.stringify(data),
			data.expires,
		);
		this.ctx.waitUntil(this.scheduleCleanup(data.expires));
	}

	async readChallenge(token: string): Promise<ChallengeData | null> {
		this.deleteExpiredRows(Date.now());

		const row = this.ctx.storage.sql
			.exec<ChallengeRow>(
				"SELECT data, expires FROM challenges WHERE token = ?",
				token,
			)
			.toArray()[0];

		return row ? this.parseChallengeRow(token, row) : null;
	}

	async takeChallenge(token: string): Promise<ChallengeData | null> {
		const now = Date.now();
		const row = this.ctx.storage.sql
			.exec<ChallengeRow>(
				"SELECT data, expires FROM challenges WHERE token = ?",
				token,
			)
			.toArray()[0];

		this.ctx.storage.sql.exec("DELETE FROM challenges WHERE token = ?", token);

		if (!row || row.expires < now) return null;

		return this.parseChallengeRow(token, row);
	}

	async deleteChallenge(token: string): Promise<void> {
		this.ctx.storage.sql.exec("DELETE FROM challenges WHERE token = ?", token);
	}

	async storeToken(tokenKey: string, expires: number): Promise<void> {
		this.deleteExpiredRows(Date.now());
		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO tokens (token_key, expires) VALUES (?, ?)",
			tokenKey,
			expires,
		);
		this.ctx.waitUntil(this.scheduleCleanup(expires));
	}

	async getToken(tokenKey: string): Promise<number | null> {
		this.deleteExpiredRows(Date.now());

		const row = this.ctx.storage.sql
			.exec<TokenRow>(
				"SELECT expires FROM tokens WHERE token_key = ?",
				tokenKey,
			)
			.toArray()[0];

		return row?.expires ?? null;
	}

	async consumeToken(tokenKey: string, keepToken = false): Promise<boolean> {
		const now = Date.now();
		const row = this.ctx.storage.sql
			.exec<TokenRow>(
				"SELECT expires FROM tokens WHERE token_key = ?",
				tokenKey,
			)
			.toArray()[0];

		if (!row) return false;

		if (row.expires < now) {
			this.ctx.storage.sql.exec(
				"DELETE FROM tokens WHERE token_key = ?",
				tokenKey,
			);
			return false;
		}

		if (!keepToken) {
			this.ctx.storage.sql.exec(
				"DELETE FROM tokens WHERE token_key = ?",
				tokenKey,
			);
		}

		return true;
	}

	async deleteToken(tokenKey: string): Promise<void> {
		this.ctx.storage.sql.exec(
			"DELETE FROM tokens WHERE token_key = ?",
			tokenKey,
		);
	}

	async deleteExpired(): Promise<void> {
		this.deleteExpiredRows(Date.now());
		await this.scheduleNextAlarm();
	}

	async alarm(): Promise<void> {
		this.deleteExpiredRows(Date.now());
		await this.scheduleNextAlarm();
	}

	private parseChallengeRow(
		token: string,
		row: ChallengeRow,
	): ChallengeData | null {
		try {
			return JSON.parse(row.data) as ChallengeData;
		} catch (error) {
			this.ctx.storage.sql.exec(
				"DELETE FROM challenges WHERE token = ?",
				token,
			);
			console.error(
				JSON.stringify({
					level: "error",
					event: "cap_challenge_parse_failed",
					error: String(error),
				}),
			);

			return null;
		}
	}

	private deleteExpiredRows(now: number): void {
		this.ctx.storage.sql.exec("DELETE FROM challenges WHERE expires < ?", now);
		this.ctx.storage.sql.exec("DELETE FROM tokens WHERE expires < ?", now);
	}

	private async scheduleCleanup(expires: number): Promise<void> {
		const currentAlarm = await this.ctx.storage.getAlarm();

		if (!currentAlarm || expires < currentAlarm) {
			await this.ctx.storage.setAlarm(Math.max(expires, Date.now() + 1000));
		}
	}

	private async scheduleNextAlarm(): Promise<void> {
		const nextChallenge = this.ctx.storage.sql
			.exec<TokenRow>(
				"SELECT expires FROM challenges ORDER BY expires ASC LIMIT 1",
			)
			.toArray()[0]?.expires;
		const nextToken = this.ctx.storage.sql
			.exec<TokenRow>("SELECT expires FROM tokens ORDER BY expires ASC LIMIT 1")
			.toArray()[0]?.expires;
		const next = Math.min(
			nextChallenge ?? Number.POSITIVE_INFINITY,
			nextToken ?? Number.POSITIVE_INFINITY,
		);

		if (Number.isFinite(next)) {
			await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
		} else {
			await this.ctx.storage.deleteAlarm();
		}
	}
}
