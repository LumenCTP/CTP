/**
 * Re-seed the EXISTING demo partner (id 31, username demopartner, referral
 * code DEMOPART) with the canonical 10 fake referral clients + realistic 25%
 * commission/payout demo data.
 *
 * Safety: refuses to run unless the target partner is the demo partner
 * (email @cleartopaydemo.com + referral_code DEMOPART). It never touches the
 * owner's real partner (id 28) or any real client/tenant rows.
 *
 * Run from api/:  bun run scripts/seed-demo-partner-data.ts
 */
import { Database } from "bun:sqlite";
import { seedDemoPartnerData } from "./demo-partner-data.ts";

const DB_PATH = "data/cleartopay.db";
const TARGET_PARTNER_ID = 31;
const EXPECTED_CODE = "DEMOPART";
const DEMO_PASSWORD = "Demo-nrxJ7bCpGm"; // owner/demo fixed password for sign-in demos

const db = new Database(DB_PATH);
db.exec("PRAGMA busy_timeout=15000");
db.exec("PRAGMA journal_mode = WAL");

// ── Safety guards: only the demo partner may be reseeded ──────────────────
const partner = db.query(
  "SELECT id, user_id, referral_code, commission_percentage, email FROM partners WHERE id = $id",
).get({ $id: TARGET_PARTNER_ID }) as
  | { id: number; user_id: number; referral_code: string | null; commission_percentage: number | null; email: string }
  | undefined;

if (!partner) throw new Error(`Partner ${TARGET_PARTNER_ID} not found — aborting`);
if (partner.referral_code !== EXPECTED_CODE) throw new Error(`Partner ${TARGET_PARTNER_ID} is not the demo partner (code ${partner.referral_code}) — aborting`);
if (!/^demopartner@cleartopaydemo\.com$/i.test(partner.email)) throw new Error(`Partner ${TARGET_PARTNER_ID} email ${partner.email} is not the demo partner email — aborting`);
if (partner.commission_percentage !== 25.0) {
  db.query("UPDATE partners SET commission_percentage = 25.0, updated_at = datetime('now') WHERE id = $id").run({ $id: TARGET_PARTNER_ID });
  console.log("demo partner commission_percentage normalized to 25.0");
}

// Guarantee the documented demo password so Task-C sign-in always works.
const user = db.query("SELECT id, username, role FROM users WHERE id = $id").get({ $id: partner.user_id }) as
  | { id: number; username: string | null; role: string }
  | undefined;
if (!user) throw new Error(`Demo partner user ${partner.user_id} not found — aborting`);
if (user.username !== "demopartner") throw new Error(`User ${user.id} is not 'demopartner' (got '${user.username}') — aborting`);
console.log(`setting demo password for user ${user.id} (demopartner)`);
const hash = await Bun.password.hash(DEMO_PASSWORD, { algorithm: "bcrypt", cost: 10 });
db.query("UPDATE users SET password_hash = $h WHERE id = $id").run({ $h: hash, $id: user.id });

// ── Seed the canonical demo dataset ───────────────────────────────────────
const result = seedDemoPartnerData(db, TARGET_PARTNER_ID, EXPECTED_CODE);
db.exec("PRAGMA optimize");
db.close();

console.log(JSON.stringify(result, null, 2));
console.log("Demo partner reseeded OK — 10 referrals, 25% commissions, 1 paid payout.");