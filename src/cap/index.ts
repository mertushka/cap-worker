/** Challenge tuple: [salt, target] */
export type ChallengeTuple = [string, string];

export interface ChallengeData {
  challenge: { c: number; s: number; d: number };
  expires: number;
}

export interface ChallengeState {
  challengesList: Record<string, ChallengeData>;
  tokensList: Record<string, number>;
}

export interface ChallengeConfig {
  challengeCount?: number; // default: 50
  challengeSize?: number; // default: 32
  challengeDifficulty?: number; // default: 4
  expiresMs?: number; // default: 600000
  store?: boolean; // default: true
}

export interface TokenConfig {
  keepToken?: boolean;
}

export interface Solution {
  token: string;
  solutions: number[];
}

export interface ChallengeStorage {
  store(token: string, data: ChallengeData): Promise<void>;
  read(token: string): Promise<ChallengeData | null>;
  delete(token: string): Promise<void>;
  listExpired(): Promise<string[]>;
}

export interface TokenStorage {
  store(tokenKey: string, expires: number): Promise<void>;
  get(tokenKey: string): Promise<number | null>;
  delete(tokenKey: string): Promise<void>;
  listExpired(): Promise<string[]>;
}

export interface StorageHooks {
  challenges?: ChallengeStorage;
  tokens?: TokenStorage;
}

export interface CapConfig {
  storage: StorageHooks;
}

/** Deterministic hex string generator from a seed */
function prng(seed: string, length: number): string {
  function fnv1a(str: string): number {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
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
    const rnd = next();
    result += rnd.toString(16).padStart(8, "0");
  }

  return result.substring(0, length);
}

/** Random hex string from N bytes */
function randomHex(bytesLength: number): string {
  const array = new Uint8Array(bytesLength);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 hex digest */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default class Cap {
  config: CapConfig;

  constructor(configObj: CapConfig) {
    this.config = configObj;
  }

  private async _getChallenge(token: string): Promise<ChallengeData | null> {
    if (this.config.storage?.challenges?.read) {
      return (await this.config.storage.challenges.read(token)) || null;
    }
    return null;
  }

  private async _deleteChallenge(token: string): Promise<void> {
    if (this.config.storage?.challenges?.delete) {
      await this.config.storage.challenges.delete(token);
    }
  }

  async createChallenge(conf?: ChallengeConfig): Promise<{
    challenge: { c: number; s: number; d: number };
    token?: string;
    expires: number;
  }> {
    const challenge = {
      c: conf?.challengeCount ?? 50,
      s: conf?.challengeSize ?? 32,
      d: conf?.challengeDifficulty ?? 4,
    };

    const token = randomHex(25);
    const expires = Date.now() + (conf?.expiresMs ?? 600000);

    if (conf && conf.store === false) {
      return { challenge, expires };
    }

    const challengeData: ChallengeData = { expires, challenge };

    if (this.config.storage?.challenges?.store) {
      await this.config.storage.challenges.store(token, challengeData);
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
      solutions.some((s) => typeof s !== "number")
    ) {
      return { success: false, message: "Invalid body" };
    }

    const challengeData = await this._getChallenge(token);
    await this._deleteChallenge(token);

    if (!challengeData || challengeData.expires < Date.now()) {
      return { success: false, message: "Challenge invalid or expired" };
    }

    let i = 0;

    const challenges: ChallengeTuple[] = Array.from(
      { length: challengeData.challenge.c },
      () => {
        i = i + 1;
        return [
          prng(`${token}${i}`, challengeData.challenge.s),
          prng(`${token}${i}d`, challengeData.challenge.d),
        ];
      }
    );

    const isValidArr = await Promise.all(
      challenges.map(async ([salt, target], idx) => {
        return (
          solutions[idx] !== undefined &&
          (await sha256Hex(salt + solutions[idx])).startsWith(target)
        );
      })
    );

    if (!isValidArr.every(Boolean)) {
      return { success: false, message: "Invalid solution" };
    }

    const vertoken = randomHex(15);
    const expires = Date.now() + 20 * 60 * 1000;
    const hash = await sha256Hex(vertoken);
    const id = randomHex(8);
    const tokenKey = `${id}:${hash}`;

    if (this.config.storage?.tokens?.store) {
      await this.config.storage.tokens.store(tokenKey, expires);
    }

    return { success: true, token: `${id}:${vertoken}`, expires };
  }

  private async _getToken(tokenKey: string): Promise<number | null> {
    if (this.config.storage?.tokens?.get) {
      return await this.config.storage.tokens.get(tokenKey);
    }
    return null;
  }

  private async _deleteToken(tokenKey: string): Promise<void> {
    if (this.config.storage?.tokens?.delete) {
      await this.config.storage.tokens.delete(tokenKey);
    }
  }

  async validateToken(
    token: string,
    conf?: TokenConfig
  ): Promise<{ success: boolean }> {
    if (!token || typeof token !== "string") {
      return { success: false };
    }

    const parts = token.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { success: false };
    }

    const [id, vertoken] = parts;
    const hash = await sha256Hex(vertoken);
    const key = `${id}:${hash}`;

    const tokenExpires = await this._getToken(key);

    if (!tokenExpires) {
      return { success: false };
    }

    if (tokenExpires > Date.now()) {
      if (!conf?.keepToken) {
        await this._deleteToken(key);
      }
      return { success: true };
    }

    return { success: false };
  }

  private async _cleanExpiredTokens(): Promise<void> {
    if (this.config.storage?.challenges?.listExpired) {
      const expiredChallenges =
        await this.config.storage.challenges.listExpired();

      await Promise.all(
        expiredChallenges.map(async (token) => {
          await this._deleteChallenge(token);
        })
      );
    } else {
      console.warn(
        "[cap] challenge storage hooks provided but no listExpired, couldn't delete expired challenges"
      );
    }

    if (this.config.storage?.tokens?.listExpired) {
      const expiredTokens = await this.config.storage.tokens.listExpired();
      await Promise.all(
        expiredTokens.map(async (tokenKey) => {
          await this._deleteToken(tokenKey);
        })
      );
    } else {
      console.warn(
        "[cap] token storage hooks provided but no listExpired, couldn't delete expired tokens"
      );
    }
  }

  async cleanup(): Promise<void> {
    await this._cleanExpiredTokens();
  }
}
