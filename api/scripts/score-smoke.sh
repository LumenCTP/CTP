#!/bin/bash
# Per-vendor COMPLIANCE SCORE smoke test (0-100 + Good/Fair/Poor band).
# Proves the score is derived from the existing compliance engine and threaded
# into every response that returns vendor compliance:
#   GET /api/vendors                    (list)
#   GET /api/vendors/:id                (detail)
#   GET /api/vendors/:id/compliance-detail
#   GET /api/dashboard/clear-to-pay     (dashboard cards)
#
# Mapping asserted: compliant 100, expiring_soon 75, needs_review 50,
# below_limit 25, missing 0, expired 0 — averaged over the client's required
# types (no required types = 100). Bands: >=80 Good, 40-79 Fair, <40 Poor.
#
# Creates throwaway tenants/clients/vendors/docs with the sqlite3 CLI (never a
# second bun:sqlite process — that can hang while the API holds the DB), mints a
# real JWT with the app's own signer, calls the live API, then deletes every row
# it created.
#
# Usage:  bash api/scripts/score-smoke.sh [base_url]   (default http://localhost:3001)
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)          # .../clear-to-pay/api
cd "$ROOT" || exit 1
DB="$ROOT/data/cleartopay.db"
API="${1:-http://localhost:3001}"
SLUG="ScoreSmoke$(date +%s)"
EMAIL="scoresmoke-$SLUG@example.com"
FAIL=0

pass () { echo "  OK   $1"; }
fail () { echo "  FAIL $1"; FAIL=1; }
eq () { [ "$2" = "$3" ] && pass "$1 = $3" || fail "$1: expected $3 got $2"; }

echo "### health"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$API/api/health")" = "200" ] || { echo "API not healthy — aborting"; exit 1; }
echo "health=200"

# ── Seed ────────────────────────────────────────────────────────────────────
echo "### seed throwaway tenant (sqlite3 CLI)"
sqlite3 "$DB" "INSERT INTO users (full_name,company_name,email,password_hash) VALUES ('ScoreSmoke','ScoreSmoke','$EMAIL','x');"
USER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE email='$EMAIL';")
TID=$(sqlite3 "$DB" "INSERT INTO tenants (name,owner_user_id,inbox_slug,subscription_status) VALUES ('$SLUG',$USER_ID,'$SLUG','TRIAL'); SELECT last_insert_rowid();")
sqlite3 "$DB" "UPDATE users SET tenant_id=$TID WHERE id=$USER_ID;"

# Client A — four required types (GL gated at $1M, WC gated at $500k)
CID=$(sqlite3 "$DB" "INSERT INTO clients (name,tenant_id) VALUES ('ScoreSmoke A',$TID); SELECT last_insert_rowid();")
sqlite3 "$DB" "INSERT INTO client_required_documents (client_id,document_type,coverage_requirement) VALUES
  ($CID,'General Liability','1M'),($CID,'Workers Comp','500000'),($CID,'W-9',NULL),($CID,'Business License',NULL);"
VID=$(sqlite3 "$DB" "INSERT INTO vendors (client_id,name,tenant_id) VALUES ($CID,'ScoreSmoke V1',$TID); SELECT last_insert_rowid();")

