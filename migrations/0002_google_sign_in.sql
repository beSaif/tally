-- Sign in with Google replaces email + password. No account existed before this migration, so the
-- users table is rebuilt rather than altered, and the login-attempt log has nothing left to throttle.
DROP TABLE login_attempts;
DROP TABLE users;

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,         -- Google's stable account id (OpenID Connect `sub`)
  email      TEXT NOT NULL UNIQUE,         -- verified by Google, lower-cased; follows the Google account
  created_at INTEGER NOT NULL
);
