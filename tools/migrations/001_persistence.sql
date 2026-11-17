CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 id_hash TEXT PRIMARY KEY, principal TEXT NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
CREATE TABLE IF NOT EXISTS workspaces (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_owner ON workspaces(owner);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), revision INTEGER NOT NULL CHECK(revision>0), data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS run_owner ON runs(owner, workspace_id);
CREATE TABLE IF NOT EXISTS artifacts (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS exports (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), run_id TEXT NOT NULL REFERENCES runs(id), data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
 id TEXT PRIMARY KEY, owner TEXT NOT NULL, workspace_id TEXT NOT NULL REFERENCES workspaces(id), data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
 owner TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, status INTEGER NOT NULL, response TEXT NOT NULL, PRIMARY KEY(owner,key)
);
CREATE TABLE IF NOT EXISTS samples (
 id TEXT PRIMARY KEY, data TEXT NOT NULL
);
