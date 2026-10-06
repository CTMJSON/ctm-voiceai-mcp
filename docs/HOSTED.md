# Hosted template: local testing and engineering handoff

This is a separate TypeScript Streamable HTTP entry point (`npm run start:hosted`). The existing stdio entry point and local OAuth configuration continue to work. The supplied Compose deployment is **local development only**. It is not an AgentCore deployment or a production service.

## Free local environment

Keycloak (OIDC login), PostgreSQL (private encrypted storage), and this server are open-source software. Running them on an existing machine has no hosting subscription cost. Use a Docker-compatible engine, such as Colima or Podman, and Compose. An Internet-accessible deployment additionally needs infrastructure, TLS, a domain, and operational ownership; a free tier is not guaranteed by this template.

```sh
npm ci
npm run hosted:setup
# Edit deploy/.env and set CTM_HOSTED_CLIENT_ID to a separate public CTM app.
docker compose -f deploy/compose.yaml up --build -d
node test/compose.mjs
```

The setup generates private passwords and an encryption key in ignored `deploy/.env` (mode 0600). It refuses to overwrite existing files. The generated realm file contains environment references, not passwords. Do not commit either development file. Do not run `docker compose config` without `--quiet` in shared logs: expanded configuration includes secrets.

- MCP endpoint: `http://127.0.0.1:8000/mcp`
- Connection page: `http://127.0.0.1:8000/connect`
- Keycloak: `http://127.0.0.1:8080`; realm `voiceai`
- Test identities: `alice` and `bob`; their generated passwords are in `deploy/.env`.
- Keycloak administration: `admin`, using the generated `KEYCLOAK_ADMIN_PASSWORD`.

Sign into `/connect`, then connect CTM. Use the **same Keycloak identity** in your MCP client. Each user grants their own CTM access; one connection is never shared automatically with another user. The browser session expires with its access token (15 minutes in this realm); sign in again when prompted.

This does not automatically configure Claude or expose localhost to a cloud MCP client. Use the included local smoke test first. To test an interactive OAuth MCP client, register that client's exact callback in Keycloak as a separate public OIDC client, require S256 PKCE, disable implicit/password grants, and attach the `ctm-voiceai:use` client scope/audience mapper. Keycloak dynamic client registration is not enabled here. Client support for pre-registered OAuth client IDs and local URLs varies; verify it before choosing a client. The `voiceai-dev-test` password-grant client exists only for loopback fixture tests and must not be deployed publicly.

The template uses the installed TypeScript MCP SDK's supported protocol revisions (including `2025-11-25`); it does not claim implementation of newer revisions beyond SDK support.

## CTM public client registration

Use a separate public CTM client with this **exact** hosted callback:

```
http://127.0.0.1:8000/ctm/callback
```

Do not replace the existing stdio callback on port 8765 or copy local token files into the server. CTM's OAuth-app form alone does not establish public-client status. For loopback development, CTM dynamic registration can create a public app:

```sh
curl -sS -X POST https://api.calltrackingmetrics.com/oauth2/register \
  -H 'Content-Type: application/json' \
  -d '{"client_name":"VoiceAI hosted development","redirect_uris":["http://127.0.0.1:8000/ctm/callback"],"token_endpoint_auth_method":"none","scope":"profile activity reports manage"}'
```

Confirm the returned registration is public (`token_endpoint_auth_method: none`) and supports all requested scopes. Set its `client_id` as `CTM_HOSTED_CLIENT_ID` in `deploy/.env`. No client secret or Basic fallback is accepted. `manage` is needed for the VoiceAI configuration endpoint, but does not bypass user roles or account permissions. If the app's allowed scopes change, reconnect to obtain a new grant.

CTM's dynamic registration restricts redirect locations. For a public HTTPS deployment, engineering must provision/approve the exact callback and public-client flag; do not assume this loopback registration accepts an arbitrary hosted domain.

Source contracts reviewed for this template:

