#!/bin/bash
# Coverage-enforcement smoke test (owner "Simple": ONE dollar amount per required
# doc type). Proves the engine gate end-to-end against a RUNNING API:
#   extracted limit <  required  -> type status below_limit, payment HOLD, reason shows both amounts
#   extracted limit >= required  -> no coverage flag (compliant / approved)
#   limit unreadable (NULL)      -> needs_review / Review (never auto-Hold)
#   unparseable requirement      -> coverage gate skipped entirely
#
# It creates ONE throwaway tenant/client/vendor/doc via the sqlite3 CLI (never a
# second bun:sqlite process — that can hang while the API holds the DB), mints a
# real JWT for the throwaway owner with the app's own signer, calls the live API,
# then deletes every row it created.
#
# Usage:  bash api/scripts/coverage-smoke.sh [base_url]     (default http://localhost:3001)
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)          # .../clear-to-pay/api
cd "$ROOT" || exit 1
DB="$ROOT/data/cleartopay.db"
API="${1:-http://localhost:3001}"
SLUG="CovSmoke$(date +%s)"
EMAIL="covsmoke-$SLUG@example.com"
DOC_TYPE="General Liability"      # must equal the canonical type string exactly
REQUIREMENT="1M"                  # owner-entered text; "1M"/"$1,000,000"/"1000000" all parse to 1000000
FAIL=0

echo "### health"
curl -s -m 5 -o /dev/null -w "health=%{http_code}\n" "$API/api/health"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$API/api/health")" = "200" ] || { echo "API not healthy — aborting"; exit 1; }

echo "### seed throwaway tenant (sqlite3 CLI)"
sqlite3 "$DB" "INSERT INTO users (full_name,company_name,email,password_hash) VALUES ('CovSmoke','CovSmoke','$EMAIL','x');"
USER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE email='$EMAIL';")
TID=$(sqlite3 "$DB" "INSERT INTO tenants (name,owner_user_id,inbox_slug,subscription_status) VALUES ('CovSmoke-$SLUG',$USER_ID,'$SLUG','TRIAL'); SELECT last_insert_rowid();")
sqlite3 "$DB" "UPDATE users SET tenant_id=$TID WHERE id=$USER_ID;"
CID=$(sqlite3 "$DB" "INSERT INTO clients (name,tenant_id) VALUES ('CovSmoke Client',$TID); SELECT last_insert_rowid();")
sqlite3 "$DB" "INSERT INTO client_required_documents (client_id,document_type,coverage_requirement) VALUES ($CID,'$DOC_TYPE','$REQUIREMENT');"
VID=$(sqlite3 "$DB" "INSERT INTO vendors (client_id,name,tenant_id) VALUES ($CID,'CovSmoke Vendor',$TID); SELECT last_insert_rowid();")
DID=$(sqlite3 "$DB" "INSERT INTO documents (vendor_id,client_id,document_type,file_path,original_filename,received_date,tenant_id) VALUES ($VID,$CID,'$DOC_TYPE','documents/$TID/cov.pdf','cov.pdf',datetime('now'),$TID); SELECT last_insert_rowid();")
# NOTE: this extraction row is mandatory — without it the engine sees an
# UNREVIEWED doc and reports needs_review, and the whole test reads as a false failure.
sqlite3 "$DB" "INSERT INTO document_extractions (document_id,expiration_date,is_reviewed,coverage_gl_occurrence,document_type) VALUES ($DID,'2027-06-30',1,500000,'$DOC_TYPE');"
echo "user=$USER_ID tenant=$TID client=$CID vendor=$VID doc=$DID ext_rows=$(sqlite3 "$DB" "SELECT COUNT(*) FROM document_extractions WHERE document_id=$DID;")"

