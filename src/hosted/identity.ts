import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { AppError } from "../errors.js";

export type Caller = Readonly<{ owner: string; issuer: string; subject: string; expiresAt: number }>;
export type VerifyCaller = (token: string) => Promise<Caller>;

export function ownerKey(issuer: string, subject: string): string {
  return "user:" + createHash("sha256").update(JSON.stringify([issuer, subject])).digest("hex");
}

/** Only pinned keys/issuer/audience are trusted; headers and tool arguments never select identity. */
export function createVerifier(options: {
  issuer: string; audience: string; jwksUrl: URL; requiredScope: string;
}, key?: JWTVerifyGetKey): VerifyCaller {
  const resolveKey = key ?? createRemoteJWKSet(options.jwksUrl, { timeoutDuration: 5000 });
  return async token => {
    try {
      const { payload } = await jwtVerify(token, resolveKey, {
        issuer: options.issuer, audience: options.audience, algorithms: ["RS256"],
        requiredClaims: ["iss", "sub", "aud", "exp", "iat"], clockTolerance: 0
      });
      if (!payload.sub || !payload.iss || !payload.exp) throw new Error("claims");
      const scopes = typeof payload.scope === "string" ? payload.scope.split(/\s+/) : [];
      if (!scopes.includes(options.requiredScope)) throw new AppError("Required MCP scope is missing.", "FORBIDDEN", 403);
      return Object.freeze({
        owner: ownerKey(payload.iss, payload.sub), issuer: payload.iss,
        subject: payload.sub, expiresAt: payload.exp * 1000
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("A valid access token for this MCP server is required.", "UNAUTHORIZED", 401);
    }
  };
}
export function assertLive(caller: Caller) {
  if (caller.expiresAt <= Date.now()) throw new AppError("Caller token expired.", "UNAUTHORIZED", 401);
}
