/** Bindings, vars and secrets available to the Worker (see wrangler.jsonc and .dev.vars.example). */
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  SIGNUPS_ENABLED?: string;
  /** The OAuth client from the Google Cloud console (type "Web application"). */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Google's endpoints; only the end-to-end tests override them, to point at a stand-in. */
  GOOGLE_AUTH_URL?: string;
  GOOGLE_TOKEN_URL?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface SessionUser {
  id: string;
  email: string;
  created_at: number;
}

/** Hono generic: bindings + per-request variables. */
export type AppEnv = {
  Bindings: Env;
  Variables: { user: SessionUser; sessionToken: string };
};