echo "### mint JWT with the app signer"
TMPD=$(mktemp -d)
cat > "$TMPD/mint.ts" <<EOF
import { createAuthToken } from "$ROOT/src/middleware";
const [uid, email, name] = process.argv.slice(2);
console.log(await createAuthToken({ user_id: Number(uid), email, full_name: name }));
EOF
bun run "$TMPD/mint.ts" "$USER_ID" "$EMAIL" CovSmoke > "$TMPD/token.out" 2>&1
TOKEN=$(tail -1 "$TMPD/token.out")   # secrets.ts logs to stdout at import; the JWT is the LAST line
echo "token_len=${#TOKEN}"

check_case () {
  local label="$1" limit="$2" exp_status="$3" exp_pay="$4" exp_cs="$5" exp_reason="$6"
  echo "--- case $label (extracted limit = $limit)"
  sqlite3 "$DB" "UPDATE document_extractions SET coverage_gl_occurrence=$limit, expiration_date='2027-06-30', is_reviewed=1 WHERE document_id=$DID;"
  sleep 1
  curl -s -m 15 -X POST "$API/api/compliance/recalculate" -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' -d "{\"vendor_id\":$VID,\"client_id\":$CID}" -o "$TMPD/recalc.json"
  curl -s -m 15 "$API/api/vendors/$VID/compliance-detail" -H "Authorization: Bearer $TOKEN" -o "$TMPD/detail.json"
  curl -s -m 15 "$API/api/dashboard/clear-to-pay" -H "Authorization: Bearer $TOKEN" -o "$TMPD/dash.json"
  local got_status got_pay got_cs got_reason
  got_status=$(jq -r '.details[0].status' "$TMPD/detail.json")
  got_pay=$(jq -r '.payment_status' "$TMPD/detail.json")
  got_cs=$(jq -r '.details[0].coverage_status' "$TMPD/detail.json")
  got_reason=$(jq -r --argjson v "$VID" '.vendors[] | select(.vendor_id==$v) | .reason' "$TMPD/dash.json")
  echo "  detail: $(jq -c '{status,payment_status,d0:.details[0]}' "$TMPD/detail.json")"
  echo "  compliance_status row: $(sqlite3 "$DB" "SELECT status||'|'||payment_status FROM compliance_status WHERE vendor_id=$VID;")"
  echo "  dashboard reason: $got_reason"
  [ "$got_status" = "$exp_status" ] || { echo "  FAIL type status: expected $exp_status got $got_status"; FAIL=1; }
  [ "$got_pay" = "$exp_pay" ]       || { echo "  FAIL payment status: expected $exp_pay got $got_pay"; FAIL=1; }
  [ "$got_cs" = "$exp_cs" ]         || { echo "  FAIL coverage_status: expected $exp_cs got $got_cs"; FAIL=1; }
  if [ -n "$exp_reason" ]; then
    case "$got_reason" in
      *"$exp_reason"*) echo "  OK reason contains: $exp_reason" ;;
      *) echo "  FAIL reason missing: $exp_reason"; FAIL=1 ;;
    esac
  fi
}

#                        label          limit     status         payment    cov_status    reason must contain
check_case "below_limit" 500000   below_limit  hold      below      "General Liability coverage 500,000 below required 1,000,000"
check_case "at_or_above" 2000000  compliant    approved  ok         ""
check_case "unreadable"  NULL     needs_review review    unreadable "coverage limit not readable"

echo "--- case requirement_unparseable (gate must be skipped)"
sqlite3 "$DB" "UPDATE client_required_documents SET coverage_requirement='Statutory' WHERE client_id=$CID;"
sqlite3 "$DB" "UPDATE document_extractions SET coverage_gl_occurrence=500000 WHERE document_id=$DID;"
sleep 1
curl -s -m 15 -X POST "$API/api/compliance/recalculate" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"vendor_id\":$VID,\"client_id\":$CID}" -o "$TMPD/recalc.json"
curl -s -m 15 "$API/api/vendors/$VID/compliance-detail" -H "Authorization: Bearer $TOKEN" -o "$TMPD/detail.json"
U_S=$(jq -r '.details[0].status' "$TMPD/detail.json"); U_P=$(jq -r '.payment_status' "$TMPD/detail.json"); U_CS=$(jq -r '.details[0].coverage_status' "$TMPD/detail.json")
echo "  status=$U_S payment=$U_P coverage_status=$U_CS"
[ "$U_S" = "compliant" ] && [ "$U_P" = "approved" ] && [ "$U_CS" = "null" ] || { echo "  FAIL unparseable requirement must skip the gate"; FAIL=1; }

