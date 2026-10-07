import { AppError } from "../errors.js";

export function hostedConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new AppError(`Missing ${name}.`, "CONFIG");
    return value;
  };
  const dev = env.HOSTED_DEV_MODE === "1";
  const url = (name: string, internal = false) => {
    const value = new URL(required(name));
    const local = ["127.0.0.1", "localhost", "keycloak"].includes(value.hostname);
    if (value.username || value.password || value.search || value.hash ||
      (value.protocol !== "https:" && !(dev && local && value.protocol === "http:"))) {
      throw new AppError(`${name} must use HTTPS (explicit local development permits loopback HTTP).`, "CONFIG");
    }
    if (!internal && value.hostname === "keycloak") throw new AppError(`${name} must be browser accessible.`, "CONFIG");
    return value.href.replace(/\/$/, "");
  };
  const publicUrl = url("HOSTED_PUBLIC_URL");
  if (new URL(publicUrl).pathname !== "/") throw new AppError("HOSTED_PUBLIC_URL must be an origin without a path.", "CONFIG");
  const issuer = url("OIDC_ISSUER");
  const port = Number(env.PORT ?? "8000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new AppError("Invalid PORT.", "CONFIG");
  const retentionDays = Number(env.REPORT_RETENTION_DAYS ?? "7");
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 90) throw new AppError("REPORT_RETENTION_DAYS must be 1–90.", "CONFIG");
  return {
    dev, port, publicUrl, retentionDays, databaseUrl: required("DATABASE_URL"), encryptionKey: required("HOSTED_ENCRYPTION_KEY"),
    identity: { issuer, audience: publicUrl + "/mcp", jwksUrl: new URL(url("OIDC_JWKS_URL", true)), requiredScope: "ctm-voiceai:use" },
    oauth: { publicUrl, oidcClientId: required("OIDC_PORTAL_CLIENT_ID"),
      oidcAuthorizeUrl: url("OIDC_AUTHORIZE_URL"), oidcTokenUrl: url("OIDC_TOKEN_URL", true),
      ctmClientId: required("CTM_HOSTED_CLIENT_ID"),
      ctmAuthorizeUrl: "https://app.calltrackingmetrics.com/oauth2/authorize",
      ctmTokenUrl: "https://api.calltrackingmetrics.com/oauth2/token" }
  };
}
