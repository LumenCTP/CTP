#!/usr/bin/env bun
/**
 * Regression harness — the daily improvement-review trigger fires AT MOST ONCE
 * per ET calendar day, and the record of "already fired today" survives a
 * process restart.
 *
 * What it proves (each numbered line = one fresh child PROCESS, i.e. a simulated
 * API restart, all against ONE throwaway DB):
 *   A1  first fire of the ET day (10:00 ET)      → sends once, records the day
 *   A2  restart later the same ET day (12:00 ET) → no second send   (RESTART)
 *   A3  marker deleted (state loss) + same day   → no second send, marker
 *                                                  healed from email_log
 *   A4  22:00 ET (= 02:00Z NEXT UTC day)         → still the same ET day, no send
 *   B1  05:59 ET (before the 07:00 AM ET window) → nothing fires
 *   B2  07:01 ET on a fresh ET day               → sends again (once/day)
 *   B3  restart later that day (16:00 ET)        → no second send   (RESTART)
 *   C1  06:30 EST after the DST change           → nothing fires
 *   C2  08:00 EST                                → sends once (DST-correct)
 *
 * Safety: every child runs with CTP_DB_PATH pointed at a throwaway snapshot DB
 * and with the M365/SMTP credentials removed from its environment, so sendEmail()
 * takes the platform-queue branch (email_log 'queued') and NO real email is
 * delivered. The harness also asserts that (delivery path "queue", queue row
 * present) and that the message content is byte-for-byte the production prompt —
 * so a change to the email copy fails the test rather than shipping silently.
 *
 * The snapshot is taken exactly the way the nightly backup takes one
 * (`sqlite3 <live db> "VACUUM INTO '<tmp>'"`, safe against a live WAL DB), then
 * the trigger's own tables (email_log, outgoing_email_queue, scheduler_state) are
 * emptied. A byte-fresh DB cannot be built from runMigrations alone — an earlier
 * migration block indexes documents.tenant_id / vendors.tenant_id before
 * ensureColumn adds those columns — so the real schema is snapshotted instead.
 *
 * Usage:  cd api && bun run scripts/daily-review-idempotency.ts [--keep]
 *         (exit 0 = all assertions pass; --keep leaves the temp DB for inspection)
 */
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The production message must not drift — these are asserted, not just used.
const EXPECT_SUBJECT = "[Daily] Run the ClearToPay improvement review";
const EXPECT_RECIPIENT = "cleartopay-compliance-0d8d884b@ctomail.io";
const EXPECT_BODY =
  "Run today's improvement review: fan out read-only UX + systems reviews and compile findings into /home/team/shared/daily-improvements/.";
const MARKER_KEY = "last_daily_review_date";

const args = process.argv.slice(2);

// ── Child mode: one trigger call in a fresh process, then report DB state ──
if (args[0] === "--child") {
  const iso = args[1];
  const { checkDailyReviewTrigger } = await import("../src/scheduler");
  const { getDb } = await import("../src/db");
  const { getDeliveryPath } = await import("../src/email");

  await checkDailyReviewTrigger(new Date(iso));

  const db = getDb();
  const rows = db
    .query("SELECT COUNT(*) AS c FROM email_log WHERE email_type = 'daily_review_trigger'")
    .get() as { c: number };
  const markerRow = db.query("SELECT value FROM scheduler_state WHERE key = ?").get(MARKER_KEY) as
    | { value: string }
    | undefined;
  const last = db
    .query(
      "SELECT recipient_email, subject, status FROM email_log WHERE email_type = 'daily_review_trigger' ORDER BY id DESC LIMIT 1",
    )
    .get() as { recipient_email: string; subject: string; status: string } | undefined;
  const queued = db
    .query(
      "SELECT recipient_email, subject, html_body, email_type, status FROM outgoing_email_queue ORDER BY id DESC LIMIT 1",
    )
    .get() as
    | { recipient_email: string; subject: string; html_body: string; email_type: string; status: string }
    | undefined;

  console.log(
    `RESULT ${JSON.stringify({
      iso,
      rows: rows.c,
      marker: markerRow?.value ?? null,
      last: last ?? null,
      queued: queued ?? null,
      deliveryPath: getDeliveryPath(),
    })}`,
  );
  process.exit(0);
}

// ── Parent mode ────────────────────────────────────────────────────────────
type ChildResult = {
  iso: string;
  rows: number;
  marker: string | null;
  last: { recipient_email: string; subject: string; status: string } | null;
  queued: { recipient_email: string; subject: string; html_body: string; email_type: string; status: string } | null;
  deliveryPath: string;
};

type Step = {
  label: string;
  iso: string;
  expectRows: number;
  expectMarker: string | null;
  /** Simulate a lost scheduler_state marker before this run. */
  clearMarkerFirst?: boolean;
};

const steps: Step[] = [
  { label: "A1 first fire of the ET day (10:00 ET)", iso: "2026-09-26T14:00:00Z", expectRows: 1, expectMarker: "2026-09-26" },
  { label: "A2 RESTART later the same ET day (12:00 ET)", iso: "2026-09-26T16:00:00Z", expectRows: 1, expectMarker: "2026-09-26" },
  { label: "A3 marker lost + same ET day (14:00 ET)", iso: "2026-09-26T18:00:00Z", expectRows: 1, expectMarker: "2026-09-26", clearMarkerFirst: true },
  { label: "A4 22:00 ET (= 02:00Z on the NEXT UTC day)", iso: "2026-09-27T02:00:00Z", expectRows: 1, expectMarker: "2026-09-26" },
  { label: "B1 05:59 ET, before the 07:00 AM ET window", iso: "2026-09-27T09:59:00Z", expectRows: 1, expectMarker: "2026-09-26" },
  { label: "B2 07:01 ET, fresh ET day", iso: "2026-09-27T11:01:00Z", expectRows: 2, expectMarker: "2026-09-27" },
  { label: "B3 RESTART later that day (16:00 ET)", iso: "2026-09-27T20:00:00Z", expectRows: 2, expectMarker: "2026-09-27" },
  { label: "C1 06:30 EST, after the DST change", iso: "2026-11-02T11:30:00Z", expectRows: 2, expectMarker: "2026-09-27" },
  { label: "C2 08:00 EST, fresh ET day after DST change", iso: "2026-11-02T13:00:00Z", expectRows: 3, expectMarker: "2026-11-02" },
];

