import { getAccessToken } from "./oauth.js";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
import { getJson } from "./ctm.js";
const API_BASE = "https://api.calltrackingmetrics.com/api/v1";
function accountSegment(value: string) {
 if (!/^[0-9]+$/.test(value)) throw new AppError("A numeric CTM account id is required.", "NO_ACCOUNT");
 return value;
}
/** OAuth only: a failed refresh must never downgrade to another credential. */
export async function resolveAuthHeader(config: Config) {
  const token = await getAccessToken({ clientId: config.clientId });
  if (!token) throw new AppError("No valid CTM login. Run ctm_voiceai_auth_login.", "NO_AUTH");
  return { header: `Bearer ${token}`, mode: "oauth" as const };
}

/**
 * Resolve credentials and make a lightweight call so we fail fast (and clearly)
 * when the CTM login is missing or expired, instead of midway through a run.
 */
export async function verifyAuth(config: Config, accountId: string) {
  const auth = await resolveAuthHeader(config);
  const url = `${API_BASE}/accounts/${accountSegment(accountId)}/calls?per_page=1`;
  try {
    await getJson(url, auth.header, { timeoutMs: 15000 });
    return auth;
  } catch (err) {
    if (err instanceof AppError && err.status === 401) {
      throw new AppError("CTM rejected the login. Run ctm_voiceai_auth_login to sign in again.", "NO_AUTH", 401);
    }
    if (err instanceof AppError && err.status === 403) {
      throw new AppError("Your CTM login cannot access this account or operation.", "FORBIDDEN", 403);
    }
    throw err;
  }
}
