import type { Context } from "hono";

/**
 * Shared 500-class error responder (owner confidentiality directive
 * 2026-08-15). The FULL raw error is logged server-side only — clients always
 * receive the same generic message. No internal detail (SQLite text, schema or
 * column names, env-var names, file paths, host names, tech stack) ever
 * crosses the API boundary.
 *
 * Usage: catch (err) { return serverError(c, err); }
 * An optional status preserves the caller's original status code where a route
 * historically returned something other than 500 for an unexpected error.
 */
export function serverError(c: Context, err: unknown, status: number = 500) {
  console.error(err);
  return c.json({ error: "Something went wrong. Please try again." }, status);
}
