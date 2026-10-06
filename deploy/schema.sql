-- Run as migration/admin role, never as the application's connection role.
CREATE TABLE IF NOT EXISTS voiceai_credentials (
  owner text PRIMARY KEY, ciphertext text NOT NULL
);
CREATE TABLE IF NOT EXISTS voiceai_sessions (
  owner text PRIMARY KEY, ciphertext text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS voiceai_sessions_expiry ON voiceai_sessions(expires_at);
CREATE TABLE IF NOT EXISTS voiceai_reports (
  owner text NOT NULL, id uuid NOT NULL, idempotency_key uuid NOT NULL,
  digest text NOT NULL, account_id text NOT NULL, created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, ciphertext text NOT NULL,
  PRIMARY KEY(owner,id), UNIQUE(owner,idempotency_key)
);
CREATE INDEX IF NOT EXISTS voiceai_reports_recent ON voiceai_reports(owner,created_at DESC,id DESC);
CREATE INDEX IF NOT EXISTS voiceai_reports_expiry ON voiceai_reports(expires_at);
ALTER TABLE voiceai_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE voiceai_credentials FORCE ROW LEVEL SECURITY;
ALTER TABLE voiceai_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voiceai_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE voiceai_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE voiceai_reports FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname='voiceai_credentials_owner') THEN
    CREATE POLICY voiceai_credentials_owner ON voiceai_credentials
      USING (owner=current_setting('voiceai.owner',true))
      WITH CHECK (owner=current_setting('voiceai.owner',true));
    CREATE POLICY voiceai_sessions_owner ON voiceai_sessions
      USING (owner=current_setting('voiceai.owner',true))
      WITH CHECK (owner=current_setting('voiceai.owner',true));
    CREATE POLICY voiceai_reports_owner ON voiceai_reports
      USING (owner=current_setting('voiceai.owner',true))
      WITH CHECK (owner=current_setting('voiceai.owner',true));
  END IF;
END $$;
GRANT SELECT,INSERT,UPDATE,DELETE ON voiceai_credentials,voiceai_sessions,voiceai_reports TO voiceai_app;
