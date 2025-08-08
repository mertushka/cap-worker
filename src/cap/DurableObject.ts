import { DurableObject } from "cloudflare:workers";

import Cap, { ChallengeData, Solution } from "./index";

export class CapDO extends DurableObject {
  sql = this.ctx.storage.sql;

  cap = new Cap({
    storage: {
      challenges: {
        store: async (token: string, challengeData: ChallengeData) =>
          this.storeChallenge(token, challengeData),
        read: async (token: string) => this.readChallenge(token),
        delete: async (token: string) => this.deleteChallenge(token),
        listExpired: async () => this.listExpiredChallenges(),
      },
      tokens: {
        store: async (token: string, expires: number) =>
          this.storeToken(token, expires),
        get: async (token: string) => this.readToken(token),
        delete: async (token: string) => this.deleteToken(token),
        listExpired: async () => this.listExpiredTokens(),
      },
    },
  });

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);

    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS challenges (
          token TEXT PRIMARY KEY,
          data TEXT NOT NULL,
          expires INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tokens (
          key TEXT PRIMARY KEY,
          expires INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_challenges_expires ON challenges(expires);
        CREATE INDEX IF NOT EXISTS idx_tokens_expires ON tokens(expires);
      `);

      const currentAlarm = await this.ctx.storage.getAlarm();
      if (currentAlarm == null) {
        this.ctx.storage.setAlarm(Date.now() + 1000 * 5 * 60);
      }
    });
  }

  async alarm() {
    console.debug(
      "[cap] alarm triggered, cleaning up expired tokens and challenges"
    );
    await this.cap.cleanup();
  }

  private storeChallenge(token: string, challengeData: ChallengeData) {
    this.sql.exec(
      "INSERT OR REPLACE INTO challenges (token, data, expires) VALUES (?, ?, ?)",
      token,
      JSON.stringify(challengeData.challenge),
      challengeData.expires
    );
  }

  private readChallenge(token: string): ChallengeData | null {
    const row = this.sql
      .exec(
        "SELECT data, expires FROM challenges WHERE token = ? AND expires > ?",
        token,
        Date.now()
      )
      .one();

    return row
      ? {
          challenge: JSON.parse(row.data as string),
          expires: row.expires as number,
        }
      : null;
  }
  private deleteChallenge(token: string) {
    this.sql.exec("DELETE FROM challenges WHERE token = ?", token);
  }

  private listExpiredChallenges(): string[] {
    const rows = this.sql
      .exec("SELECT token FROM challenges WHERE expires <= ?", Date.now())
      .toArray();

    return rows.map((row) => row.token as string);
  }

  private storeToken(token: string, expires: number) {
    this.sql.exec(
      "INSERT OR REPLACE INTO tokens (key, expires) VALUES (?, ?)",
      token,
      expires
    );
  }

  private readToken(token: string): number | null {
    const row = this.sql
      .exec(
        "SELECT expires FROM tokens WHERE key = ? AND expires > ?",
        token,
        Date.now()
      )
      .one();

    return row ? (row.expires as number) : null;
  }

  private deleteToken(token: string) {
    this.sql.exec("DELETE FROM tokens WHERE key = ?", token);
  }

  private listExpiredTokens(): string[] {
    const rows = this.sql
      .exec("SELECT key FROM tokens WHERE expires <= ?", Date.now())
      .toArray();

    return rows.map((row) => row.key as string);
  }

  createChallenge(): Promise<{
    challenge: { c: number; s: number; d: number };
    token?: string;
    expires: number;
  }> {
    return this.cap.createChallenge();
  }

  redeemChallenge(data: Solution): Promise<{
    success: boolean;
    message?: string;
    token?: string;
    expires?: number;
  }> {
    return this.cap.redeemChallenge(data);
  }

  validateToken(token: string): Promise<{ success: boolean }> {
    return this.cap.validateToken(token);
  }

  async cleanup(): Promise<void> {
    await this.cap.cleanup();
  }
}
