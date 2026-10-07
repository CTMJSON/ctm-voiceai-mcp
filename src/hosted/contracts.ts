import type { Artifacts } from "../types.js";
import type { Caller } from "./identity.js";

export type CtmCredential = {
  accessToken: string; refreshToken: string | null; expiresAt: number;
  clientId: string; scopes: string; accountId: string | null;
};
export type Report = {
  id: string; accountId: string; createdAt: number; expiresAt: number; artifacts: Artifacts;
};
export type ReportSummary = Omit<Report, "artifacts">;
export interface HostedStore {
  credentials<T>(owner: string, work: (
    current: CtmCredential | null, save: (next: CtmCredential | null) => Promise<void>
  ) => Promise<T>): Promise<T>;
  putSession(id: string, value: unknown, expiresAt: number): Promise<void>;
  getSession(id: string, consume?: boolean): Promise<unknown | null>;
  deleteSession(id: string): Promise<void>;
  saveReport(owner: string, report: Report, idempotencyKey: string): Promise<ReportSummary>;
  getReport(owner: string, id: string): Promise<Report | null>;
  listReports(owner: string, limit: number): Promise<ReportSummary[]>;
}
export interface CredentialProvider {
  forAccount(caller: Caller, accountId: string): Promise<string>;
}
export type CtmApi = {
  bots(accountId: string, header: string): Promise<import("../ctm.js").VoiceBot[]>;
  calls(accountId: string, header: string, options: import("../ctm.js").CallOptions): Promise<import("../ctm.js").CallsPage>;
};