const tmp = mkdtempSync(path.join(tmpdir(), "ctp-daily-review-"));
const dbPath = path.join(tmp, "cleartopay.db");
const liveDbPath = path.join(import.meta.dir, "..", "data", "cleartopay.db");
const keep = args.includes("--keep");

// Snapshot the REAL schema (same command the nightly backup uses — safe against
// the live WAL database, read-only for it), then empty the tables this harness
// reasons about. Nothing here ever writes to the live DB.
{
  const live = Bun.file(liveDbPath);
  if (!(await live.exists())) {
    console.error(`[daily-review-idempotency] live DB not found at ${liveDbPath} — cannot snapshot a schema`);
    process.exit(1);
  }
  const vacuum = Bun.spawnSync(["sqlite3", liveDbPath, `VACUUM INTO '${dbPath}'`], {
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (vacuum.exitCode !== 0) {
    console.error(`[daily-review-idempotency] VACUUM INTO failed: ${vacuum.stderr?.toString() ?? "unknown"}`);
    process.exit(1);
  }
  const seed = new Database(dbPath);
  try {
    seed.run("DELETE FROM email_log");
    seed.run("DELETE FROM outgoing_email_queue");
    seed.run("DELETE FROM scheduler_state");
  } finally {
    seed.close();
  }
}

const childEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") childEnv[k] = v;
// Force the platform-queue delivery branch: no Graph, no SMTP ⇒ no real email.
for (const k of ["M365_TENANT_ID", "M365_CLIENT_ID", "M365_CLIENT_SECRET", "ClearToPaySMTP"]) delete childEnv[k];
childEnv.CTP_DB_PATH = dbPath;

function clearMarker(): void {
  const db = new Database(dbPath);
  try {
    db.run("DELETE FROM scheduler_state WHERE key = ?", [MARKER_KEY]);
  } finally {
    db.close();
  }
}

async function runChild(iso: string): Promise<ChildResult> {
  const proc = Bun.spawn(["bun", "run", import.meta.path, "--child", iso], {
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (code !== 0 || !line) {
    console.error(out);
    console.error(err);
    throw new Error(`child process failed for ${iso} (exit ${code})`);
  }
  return JSON.parse(line.slice("RESULT ".length)) as ChildResult;
}

const failures: string[] = [];

console.log(`[daily-review-idempotency] throwaway DB: ${dbPath}`);
console.log(`[daily-review-idempotency] ${steps.length} fresh child processes (each one = a simulated API restart)\n`);

for (const step of steps) {
  if (step.clearMarkerFirst) clearMarker();
  const r = await runChild(step.iso);

  const checks: Array<[string, boolean, string]> = [
    [`rows == ${step.expectRows}`, r.rows === step.expectRows, `got ${r.rows}`],
    [`marker == ${step.expectMarker}`, r.marker === step.expectMarker, `got ${r.marker}`],
    [`delivery went to the queue (no real email)`, r.deliveryPath === "queue", `got ${r.deliveryPath}`],
  ];
  const ok = checks.every(([, pass]) => pass);
  if (!ok) for (const [name, pass, detail] of checks) if (!pass) failures.push(`${step.label}: ${name} — ${detail}`);
  console.log(`${ok ? "PASS" : "FAIL"}  ${step.label}  ${step.iso}  rows=${r.rows} marker=${r.marker}`);

  // Content assertions on the first fire (A1) — the production prompt must be intact.
  if (step.expectRows === 1 && !step.clearMarkerFirst && r.last) {
    const content: Array<[string, boolean, string]> = [
      ["email_log subject unchanged", r.last.subject === EXPECT_SUBJECT, r.last.subject],
      ["email_log recipient unchanged", r.last.recipient_email === EXPECT_RECIPIENT, r.last.recipient_email],
      ["email_log row is queued, not delivered", r.last.status === "queued", r.last.status],
      ["queued body unchanged", r.queued?.html_body === EXPECT_BODY, String(r.queued?.html_body).slice(0, 60)],
      ["queued recipient unchanged", r.queued?.recipient_email === EXPECT_RECIPIENT, String(r.queued?.recipient_email)],
      ["queue row marked queued (never delivered)", r.queued?.status === "queued", String(r.queued?.status)],
      ["queue row email_type is daily_review_trigger", r.queued?.email_type === "daily_review_trigger", String(r.queued?.email_type)],
    ];
    for (const [name, pass, detail] of content) {
      if (!pass) failures.push(`${step.label} content: ${name} — ${detail}`);
    }
    if (content.every(([, pass]) => pass)) {
      console.log(`      content: subject/recipient/body identical to the production prompt ✓`);
    }
  }
}

if (!keep) rmSync(tmp, { recursive: true, force: true });

console.log("");
if (failures.length) {
  console.error(`[daily-review-idempotency] FAILED — ${failures.length} assertion(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("[daily-review-idempotency] PASSED — at most one daily prompt per ET calendar day, across restarts.");
if (keep) console.log(`[daily-review-idempotency] temp DB kept at ${dbPath}`);
