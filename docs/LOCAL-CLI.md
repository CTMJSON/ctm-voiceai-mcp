# Local CLI / GraphQL mode

Use this mode when you want the local MCP to act through your CTM CLI browser-login identity. It is separate from the hosted HTTP OAuth implementation.

1. Run `ctm auth login` in Terminal and approve read-only access. Verify with `ctm auth check`.
2. Build this repository with `npm ci && npm run build`.
3. Launch `dist/index.js` over stdio with `CTM_VOICEAI_AUTH_MODE=cli` in the MCP entry's environment.
4. Restart the MCP host. Call `ctm_voiceai_auth_status`, then `ctm_voiceai_get_voice_bots` with the requested numeric account ID.

The adapter reads only `graphql_token`, `graphql_token_expires_at`, and `graphql_token_endpoint` from `~/.ctm.yml`. Override that path with `CTM_VOICEAI_CLI_CONFIG` if you sign in using a separate CLI configuration. It makes fixed read-only GraphQL queries directly to `https://app.ctm.com/graphql`, using the CLI's short-lived browser token. It does not run shell commands, copy credentials, or select Basic/API tokens. It does not change the CLI session or silently fall back to the MCP OAuth login. The pinned endpoint prevents forwarding this token to a caller-selected host.

CLI mode requires a current server schema with `account.activities`, `PhoneCall.transcription`, and `account.voiceBots`. An older CLI binary without generated activities commands is sufficient because the adapter supplies those GraphQL queries itself. Each account response includes `legacyId`, which must match the requested account before any content is returned. CTM continues to enforce the logged-in user's account, activity, and audio permissions.

## Authentication tools

- `ctm_voiceai_auth_status` reads local session expiry; it is not proof of live account permissions.
- `ctm_voiceai_auth_login` returns instructions to run `ctm auth login` in Terminal. It does not start the separate OAuth-app flow.
- `auth_url`, `auth_exchange`, and `auth_logout` refuse to operate on the shared CLI session. Manage that session with the CLI.
- Expired or missing CLI login returns `CLI_LOGIN_REQUIRED`. Sign in again and retry the read. Browser login does not supply a refresh token to this adapter.

## Calls and pagination

Start `ctm_voiceai_get_calls` with the account ID and optional `per_page`, `since`, `until`, and `direction`. CLI mode scans 10–100 phone-call activities per request (default 50), ordered newest first. It uses search-after cursors, not page numbers. For the next request, pass `after` equal to the prior response's `next_cursor`, keeping account, dates and direction unchanged. Stop at `has_more: false` or when the requested number of usable calls has actually been analyzed. Reject repeated call IDs in the assistant's accumulated analysis when live traffic changes during a scan.

This mode scans all call statuses. It filters direction locally (default inbound) and, by default, returns only calls with non-empty transcript text. CTM may withhold transcripts under audio permissions; null text is not proof that no transcription exists. Dates in `YYYY-MM-DD` form mean inclusive UTC calendar days. The original OAuth REST mode retains its answered-call filter and numbered pagination.

- `returned`: activities scanned on this page, before local filters.
- `matching_direction`: scanned activities matching the requested direction.
- `with_transcript`: returned calls with available transcript text.
- `calls`: usable normalized records; `transcript_truncated` marks length limits.
- `total` / `total_pages`: unknown (`null`), not zero.

An empty `calls` array is not the end if `has_more` is true. Do not count scanned activities as analyzed transcripts. Cursor discovery is sequential; workers are optional for analyzing already-fetched batches. The report renderer and report tools are unchanged. Use a separate `CTM_VOICEAI_OUT_DIR` per local profile if you want separate report listings.

## Validation

`test/cli-graphql.mjs` checks account identity on every page, browser-token-only selection, expiry and endpoint restrictions, query variables, cursor progression, empty pages, direction/transcript counts, UTC date validation, safe upstream errors and rejection of partial GraphQL results. Existing OAuth, stdio, report-rendering and hosted tests continue to run.

Source contracts: [CLI authentication](https://github.com/calltracking/phonetrac/blob/master/cli/cmd/ctm/auth.go), [activities resolver](https://github.com/calltracking/phonetrac/blob/master/app/graphql/resolvers/activities_resolver.rb), [PhoneCall schema](https://github.com/calltracking/phonetrac/blob/master/app/graphql/types/phone_call_type.rb).
