import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { assertLive, type Caller, type VerifyCaller } from "./identity.js";
import type { CredentialProvider, CtmCredential, HostedStore } from "./contracts.js";

const pendingSchema = z.object({ kind: z.literal("oidc"), verifier: z.string() });
const browserSchema = z.object({ kind: z.literal("browser"), accessToken: z.string() });
const ctmPendingSchema = z.object({
  kind: z.literal("ctm"), verifier: z.string(), owner: z.string(), browser: z.string()
});
const tokenSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1).optional(),
  expires_in: z.coerce.number().positive().finite(),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
  scopes: z.string().optional(), scope: z.string().optional(),
  account_id: z.union([z.string(),z.number()]).nullable().optional()
});
export type OAuthConfig = {
  publicUrl: string; oidcClientId: string; oidcAuthorizeUrl: string; oidcTokenUrl: string;
  ctmClientId: string; ctmAuthorizeUrl: string; ctmTokenUrl: string;
};
const random = () => randomBytes(32).toString("base64url");
const challenge = (value: string) => createHash("sha256").update(value).digest("base64url");
const matches = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const SCOPES = "profile activity reports manage";
const TTL = 10 * 60 * 1000;

/** OAuth belongs to the browser connection flow, never to an LLM tool. */
export class HostedOAuth implements CredentialProvider {
  constructor(
    private readonly store: HostedStore, private readonly config: OAuthConfig,
    private readonly verify: VerifyCaller, private readonly request: typeof fetch = fetch
  ) {}
  private async token(url: string, form: Record<string,string>) {
    let response: Response;
    try {
      response = await this.request(url, { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form), signal: AbortSignal.timeout(15000) });
    } catch { throw new AppError("OAuth outcome is unknown. Start a new connection.", "OAUTH_NETWORK", 502); }
    if (!response.ok) throw new AppError(
      response.status === 429 ? "OAuth provider is rate limited. Try later." : "OAuth provider rejected the request. Check registration and reconnect.",
      response.status === 429 ? "OAUTH_RATE_LIMIT" : "OAUTH_REJECTED", 502);
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new AppError("OAuth provider returned invalid data.", "OAUTH_RESPONSE", 502); }
    const parsed = tokenSchema.safeParse(value);
    if (!parsed.success) throw new AppError("OAuth provider returned invalid data.", "OAUTH_RESPONSE", 502);
    return parsed.data;
  }
  async beginLogin() {
    const state = random(), verifier = random();
    await this.store.putSession(state, { kind: "oidc", verifier }, Date.now() + TTL);
    const url = new URL(this.config.oidcAuthorizeUrl);
    url.search = new URLSearchParams({
      client_id: this.config.oidcClientId, response_type: "code",
      redirect_uri: this.config.publicUrl + "/oidc/callback",
      scope: "openid ctm-voiceai:use", state, code_challenge: challenge(verifier), code_challenge_method: "S256"
    }).toString();
    return { state, url: url.href };
  }
  async finishLogin(state: string, cookieState: string, code: string) {
    if (!matches(state, cookieState)) throw new AppError("Login state mismatch.", "OAUTH_STATE", 400);
    const pending = pendingSchema.safeParse(await this.store.getSession(state, true));
    if (!pending.success) throw new AppError("Login expired or was already used.", "OAUTH_STATE", 400);
    const tokens = await this.token(this.config.oidcTokenUrl, {
      client_id: this.config.oidcClientId, grant_type: "authorization_code", code,
      redirect_uri: this.config.publicUrl + "/oidc/callback", code_verifier: pending.data.verifier
    });
    const caller = await this.verify(tokens.access_token);
    const session = random();
    await this.store.putSession(session, { kind: "browser", accessToken: tokens.access_token },
      Math.min(caller.expiresAt, Date.now() + 60 * 60 * 1000));
    return session;
  }
  async browserCaller(session: string): Promise<Caller> {
    const parsed = browserSchema.safeParse(await this.store.getSession(session));
    if (!parsed.success) throw new AppError("Sign in to the connection page again.", "UNAUTHORIZED", 401);
    return this.verify(parsed.data.accessToken);
  }
  async logoutBrowser(session: string) { await this.store.deleteSession(session); }
  async beginCtm(caller: Caller, browser: string) {
    assertLive(caller);
    const state = random(), verifier = random();
    await this.store.putSession(state, {
      kind: "ctm", verifier, owner: caller.owner, browser: challenge(browser)
    }, Date.now() + TTL);
    const url = new URL(this.config.ctmAuthorizeUrl);
    url.search = new URLSearchParams({
      client_id: this.config.ctmClientId, response_type: "code",
      redirect_uri: this.config.publicUrl + "/ctm/callback", scope: SCOPES,
      state, code_challenge: challenge(verifier), code_challenge_method: "S256"
    }).toString();
    return url.href;
  }
  async finishCtm(caller: Caller, browser: string, state: string, code: string) {
    assertLive(caller);
    const pending = ctmPendingSchema.safeParse(await this.store.getSession(state));
    if (!pending.success || pending.data.owner !== caller.owner || !matches(pending.data.browser, challenge(browser))) {
      throw new AppError("CTM consent must complete in the same signed-in browser that started it.", "OAUTH_STATE", 400);
    }
    const consumed = ctmPendingSchema.safeParse(await this.store.getSession(state, true));
    if (!consumed.success) throw new AppError("CTM login expired or was already used.", "OAUTH_STATE", 400);
    // Serialize login with refresh/logout so an older in-flight refresh cannot overwrite a new login.
    await this.store.credentials(caller.owner, async (_, save) => {
      const tokens = await this.token(this.config.ctmTokenUrl, {
        client_id: this.config.ctmClientId, grant_type: "authorization_code", code,
        redirect_uri: this.config.publicUrl + "/ctm/callback", code_verifier: consumed.data.verifier
      });
      const value = this.credential(tokens);
      this.requireManage(value);
      await save(value);
    });
  }
  private credential(tokens: z.infer<typeof tokenSchema>, prior?: CtmCredential): CtmCredential {
    return {
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? prior?.refreshToken ?? null,
      expiresAt: Date.now() + tokens.expires_in * 1000, clientId: this.config.ctmClientId,
      scopes: tokens.scope ?? tokens.scopes ?? prior?.scopes ?? "",
      accountId: tokens.account_id == null ? prior?.accountId ?? null : String(tokens.account_id)
    };
  }
  private requireManage(value: CtmCredential) {
    if (!value.scopes.split(/[\s,]+/).includes("manage")) {
      throw new AppError("Reconnect CTM and approve manage scope to read VoiceAI configuration.", "CTM_CONNECT_REQUIRED", 403);
    }
  }
  async forAccount(caller: Caller, accountId: string): Promise<string> {
    assertLive(caller);
    if (!/^\d+$/.test(accountId)) throw new AppError("A numeric CTM account is required.", "INVALID_ACCOUNT", 400);
    const outcome = await this.store.credentials(caller.owner, async (current, save) => {
      if (!current || current.clientId !== this.config.ctmClientId) return { error: new AppError("Connect your own CTM account first.", "CTM_CONNECT_REQUIRED", 403) };
      if (current.accountId !== null && current.accountId !== accountId) return { error: new AppError("Your CTM grant is scoped to a different account.", "FORBIDDEN", 403) };
      this.requireManage(current);
      if (current.expiresAt > Date.now() + 60000) return { token: current.accessToken };
      if (!current.refreshToken) return { error: new AppError("CTM connection expired. Reconnect.", "CTM_CONNECT_REQUIRED", 403) };
      try {
        const tokens = await this.token(this.config.ctmTokenUrl, {
          client_id: this.config.ctmClientId, grant_type: "refresh_token", refresh_token: current.refreshToken
        });
        const next = this.credential(tokens, current);
        this.requireManage(next);
        if (next.accountId !== null && next.accountId !== accountId) throw new AppError("Your CTM grant is scoped to a different account.", "FORBIDDEN", 403);
        await save(next);
        return { token: next.accessToken };
      } catch (error) {
        // Commit invalidation on ambiguous rotation, rather than rolling it back with the exception.
        if (!(error instanceof AppError && error.code === "OAUTH_RATE_LIMIT")) await save(null);
        return { error: error instanceof AppError ? error : new AppError("Reconnect CTM.", "CTM_CONNECT_REQUIRED", 403) };
      }
    });
    if (outcome.error) throw outcome.error;
    assertLive(caller);
    return outcome.token!;
  }
  async disconnect(caller: Caller) {
    assertLive(caller);
    await this.store.credentials(caller.owner, async (_, save) => save(null));
  }
}