- [CTM registration](https://github.com/calltracking/phonetrac/blob/master/app/classes/oauth_client_registration.rb): public clients, redirect policy and scope validation.
- [CTM OAuth controller](https://github.com/calltracking/phonetrac/blob/master/app/controllers/oauth2_controller.rb): token exchange and public PKCE validation.
- [API scope policy](https://github.com/calltracking/phonetrac/blob/master/app/controllers/api/v1/base_controller.rb) and [VoiceAI controller](https://github.com/calltracking/phonetrac/blob/master/app/controllers/api/v1/voice_bots_controller.rb): OAuth scope and account-level authorization remain authoritative.

## Request and ownership model

1. Every `/mcp` request requires a bearer JWT verified against pinned JWKS, issuer, resource audience, RS256 signature, expiry, subject and `ctm-voiceai:use` scope. The audience is the exact public `/mcp` URL. Proxy identity headers, cookies, tool arguments, and MCP session IDs cannot select a caller.
2. Owner keys are a hash of the verified `(issuer, subject)` pair. They are never caller-supplied tool inputs. Each request gets its own MCP server instance; no current-user global exists.
3. The browser connection flow uses OIDC authorization-code PKCE, then a separate CTM authorization-code PKCE grant. CTM state is bound to the signed-in owner **and** that browser session, expires after ten minutes, and can be consumed only once. A copied consent link cannot attach a grant through another signed-in browser.
4. CTM credentials are encrypted with AES-256-GCM. Associated data binds ciphertext to its owner and purpose. The incoming identity token is never forwarded to CTM. Account-scoped grants cannot be used to request another account.
5. PostgreSQL advisory transaction locks serialize credential refresh, connection replacement, and disconnect across server replicas. Ambiguous refresh failures invalidate the stored grant rather than replaying a potentially rotated refresh token. A provider 429 retains it for a later retry.
6. Reports are encrypted with owner/report-specific associated data. SQL filters and forced PostgreSQL row-level security both scope reads/writes to the owner. `SET LOCAL` is transaction-scoped so pooled connections cannot retain another request's owner. Startup rejects superuser, RLS-bypass, role-management, and table-owner application roles.
7. Report tools/resources/downloads look up the owner's record first and then recheck CTM access to its account. Foreign and missing report IDs produce the same not-found response. `list_runs` returns only the owner's stored metadata; current CTM access is checked when reading the report content.

This prevents one ordinary caller from selecting another user's records or CTM tokens. RLS is defense in depth against missing query filters, not a boundary against an attacker controlling the application process, encryption key, or database administrator. The trusted server can set the RLS owner context. Production database roles must not inherit administrator/table-owner roles.

## Tools and artifacts

Hosted tools: `ctm_voiceai_get_voice_bots`, `ctm_voiceai_get_calls`, `ctm_voiceai_write_report`, `ctm_voiceai_run_status`, `ctm_voiceai_list_runs`, `ctm_voiceai_get_report`.

The five auth tools are absent. Connection management lives in `/connect`. There are no caller-selected filesystem paths, shell commands, local browser launching, Python subprocesses, or public object URLs. HTML, JSON, CSV, and Markdown are rendered in memory. Downloads use authenticated routes, not bearer tokens in query strings. HTML escapes all supplied prose, uses a restrictive CSP, and is downloaded as an attachment. CSV formula prefixes are neutralized.

The report input follows `src/types.ts` with numeric `account_id` and a required UUID `idempotency_key`. Retry the same key only with identical content. The returned `run_id` names the private stored record. Report URLs and `ctm-voiceai-report://<run_id>/<format>` resources are references, not access grants.

Call pages contain at most 50 calls and bounded transcript text. Coverage plans are capped at 5,000 intended calls; they are not evidence that those calls were analyzed. An assistant can process pages serially if workers are unavailable. Report actual reviewed calls, missing transcripts, date filters, and truncation. Reports describe the supplied analysis and do not modify live agents. Sanitization is heuristic and is not a guarantee of de-identification; prompts and source transcripts may contain sensitive information.

## Operations and limits

- HTTPS is required outside explicit development mode. Set `HOSTED_PUBLIC_URL` to the external origin; preserve its Host header through a trusted proxy. Origin checks reject other browser origins. Forwarded identity/IP headers are not trusted. Cookies are HttpOnly, SameSite=Lax and Secure in production; browser POST actions require the configured Origin.
- Required configuration is validated in `src/hosted/config.ts`: database URL, 32-byte base64 encryption key, CTM public client ID, pinned issuer/JWKS, portal client ID and OIDC endpoints. No home-directory `.env` or stdio config is loaded.
- JWT keys support JWKS rotation. Data encryption currently has one active key: changing it without a controlled decrypt/re-encrypt migration makes existing data unreadable. Store the key separately from the database and backup it using the deployment secret manager. Back up/restore Keycloak, database and encryption key together; issuer/subject changes intentionally do not reuse old records.
- Requests are limited to 2 MiB; report input to 1 MiB; headers to 16 KiB; each process permits 64 active HTTP requests, 240 requests/minute per source address and 120 MCP requests/minute per owner. These are local backstops. Public ingress needs distributed per-user quotas, shared rate limiting, and abuse protection. When behind a proxy, the source-address limit groups its traffic.
- CTM reads have timeouts and pagination bounds; provider errors return safe status/code without response bodies or credentials. GET tools can be retried with capped exponential backoff and jitter for 429/transient errors. This template does not automatically retry upstream requests. Never blindly retry OAuth code exchange/refresh. Report creation uses owner-scoped idempotency keys for uncertain HTTP outcomes.
- No webhook registration is necessary for this request-driven workflow. No background event consumer, queue, or webhook retries are implemented. Long-running analysis belongs in the MCP host or a separately scoped job service, not a server-held user session.
- Reports expire after seven days by default (`REPORT_RETENTION_DAYS`, 1–90). Expired rows become unreadable immediately, but physical removal is an operator responsibility. Run the following under a maintenance role on the required retention schedule, and include database backups in the retention policy:

```sql
DELETE FROM voiceai_reports WHERE expires_at <= now();
DELETE FROM voiceai_sessions WHERE expires_at <= now();
```

- Disconnect removes this owner's stored CTM grant. It does not claim provider-side revocation, delete reports, or revoke an already-issued JWT. Revoke at the provider for incident response. An already-started request can finish using a token it obtained before disconnect.
- Application code does not log tokens, bodies, or callback query strings. Configure proxy/access logs to omit OAuth callback queries and Authorization/Cookie headers. Add request IDs, safe status metrics, alerting, and audit events according to engineering's operating standards before customer rollout.
- `/health` is process liveness, not a provider/database readiness guarantee. Use dependency checks in the deployment's readiness and monitoring configuration.

## Verification

```sh
npm test                 # stdio regression + hosted cryptography/OAuth/HTTP tests
npm run typecheck
node test/compose.mjs     # after Compose starts: real Keycloak JWTs + actual server/database
```

`test/hosted.mjs` runs the real HTTP MCP transport with signed JWTs and isolated fake CTM responses. It checks signature/issuer/audience/expiry/scope, identity spoofing, concurrent caller credentials, cross-owner tools/resources/downloads, current CTM access, callback/browser binding and replay, account-scoped grants, refresh serialization, XSS and CSV escaping.

`test/postgres.mjs` requires `TEST_ADMIN_DATABASE_URL` pointing to an **ephemeral** database named `voiceai_test`. It creates the application role and schema, then tests RLS even when query owner filters are omitted, pooled connection reuse, copied ciphertext, durable reads, concurrent idempotency, and cross-instance refresh locking. Without that variable it explicitly skips locally; CI refuses to skip it.

GitHub Actions runs Node 20/22 with a PostgreSQL service and a separate container job that builds and starts PostgreSQL, Keycloak and the server. No live CTM credentials are used in CI. A real two-user CTM grant test is still required before customer deployment.

## Engineering deployment decisions

Keep this portable service/container as the initial template. Before public release, choose the identity provider and client registration policy, infrastructure and TLS, secret manager, database ownership/migration process, quotas, retention/backups, logging policy, and operational owner. Use a production Keycloak/database deployment rather than this `start-dev` Compose file. Restrict the CTM public callback registration to the exact deployment.

AgentCore can be a later adapter: verified workload identity and per-user token-vault retrieval must implement the same caller/credential contracts, and a private report store must retain the same owner checks. The present build does not implement or validate an AgentCore Identity integration.

References: [Keycloak containers](https://www.keycloak.org/server/containers), [realm import](https://www.keycloak.org/server/importExport), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
