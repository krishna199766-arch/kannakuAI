-- Accounts, login sessions and who may open which company's books. Safe to re-run.
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,            -- stored lower-case
  name           text NOT NULL,
  phone          text,
  password_hash  text NOT NULL,                   -- scrypt$N$r$p$salt$hash
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_login_at  timestamptz
);

CREATE TABLE IF NOT EXISTS user_sessions (
  token_hash  text PRIMARY KEY,                   -- sha256 of the cookie value; the token itself is never stored
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions (user_id);

CREATE TABLE IF NOT EXISTS company_members (
  company_id  uuid NOT NULL REFERENCES companies(id),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL DEFAULT 'OWNER' CHECK (role IN ('OWNER','ACCOUNTANT','VIEWER')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_by uuid;