# One reviewed doc + extraction per required type. The extraction row is
# MANDATORY: a doc without one reads as unreviewed => needs_review (50).
mk_doc () { # type, expiry-sql, gl_occurrence, wc_employers, is_reviewed
  local dtype="$1" exp="$2" gl="$3" wc="$4" rev="$5"
  local did
  did=$(sqlite3 "$DB" "INSERT INTO documents (vendor_id,client_id,document_type,file_path,original_filename,received_date,tenant_id)
    VALUES ($VID,$CID,'$dtype','documents/$TID/s.pdf','s.pdf',datetime('now'),$TID); SELECT last_insert_rowid();")
  sqlite3 "$DB" "INSERT INTO document_extractions (document_id,expiration_date,is_reviewed,coverage_gl_occurrence,coverage_wc_employers,document_type)
    VALUES ($did,$exp,$rev,$gl,$wc,'$dtype');"
  echo "$did"
}
GL_DOC=$(mk_doc "General Liability" "'2027-06-30'" 2000000 NULL 1)
WC_DOC=$(mk_doc "Workers Comp"      "'2027-06-30'" NULL 1000000 1)
W9_DOC=$(mk_doc "W-9"               NULL           NULL NULL     1)
BL_DOC=$(mk_doc "Business License"  "'2027-06-30'" NULL NULL     1)
echo "user=$USER_ID tenant=$TID clientA=$CID vendor=$VID docs=$GL_DOC,$WC_DOC,$W9_DOC,$BL_DOC"

# Client B — ONE required type (GL @ $1M) for single-type score arithmetic.
CID_B=$(sqlite3 "$DB" "INSERT INTO clients (name,tenant_id) VALUES ('ScoreSmoke B',$TID); SELECT last_insert_rowid();")
sqlite3 "$DB" "INSERT INTO client_required_documents (client_id,document_type,coverage_requirement) VALUES ($CID_B,'General Liability','1M');"
VID_B=$(sqlite3 "$DB" "INSERT INTO vendors (client_id,name,tenant_id) VALUES ($CID_B,'ScoreSmoke V2',$TID); SELECT last_insert_rowid();")
VB_DOC=$(sqlite3 "$DB" "INSERT INTO documents (vendor_id,client_id,document_type,file_path,original_filename,received_date,tenant_id)
  VALUES ($VID_B,$CID_B,'General Liability','documents/$TID/sb.pdf','sb.pdf',datetime('now'),$TID); SELECT last_insert_rowid();")
sqlite3 "$DB" "INSERT INTO document_extractions (document_id,expiration_date,is_reviewed,coverage_gl_occurrence,document_type)
  VALUES ($VB_DOC,'2027-06-30',1,500000,'General Liability');"

# Client C — NO required document types (score must be 100/Good by definition).
CID_C=$(sqlite3 "$DB" "INSERT INTO clients (name,tenant_id) VALUES ('ScoreSmoke C',$TID); SELECT last_insert_rowid();")
VID_C=$(sqlite3 "$DB" "INSERT INTO vendors (client_id,name,tenant_id) VALUES ($CID_C,'ScoreSmoke V3',$TID); SELECT last_insert_rowid();")

echo "### mint JWT with the app signer"
TMPD=$(mktemp -d)
cat > "$TMPD/mint.ts" <<EOF
import { createAuthToken } from "$ROOT/src/middleware";
const [uid, email, name] = process.argv.slice(2);
console.log(await createAuthToken({ user_id: Number(uid), email, full_name: name }));
EOF
bun run "$TMPD/mint.ts" "$USER_ID" "$EMAIL" ScoreSmoke > "$TMPD/token.out" 2>&1
TOKEN=$(tail -1 "$TMPD/token.out")   # secrets.ts logs to stdout at import; the JWT is the LAST line
echo "token_len=${#TOKEN}"

# ── Helpers ─────────────────────────────────────────────────────────────────
recalc () { curl -s -m 15 -X POST "$API/api/compliance/recalculate" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"vendor_id\":$1,\"client_id\":$2}" -o "$TMPD/recalc.json"; }

# Asserts the score on ALL FOUR response surfaces + the stored DB row.
check_score () { # label, vendor_id, exp_score, exp_label
  local label="$1" v="$2" exp_score="$3" exp_label="$4"
  curl -s -m 15 "$API/api/vendors"                -H "Authorization: Bearer $TOKEN" -o "$TMPD/list.json"
  curl -s -m 15 "$API/api/vendors/$v"             -H "Authorization: Bearer $TOKEN" -o "$TMPD/vendor.json"
  curl -s -m 15 "$API/api/vendors/$v/compliance-detail" -H "Authorization: Bearer $TOKEN" -o "$TMPD/detail.json"
  curl -s -m 15 "$API/api/dashboard/clear-to-pay" -H "Authorization: Bearer $TOKEN" -o "$TMPD/dash.json"
  local l_s l_l d_s d_l c_s c_l k_s k_l db_row
  l_s=$(jq -r --argjson v "$v" '.[] | select(.id==$v) | .compliance_score' "$TMPD/list.json")
  l_l=$(jq -r --argjson v "$v" '.[] | select(.id==$v) | .score_label' "$TMPD/list.json")
  d_s=$(jq -r '.compliance_score' "$TMPD/vendor.json")
  d_l=$(jq -r '.score_label' "$TMPD/vendor.json")
  c_s=$(jq -r '.compliance_score' "$TMPD/detail.json")
  c_l=$(jq -r '.score_label' "$TMPD/detail.json")
  k_s=$(jq -r --argjson v "$v" '.vendors[] | select(.vendor_id==$v) | .compliance_score' "$TMPD/dash.json")
  k_l=$(jq -r --argjson v "$v" '.vendors[] | select(.vendor_id==$v) | .score_label' "$TMPD/dash.json")
  db_row=$(sqlite3 "$DB" "SELECT COALESCE(compliance_score,'NULL')||'|'||COALESCE(score_label,'NULL') FROM compliance_status WHERE vendor_id=$v;")
  local detail
  detail=$(jq -c '{status,payment_status,compliance_score,score_label,types:[.details[]|{t:.document_type,s:.status}]}' "$TMPD/detail.json")
  echo "--- $label"
  echo "  list=$l_s/$l_l detail=$d_s/$d_l compl-detail=$c_s/$c_l dashboard=$k_s/$k_l db=$db_row"
  echo "  engine: $detail"
  eq "$label list score"      "$l_s" "$exp_score"; eq "$label list label"      "$l_l" "$exp_label"
  eq "$label detail score"    "$d_s" "$exp_score"; eq "$label detail label"    "$d_l" "$exp_label"
  eq "$label compl-detail"    "$c_s" "$exp_score"; eq "$label compl-detail label" "$c_l" "$exp_label"
  eq "$label dashboard score" "$k_s" "$exp_score"; eq "$label dashboard label" "$k_l" "$exp_label"
  eq "$label db row"          "$db_row" "$exp_score|$exp_label"
}

# ── Case 1: every required type compliant -> 100/Good ───────────────────────
recalc "$VID" "$CID"
check_score "case1 all-compliant" "$VID" 100 "Good"
eq "case1 payment status" "$(jq -r '.payment_status' "$TMPD/detail.json")" "approved"

# ── Case 2: one required type MISSING -> (100+100+100+0)/4 = 75/Fair ────────
sqlite3 "$DB" "DELETE FROM document_extractions WHERE document_id=$BL_DOC; DELETE FROM documents WHERE id=$BL_DOC;"
recalc "$VID" "$CID"
check_score "case2 one-missing" "$VID" 75 "Fair"
eq "case2 payment status" "$(jq -r '.payment_status' "$TMPD/detail.json")" "hold"

# ── Case 3: GL below the $1M requirement -> (25+100+100+100)/4 = 81/Good ────
BL_DOC=$(mk_doc "Business License" "'2027-06-30'" NULL NULL 1)
sqlite3 "$DB" "UPDATE document_extractions SET coverage_gl_occurrence=500000 WHERE document_id=$GL_DOC;"
recalc "$VID" "$CID"
check_score "case3 below-limit" "$VID" 81 "Good"
eq "case3 GL type status"  "$(jq -r '.details[]|select(.document_type=="General Liability")|.status' "$TMPD/detail.json")" "below_limit"
eq "case3 payment status"  "$(jq -r '.payment_status' "$TMPD/detail.json")" "hold"

# ── Case 4: GL expiring within 14 days -> (75+100+100+100)/4 = 94/Good ──────
sqlite3 "$DB" "UPDATE document_extractions SET coverage_gl_occurrence=2000000, expiration_date=date('now','+7 day') WHERE document_id=$GL_DOC;"
recalc "$VID" "$CID"
check_score "case4 expiring-soon" "$VID" 94 "Good"
eq "case4 GL type status" "$(jq -r '.details[]|select(.document_type=="General Liability")|.status' "$TMPD/detail.json")" "expiring_soon"

# ── Case 5: GL unreviewed -> needs_review 50 -> (50+100+100+100)/4 = 88/Good ─
sqlite3 "$DB" "UPDATE document_extractions SET expiration_date='2027-06-30', is_reviewed=0 WHERE document_id=$GL_DOC;"
recalc "$VID" "$CID"
check_score "case5 needs-review" "$VID" 88 "Good"
eq "case5 GL type status" "$(jq -r '.details[]|select(.document_type=="General Liability")|.status' "$TMPD/detail.json")" "needs_review"
sqlite3 "$DB" "UPDATE document_extractions SET is_reviewed=1 WHERE document_id=$GL_DOC;"

# ── Case 6: single required type -> the raw mapping is visible ──────────────
recalc "$VID_B" "$CID_B"                       # GL below limit -> 25/Poor
check_score "case6a below-limit-only" "$VID_B" 25 "Poor"
sqlite3 "$DB" "UPDATE document_extractions SET coverage_gl_occurrence=2000000 WHERE document_id=$VB_DOC;"
recalc "$VID_B" "$CID_B"                       # compliant -> 100/Good
check_score "case6b compliant-only" "$VID_B" 100 "Good"
sqlite3 "$DB" "UPDATE document_extractions SET expiration_date='2020-01-01' WHERE document_id=$VB_DOC;"
recalc "$VID_B" "$CID_B"                       # expired -> 0/Poor
check_score "case6c expired-only" "$VID_B" 0 "Poor"

# ── Case 7: client with NO required types -> 100/Good by definition ─────────
recalc "$VID_C" "$CID_C"
check_score "case7 no-requirements" "$VID_C" 100 "Good"

# ── Case 8: legacy-row backfill (NULL score columns are self-healed on read) ─
sqlite3 "$DB" "UPDATE compliance_status SET compliance_score=NULL, score_label=NULL WHERE vendor_id=$VID_B;"
curl -s -m 15 "$API/api/vendors" -H "Authorization: Bearer $TOKEN" -o "$TMPD/list.json"
BF=$(jq -r --argjson v "$VID_B" '.[] | select(.id==$v) | "\(.compliance_score)/\(.score_label)"' "$TMPD/list.json")
eq "case8 backfilled on vendor-list read" "$BF" "0/Poor"

echo "### cleanup"
sqlite3 "$DB" "DELETE FROM compliance_status WHERE vendor_id IN ($VID,$VID_B,$VID_C);
DELETE FROM document_extractions WHERE document_id IN ($GL_DOC,$WC_DOC,$W9_DOC,$BL_DOC,$VB_DOC);
DELETE FROM documents WHERE tenant_id=$TID;
DELETE FROM vendors WHERE tenant_id=$TID;
DELETE FROM client_required_documents WHERE client_id IN ($CID,$CID_B);
DELETE FROM clients WHERE tenant_id=$TID;
DELETE FROM users WHERE id=$USER_ID;
DELETE FROM tenants WHERE id=$TID;"
rm -rf "$TMPD"
echo "leftovers: tenants=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tenants WHERE id=$TID;") users=$(sqlite3 "$DB" "SELECT COUNT(*) FROM users WHERE id=$USER_ID;") clients=$(sqlite3 "$DB" "SELECT COUNT(*) FROM clients WHERE tenant_id=$TID;") vendors=$(sqlite3 "$DB" "SELECT COUNT(*) FROM vendors WHERE tenant_id=$TID;") docs=$(sqlite3 "$DB" "SELECT COUNT(*) FROM documents WHERE tenant_id=$TID;") cs=$(sqlite3 "$DB" "SELECT COUNT(*) FROM compliance_status WHERE vendor_id IN ($VID,$VID_B,$VID_C);")"
curl -s -m 5 -o /dev/null -w "post-cleanup health=%{http_code}\n" "$API/api/health"
echo "### RESULT FAIL=$FAIL"
exit "$FAIL"
