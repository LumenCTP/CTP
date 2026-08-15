/**
 * Nightly offsite backups (owner directive 2026-08-15: "make sure it is
 * failproof") — the whole company lives in one SQLite file
 * (api/data/cleartopay.db), so a disk failure or a bad migration would be
 * catastrophic. Every night the scheduler:
 *
 *   1. VACUUM INTO a temp copy (/tmp/cleartopay-backup-<date>.db) — safe to run
 *      against a live WAL-mode database, no exclusive lock needed.
 *   2. Uploads it to object storage (R2 when configured, else local disk) under
 *      the `backups/` prefix via the existing storagePut mechanism.
 *   3. Runs retention: keep the 30 most recent daily backups PLUS the first
 *      backup of each of the last 12 calendar months; delete everything older.
 *   4. Logs success/failure to backup_log + console (never crashes the
 *      scheduler on failure — reliability tooling must not take the app down).
 *
 * Retention is a pure function (computeRetention) so it can be unit-tested
 * with fake timestamps; runBackupAndRetain is the end-to-end job.
 */

import { getDb } from "./db";
import { storagePut, storageList, storageDelete } from "./storage";
import { rmSync } from "node:fs";
import path from "node:path";

export const BACKUP_PREFIX = "backups/";

/** "backups/cleartopay-2026-08-15.db" → local YYYY-MM-DD date string, or null. */
export function parseBackupKey(key: string): string | null {
  const m = /^backups\/cleartopay-(\d{4}-\d{2}-\d{2})\.db$/.exec(key);
  return m ? m[1] : null;
}

/**
 * Retention policy: keep the 30 most recent daily backups, plus (for each of
 * the last 12 calendar months relative to `now`) the earliest backup of that
 * month — first-of-month snapshots survive the rolling 30-day window. Anything
 * else (including keys that don't parse as our backup naming) is deleted.
 * Pure function → unit-testable with fake keys/timestamps.
 */
