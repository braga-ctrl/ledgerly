-- OAuth 2.0 authorization server (DCR + PKCE) so Claude can connect with a normal "Connect" button.

CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  redirect_uris TEXT NOT NULL,          -- JSON array
  created_at    INTEGER NOT NULL
);

-- Single-use authorization codes (10 minute lifetime)
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  org_id         TEXT NOT NULL REFERENCES orgs(id),
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

-- Access (1 hour) and refresh (30 day, rotated on use) tokens, stored hashed
CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  client_id  TEXT NOT NULL,
  org_id     TEXT NOT NULL REFERENCES orgs(id),
  family     TEXT NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_oauth_tokens_family ON oauth_tokens(family);
