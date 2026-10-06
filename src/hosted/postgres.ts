import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { artifactsSchema } from "../types.js";
import { AppError } from "../errors.js";
import { Sealer } from "./crypto.js";
import type { CtmCredential, HostedStore, Report, ReportSummary } from "./contracts.js";

const credentialSchema = z.object({
  accessToken: z.string(), refreshToken: z.string().nullable(), expiresAt: z.number(),
  clientId: z.string(), scopes: z.string(), accountId: z.string().nullable()
});
const reportSchema = z.object({
  id: z.string().uuid(), accountId: z.string(), createdAt: z.number(),
  expiresAt: z.number(), artifacts: artifactsSchema
});
const summary = ({ artifacts: _, ...rest }: Report): ReportSummary => rest;
const sessionOwner = (id: string) => "session:" + createHash("sha256").update(id).digest("hex");

export class PostgresStore implements HostedStore {
  constructor(private readonly pool: Pool, private readonly sealer: Sealer) {}
  async validateRole() {
    const role = await this.pool.query("SELECT rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user");
    const tables = await this.pool.query("SELECT relrowsecurity,relforcerowsecurity,pg_get_userbyid(relowner)=current_user AS owns FROM pg_class WHERE oid IN ('voiceai_credentials'::regclass,'voiceai_sessions'::regclass,'voiceai_reports'::regclass)");
    if (role.rows.length !== 1 || role.rows[0].rolsuper || role.rows[0].rolbypassrls || role.rows[0].rolcreaterole || tables.rows.length !== 3 || tables.rows.some(row => !row.relrowsecurity || !row.relforcerowsecurity || row.owns)) {
      throw new AppError("Use a dedicated application role with forced row-level security and separate migration ownership.", "CONFIG");
    }
  }
  /** SET LOCAL is transaction-bound: connection reuse cannot inherit a previous caller. */
  private async scoped<T>(owner: string, work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT set_config('voiceai.owner', $1, true)", [owner]);
      const value = await work(db);
      await db.query("COMMIT");
      return value;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => {});
      if (error instanceof AppError) throw error;
      throw new AppError("Private storage is unavailable.", "STORAGE_ERROR", 503);
    } finally { db.release(); }
  }
  async credentials<T>(owner: string, work: (value: CtmCredential | null, save: (next: CtmCredential | null) => Promise<void>) => Promise<T>) {
    return this.scoped(owner, async db => {
      // Serialize creation/refresh/logout across replicas, including an absent token row.
      await db.query("SET LOCAL lock_timeout = '20s'");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [owner]);
      const rows = await db.query<{ ciphertext: string }>("SELECT ciphertext FROM voiceai_credentials WHERE owner = $1", [owner]);
      const current = rows.rows[0] ? credentialSchema.parse(this.sealer.open(rows.rows[0].ciphertext, owner + ":credentials")) : null;
      return work(current, async next => {
        if (!next) {
          await db.query("DELETE FROM voiceai_credentials WHERE owner = $1", [owner]);
        } else {
          await db.query("INSERT INTO voiceai_credentials(owner, ciphertext) VALUES($1,$2) ON CONFLICT(owner) DO UPDATE SET ciphertext=EXCLUDED.ciphertext",
            [owner, this.sealer.seal(credentialSchema.parse(next), owner + ":credentials")]);
        }
      });
    });
  }
  async putSession(id: string, value: unknown, expiresAt: number) {
    const owner = sessionOwner(id);
    await this.scoped(owner, async db => {
      await db.query("INSERT INTO voiceai_sessions(owner,ciphertext,expires_at) VALUES($1,$2,$3)",
        [owner, this.sealer.seal(value, owner), new Date(expiresAt)]);
    });
  }
  async getSession(id: string, consume = false): Promise<unknown | null> {
    const owner = sessionOwner(id);
    return this.scoped(owner, async db => {
      const query = consume ?
        "DELETE FROM voiceai_sessions WHERE owner=$1 AND expires_at>now() RETURNING ciphertext" :
        "SELECT ciphertext FROM voiceai_sessions WHERE owner=$1 AND expires_at>now()";
      const rows = await db.query<{ ciphertext: string }>(query, [owner]);
      return rows.rows[0] ? this.sealer.open(rows.rows[0].ciphertext, owner) : null;
    });
  }
  async deleteSession(id: string) {
    const owner = sessionOwner(id);
    await this.scoped(owner, async db => { await db.query("DELETE FROM voiceai_sessions WHERE owner=$1", [owner]); });
  }
  async saveReport(owner: string, input: Report, idempotencyKey: string): Promise<ReportSummary> {
    const report = reportSchema.parse(input);
    const digest = createHash("sha256").update(JSON.stringify(report.artifacts)).digest("hex");
    return this.scoped(owner, async db => {
      await db.query(
        "INSERT INTO voiceai_reports(owner,id,idempotency_key,digest,account_id,created_at,expires_at,ciphertext) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(owner,idempotency_key) DO NOTHING",
        [owner, report.id, idempotencyKey, digest, report.accountId, new Date(report.createdAt), new Date(report.expiresAt), this.sealer.seal(report, owner + ":report:" + report.id)]);
      const result = await db.query<{ id: string; digest: string; ciphertext: string }>(
        "SELECT id,digest,ciphertext FROM voiceai_reports WHERE owner=$1 AND idempotency_key=$2", [owner, idempotencyKey]);
      const row = result.rows[0];
      if (!row || row.digest !== digest) throw new AppError("Idempotency key was already used for different report content.", "CONFLICT", 409);
      const stored = reportSchema.parse(this.sealer.open(row.ciphertext, owner + ":report:" + row.id));
      if (stored.expiresAt <= Date.now()) throw new AppError("The prior report expired. Use a new idempotency key.", "CONFLICT", 409);
      return summary(stored);
    });
  }
  async getReport(owner: string, id: string) {
    if (!z.string().uuid().safeParse(id).success) return null;
    return this.scoped(owner, async db => {
      const rows = await db.query<{ ciphertext: string }>("SELECT ciphertext FROM voiceai_reports WHERE owner=$1 AND id=$2 AND expires_at>now()", [owner, id]);
      if (!rows.rows[0]) return null;
      return reportSchema.parse(this.sealer.open(rows.rows[0].ciphertext, owner + ":report:" + id));
    });
  }
  async listReports(owner: string, limit: number) {
    return this.scoped(owner, async db => {
      const rows = await db.query<{ id: string; account_id: string; created_at: Date; expires_at: Date }>(
        "SELECT id,account_id,created_at,expires_at FROM voiceai_reports WHERE owner=$1 AND expires_at>now() ORDER BY created_at DESC,id DESC LIMIT $2",
        [owner, Math.max(1, Math.min(limit, 50))]);
      return rows.rows.map(row => ({ id: row.id, accountId: row.account_id, createdAt: row.created_at.getTime(), expiresAt: row.expires_at.getTime() }));
    });
  }
}