echo "--- case missing_type (vendor has NO doc of a gated type)"
# Regression guard for the dashboard-reason nit: a fully missing required type
# must show ONLY "Missing: …" — the coverage gate never ran on it, so the reason
# must not also claim the limit is unreadable (two contradictory reasons).
sqlite3 "$DB" "DELETE FROM document_extractions WHERE document_id=$DID; DELETE FROM documents WHERE id=$DID;"
sleep 1
curl -s -m 15 -X POST "$API/api/compliance/recalculate" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"vendor_id\":$VID,\"client_id\":$CID}" -o "$TMPD/recalc.json"
curl -s -m 15 "$API/api/vendors/$VID/compliance-detail" -H "Authorization: Bearer $TOKEN" -o "$TMPD/detail.json"
curl -s -m 15 "$API/api/dashboard/clear-to-pay" -H "Authorization: Bearer $TOKEN" -o "$TMPD/dash.json"
M_S=$(jq -r '.details[0].status' "$TMPD/detail.json"); M_P=$(jq -r '.payment_status' "$TMPD/detail.json")
M_CS=$(jq -r '.details[0].coverage_status' "$TMPD/detail.json")
M_REASON=$(jq -r --argjson v "$VID" '.vendors[] | select(.vendor_id==$v) | .reason' "$TMPD/dash.json")
echo "  status=$M_S payment=$M_P coverage_status=$M_CS"
echo "  dashboard reason: $M_REASON"
[ "$M_S" = "missing" ] || { echo "  FAIL missing type status: expected missing got $M_S"; FAIL=1; }
[ "$M_P" = "hold" ]    || { echo "  FAIL missing type payment: expected hold got $M_P"; FAIL=1; }
case "$M_REASON" in
  *"Missing: $DOC_TYPE"*) echo "  OK reason contains: Missing: $DOC_TYPE" ;;
  *) echo "  FAIL reason missing the Missing: line: $M_REASON"; FAIL=1 ;;
esac
case "$M_REASON" in
  *"not readable"*) echo "  FAIL fully-missing type must not also say 'not readable': $M_REASON"; FAIL=1 ;;
  *) echo "  OK no spurious coverage-limit reason on a missing type" ;;
esac

echo "### cleanup"
sqlite3 "$DB" "DELETE FROM compliance_status WHERE vendor_id=$VID;
DELETE FROM document_extractions WHERE document_id=$DID;
DELETE FROM documents WHERE tenant_id=$TID;
DELETE FROM vendors WHERE id=$VID;
DELETE FROM client_required_documents WHERE client_id=$CID;
DELETE FROM clients WHERE id=$CID;
DELETE FROM users WHERE id=$USER_ID;
DELETE FROM tenants WHERE id=$TID;"
rm -rf "$TMPD"
echo "leftovers: tenant=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tenants WHERE id=$TID;") doc=$(sqlite3 "$DB" "SELECT COUNT(*) FROM documents WHERE tenant_id=$TID;") user=$(sqlite3 "$DB" "SELECT COUNT(*) FROM users WHERE id=$USER_ID;") ext=$(sqlite3 "$DB" "SELECT COUNT(*) FROM document_extractions WHERE document_id=$DID;")"
curl -s -m 5 -o /dev/null -w "post-cleanup health=%{http_code}\n" "$API/api/health"
echo "### RESULT FAIL=$FAIL"
exit "$FAIL"