export function computeRetention(keys: string[], now: Date): { keep: string[]; delete: string[] } {
  const dated: Array<{ key: string; date: string }> = [];
  const unparsed: string[] = [];
  for (const k of keys) {
    const d = parseBackupKey(k);
    if (d) dated.push({ key: k, date: d });
    else unparsed.push(k);
  }
  // Most recent first (YYYY-MM-DD sorts lexically)
  dated.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const keep = new Set<string>();
  const keepCount = 30;
  for (const d of dated.slice(0, keepCount)) keep.add(d.key);

  // Monthly: first (earliest) backup of each of the last 12 calendar months.
  const monthSet = new Set<string>();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based
  for (let i = 0; i < 12; i++) {
    const t = new Date(Date.UTC(y, m - i, 1));
    monthSet.add(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  // dated is newest-first; walk from the OLDEST to find each month's first backup.
  const monthFirst = new Map<string, string>();
  for (let i = dated.length - 1; i >= 0; i--) {
    const d = dated[i];
    const monthKey = d.date.slice(0, 7);
    if (monthSet.has(monthKey) && !monthFirst.has(monthKey)) monthFirst.set(monthKey, d.key);
  }
  for (const k of monthFirst.values()) keep.add(k);

  const deleteSet = new Set<string>();
  for (const k of keys) if (!keep.has(k)) deleteSet.add(k);
  return { keep: [...keep], delete: [...deleteSet] };
}

/** Internal-alert-friendly audit row + console mirror. */
function logBackup(args: {
  backupKey: string | null;
  sizeBytes: number | null;
  status: "success" | "error";
  errorMessage?: string;
  retentionDeleted: number;
}): void {
  const { backupKey, sizeBytes, status, errorMessage, retentionDeleted } = args;
  try {
    getDb().query(
      `INSERT INTO backup_log (backup_key, size_bytes, status, error_message, retention_deleted)
       VALUES ($k, $s, $st, $e, $r)`,
    ).run({
      $k: backupKey,
      $s: sizeBytes,
      $st: status,
      $e: errorMessage ?? null,
      $r: retentionDeleted,
    });
  } catch (err) {
    console.error(`[backup] Failed to write backup_log row: ${String(err)}`);
  }
  if (status === "success") {
    console.log(`[backup] SUCCESS key=${backupKey} size=${sizeBytes} retention_deleted=${retentionDeleted}`);
  } else {
    console.error(`[backup] FAILURE ${errorMessage ?? "unknown error"} (retention_deleted=${retentionDeleted})`);
  }
}

/**
 * Full nightly job: VACUUM INTO → storagePut under backups/ → retention.
 * Safe to call while the API is live (VACUUM INTO works on a WAL-mode DB
 * without an exclusive lock). Failures are logged and swallowed — the
 * scheduler must never crash because a backup failed.
 */
export async function runBackupAndRetain(now: Date = new Date()): Promise<{
  ok: boolean;
  backupKey: string | null;
  sizeBytes: number | null;
  deleted: string[];
  error?: string;
}> {
  const db = getDb();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toISOString().slice(11, 16).replace(":", "");
  const tmpPath = path.join("/tmp", `cleartopay-backup-${dateStr}-${timeStr}.db`);
  const backupKey = `${BACKUP_PREFIX}cleartopay-${dateStr}.db`;

  try {
    // 1. Snapshot. VACUUM INTO errors if the target exists — the timestamped
    //    temp name guarantees a fresh file; clean up any straggler anyway.
    rmSync(tmpPath, { force: true });
    // Wrap in a short timeout: a stuck VACUUM must not wedge the scheduler tick.
    const vacuum = Bun.spawnSync(["sqlite3", dbPath(), `VACUUM INTO '${tmpPath}'`], {
      timeout: 60000,
      stdout: "ignore",
      stderr: "pipe",
    });
    if (vacuum.exitCode !== 0) {
      throw new Error(`VACUUM INTO failed: ${vacuum.stderr?.toString() ?? "unknown"}`);
    }
    const sizeBytes = Bun.file(tmpPath).size;

    // 2. Upload to R2 (or local fallback) under the backups/ prefix. Read the
    //    file into a Buffer first — storagePut accepts Buffer/Uint8Array/string,
    //    not a Blob.
    const fileBytes = Buffer.from(await Bun.file(tmpPath).arrayBuffer());
    await storagePut(backupKey, fileBytes, "application/vnd.sqlite3");

    // 3. Retention (list + compute + delete).
    let deleted: string[] = [];
    try {
      const existing = await storageList(BACKUP_PREFIX);
      const { delete: toDelete } = computeRetention(existing, now);
      for (const k of toDelete) {
        await storageDelete(k);
        deleted.push(k);
      }
    } catch (err) {
      // Retention failure must not fail the backup itself — the snapshot is
      // already safe offsite. Log and continue.
      console.error(`[backup] Retention pass failed (backup kept): ${String(err)}`);
    }

    logBackup({ backupKey, sizeBytes, status: "success", retentionDeleted: deleted.length });
    return { ok: true, backupKey, sizeBytes, deleted };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logBackup({ backupKey, sizeBytes: null, status: "error", errorMessage: msg, retentionDeleted: 0 });
    return { ok: false, backupKey, sizeBytes: null, deleted: [], error: msg };
  } finally {
    rmSync(tmpPath, { force: true });
  }
}

/**
 * Retention-only pass (used by the ops endpoint and after any backup that
 * skipped its retention pass). Deletes per computeRetention and returns the
 * deleted keys.
 */
export async function runRetentionOnly(now: Date = new Date()): Promise<{ deleted: string[] }> {
  const existing = await storageList(BACKUP_PREFIX);
  const { delete: toDelete } = computeRetention(existing, now);
  const deleted: string[] = [];
  for (const k of toDelete) {
    try {
      await storageDelete(k);
      deleted.push(k);
    } catch (err) {
      console.error(`[backup] Retention delete failed for ${k}: ${String(err)}`);
    }
  }
  if (deleted.length > 0) console.log(`[backup] Retention deleted ${deleted.length} old backup(s): ${deleted.join(", ")}`);
  return { deleted };
}

// Spawning sqlite3 for VACUUM keeps it out of the API's bun:sqlite connection
// (a second bun:sqlite handle on the same file can hang in this environment).
// Reuse the exact path the API uses.
function dbPath(): string {
  return path.join(import.meta.dir, "..", "data", "cleartopay.db");
}
