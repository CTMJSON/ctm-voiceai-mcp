import { Pool } from "pg";
import { hostedConfig } from "./config.js";
import { Sealer } from "./crypto.js";
import { PostgresStore } from "./postgres.js";
import { createVerifier } from "./identity.js";
import { HostedOAuth } from "./oauth.js";
import { createHostedHttp } from "./http.js";
import { fetchVoiceBots, fetchCallsPage } from "../ctm.js";
import { AppError } from "../errors.js";

try {
  const config = hostedConfig();
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30000, statement_timeout: 25000 });
  pool.on("error", () => process.stderr.write("Private storage connection failed.\n"));
  const store = new PostgresStore(pool, new Sealer(config.encryptionKey));
  await store.validateRole();
  const verify = createVerifier(config.identity);
  const oauth = new HostedOAuth(store, config.oauth, verify);
  const server = createHostedHttp({ ...config, store, verify, oauth, credentials: oauth,
    issuer: config.identity.issuer, ctm: {
      bots: (account, header) => fetchVoiceBots(account, header, { signal: AbortSignal.timeout(60000) }),
      calls: fetchCallsPage
    } });
  server.listen(config.port, "0.0.0.0", () => process.stderr.write(`Hosted MCP listening on port ${config.port}.\n`));
  const stop = () => { server.close(() => { void pool.end().finally(() => process.exit(0)); }); setTimeout(() => process.exit(1), 10000).unref(); };
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
} catch (error) {
  process.stderr.write(error instanceof AppError && error.code === "CONFIG" ? error.message + "\n" : "Hosted startup failed. Check configuration, storage role, and migrations.\n");
  process.exit(1);
}
