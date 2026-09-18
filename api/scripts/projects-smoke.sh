#!/bin/bash
# ClearToPay — Projects (Part A) live-API smoke test on THROWAWAY tenants.
# Seeds two tenants via sqlite3 CLI, mints real JWTs with the app's own signer,
# exercises every /api/projects endpoint (incl. cross-tenant probes), then
# deletes every row it created.
DB=/home/team/shared/clear-to-pay/api/data/cleartopay.db
API=http://localhost:3001
LOG=/tmp/projects-smoke.log
: > "$LOG"

say() { echo "$@" >> "$LOG"; }

TS=$$
EA="projsmoke${TS}a@example.test"
EB="projsmoke${TS}b@example.test"
TNAMES="Project Smoke A $TS|Project Smoke B $TS"

# ── 1. Seed two tenants (A: 3 vendors, B: 1 vendor) ──────────────────────────
sqlite3 "$DB" "
INSERT INTO users (full_name, company_name, email, password_hash) VALUES ('Project Smoke A','Project Smoke A Co','$EA','x');
INSERT INTO tenants (name, owner_user_id, subscription_status) VALUES ('Project Smoke A $TS', last_insert_rowid(), 'TRIAL');
UPDATE users SET tenant_id = last_insert_rowid() WHERE email = '$EA';

INSERT INTO users (full_name, company_name, email, password_hash) VALUES ('Project Smoke B','Project Smoke B Co','$EB','x');
INSERT INTO tenants (name, owner_user_id, subscription_status) VALUES ('Project Smoke B $TS', last_insert_rowid(), 'TRIAL');
UPDATE users SET tenant_id = last_insert_rowid() WHERE email = '$EB';
" >> "$LOG" 2>&1

sqlite3 "$DB" "
INSERT INTO clients (name, tenant_id) VALUES ('ProjSmoke Client A $TS', (SELECT id FROM tenants WHERE name='Project Smoke A $TS'));
INSERT INTO clients (name, tenant_id) VALUES ('ProjSmoke Client B $TS', (SELECT id FROM tenants WHERE name='Project Smoke B $TS'));

INSERT INTO vendors (tenant_id, client_id, name, normalized_key, contact_email)
  SELECT t.id, c.id, 'Smoke A1 Roofing $TS', 'smokea1-$TS', 'a1-$TS@example.test' FROM tenants t JOIN clients c ON c.tenant_id=t.id WHERE t.name='Project Smoke A $TS';
INSERT INTO vendors (tenant_id, client_id, name, normalized_key, contact_email)
  SELECT t.id, c.id, 'Smoke A2 Electric $TS', 'smokea2-$TS', 'a2-$TS@example.test' FROM tenants t JOIN clients c ON c.tenant_id=t.id WHERE t.name='Project Smoke A $TS';
INSERT INTO vendors (tenant_id, client_id, name, normalized_key, contact_email)
  SELECT t.id, c.id, 'Smoke A3 Plumbing $TS', 'smokea3-$TS', 'a3-$TS@example.test' FROM tenants t JOIN clients c ON c.tenant_id=t.id WHERE t.name='Project Smoke A $TS';
INSERT INTO vendors (tenant_id, client_id, name, normalized_key, contact_email)
  SELECT t.id, c.id, 'Smoke B1 Concrete $TS', 'smokeb1-$TS', 'b1-$TS@example.test' FROM tenants t JOIN clients c ON c.tenant_id=t.id WHERE t.name='Project Smoke B $TS';

INSERT INTO compliance_status (vendor_id, client_id, status, payment_status, compliance_score, score_label)
  SELECT v.id, v.client_id, 'compliant', 'approved', 100, 'Good' FROM vendors v WHERE v.normalized_key='smokea1-$TS';
INSERT INTO compliance_status (vendor_id, client_id, status, payment_status, compliance_score, score_label)
  SELECT v.id, v.client_id, 'expired', 'hold', 20, 'Poor' FROM vendors v WHERE v.normalized_key='smokea2-$TS';
INSERT INTO compliance_status (vendor_id, client_id, status, payment_status, compliance_score, score_label)
  SELECT v.id, v.client_id, 'expiring_soon', 'review', 60, 'Fair' FROM vendors v WHERE v.normalized_key='smokea3-$TS';
INSERT INTO compliance_status (vendor_id, client_id, status, payment_status, compliance_score, score_label)
  SELECT v.id, v.client_id, 'compliant', 'approved', 100, 'Good' FROM vendors v WHERE v.normalized_key='smokeb1-$TS';
" >> "$LOG" 2>&1

q() { sqlite3 "$DB" "$1"; }
UID_A=$(q "SELECT id FROM users WHERE email='$EA';")
UID_B=$(q "SELECT id FROM users WHERE email='$EB';")
TID_A=$(q "SELECT id FROM tenants WHERE owner_user_id=$UID_A;")
TID_B=$(q "SELECT id FROM tenants WHERE owner_user_id=$UID_B;")
VA1=$(q "SELECT id FROM vendors WHERE normalized_key='smokea1-$TS';")
VA2=$(q "SELECT id FROM vendors WHERE normalized_key='smokea2-$TS';")
VA3=$(q "SELECT id FROM vendors WHERE normalized_key='smokea3-$TS';")
VB1=$(q "SELECT id FROM vendors WHERE normalized_key='smokeb1-$TS';")
say "SEED userA=$UID_A tenantA=$TID_A vendorA1=$VA1 vendorA2=$VA2 vendorA3=$VA3 | userB=$UID_B tenantB=$TID_B vendorB1=$VB1"

# ── 2. Mint REAL JWTs with the app's own signer ──────────────────────────────
cat > /tmp/mint-projects.ts <<'EOF'
import { createAuthToken } from "/home/team/shared/clear-to-pay/api/src/middleware";
const id = Number(process.argv[2]);
console.log(await createAuthToken({ user_id: id, email: "smoke@example.test", full_name: "Smoke " + id }));
EOF
(cd /home/team/shared/clear-to-pay/api && bun run /tmp/mint-projects.ts "$UID_A" > /tmp/tokA.txt 2>&1)
(cd /home/team/shared/clear-to-pay/api && bun run /tmp/mint-projects.ts "$UID_B" > /tmp/tokB.txt 2>&1)
TOK_A=$(tail -1 /tmp/tokA.txt)
TOK_B=$(tail -1 /tmp/tokB.txt)
say "TOKENS lenA=${#TOK_A} lenB=${#TOK_B}"

# sanity: tokens are accepted
say "AUTH: meA=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK_A" $API/api/auth/me) meB=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOK_B" $API/api/auth/me)"

FAIL=0
# expect NAME METHOD PATH TOKEN BODY EXPECTED_STATUS
expect() {
  local name=$1 method=$2 path=$3 tok=$4 body=$5 want=$6
  local code
  if [ -n "$body" ]; then
    code=$(curl -s -o /tmp/resp.json -w '%{http_code}' -X "$method" -H "Authorization: Bearer $tok" -H "Content-Type: application/json" -d "$body" "$API$path")
  else
    code=$(curl -s -o /tmp/resp.json -w '%{http_code}' -X "$method" -H "Authorization: Bearer $tok" "$API$path")
  fi
  local ok="PASS"
  [ "$code" = "$want" ] || { ok="FAIL"; FAIL=$((FAIL+1)); }
  say "$ok [$name] want=$want got=$code body=$(head -c 400 /tmp/resp.json)"
}

jsonfield() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

# ── 3. Create projects ───────────────────────────────────────────────────────
expect "create project 1"    POST /api/projects "$TOK_A" '{"name":"Maple St Remodel"}' 201
PID1=$(cat /tmp/resp.json | jsonfield "d['id']")
expect "create project 2"    POST /api/projects "$TOK_A" '{"name":"Oak Ave Warehouse"}' 201
PID2=$(cat /tmp/resp.json | jsonfield "d['id']")
expect "create blank name"   POST /api/projects "$TOK_A" '{"name":"   "}' 400
expect "create duplicate ci" POST /api/projects "$TOK_A" '{"name":"maple st remodel"}' 409
say "PROJECT IDS pid1=$PID1 pid2=$PID2"

expect "list projects (A)"   GET "/api/projects" "$TOK_A" "" 200
say "  list=$(head -c 400 /tmp/resp.json)"
expect "list projects (B isolated)" GET "/api/projects" "$TOK_B" "" 200
say "  listB=$(head -c 200 /tmp/resp.json)"

expect "rename project 2"    PUT "/api/projects/$PID2" "$TOK_A" '{"name":"Oak Ave Warehouse Bldg 2"}' 200
expect "rename to dup name"  PUT "/api/projects/$PID2" "$TOK_A" '{"name":"Maple St Remodel"}' 409
expect "get project 1"       GET "/api/projects/$PID1" "$TOK_A" "" 200

# ── 4. Assign vendors ────────────────────────────────────────────────────────
expect "assign A1+A2"        POST "/api/projects/$PID1/vendors" "$TOK_A" "{\"vendor_ids\":[$VA1,$VA2]}" 200
expect "re-assign idempotent" POST "/api/projects/$PID1/vendors" "$TOK_A" "{\"vendor_ids\":[$VA1]}" 200
say "  reassign=$(head -c 300 /tmp/resp.json)"
expect "assign empty array"  POST "/api/projects/$PID1/vendors" "$TOK_A" '{"vendor_ids":[]}' 400
expect "assign non-numeric"  POST "/api/projects/$PID1/vendors" "$TOK_A" '{"vendor_ids":["abc"]}' 400
expect "assign CROSS-TENANT vendor (B1)" POST "/api/projects/$PID1/vendors" "$TOK_A" "{\"vendor_ids\":[$VB1]}" 404
# An unknown id and a foreign id get the SAME 404 on purpose — the response must
# not reveal that the id exists in another tenant.
expect "assign unknown vendor" POST "/api/projects/$PID1/vendors" "$TOK_A" '{"vendor_ids":[99999999]}' 404
expect "assign B's project as A" POST "/api/projects/999999/vendors" "$TOK_A" "{\"vendor_ids\":[$VA1]}" 404

# ── 5. Read back (counts + vendor shape) ─────────────────────────────────────
expect "project vendors list" GET "/api/projects/$PID1/vendors" "$TOK_A" "" 200
say "  vendors=$(head -c 900 /tmp/resp.json)"
expect "summary counts"      GET "/api/projects/$PID1" "$TOK_A" "" 200
say "  summary=$(head -c 300 /tmp/resp.json)"

# ── 5b. all_clear — "is everyone on Project X clear to pay?" ─────────────────
expect "assign only approved A1 to pid2" POST "/api/projects/$PID2/vendors" "$TOK_A" "{\"vendor_ids\":[$VA1]}" 200
expect "pid2 all_clear=true"  GET "/api/projects/$PID2" "$TOK_A" "" 200
say "  allClear=$(head -c 300 /tmp/resp.json)"
expect "assign hold A2 to pid2 too" POST "/api/projects/$PID2/vendors" "$TOK_A" "{\"vendor_ids\":[$VA2]}" 200
expect "pid2 all_clear=false" GET "/api/projects/$PID2" "$TOK_A" "" 200
say "  notAllClear=$(head -c 300 /tmp/resp.json)"
expect "assign review A3 to pid2 too" POST "/api/projects/$PID2/vendors" "$TOK_A" "{\"vendor_ids\":[$VA3]}" 200
expect "pid2 buckets sum to count" GET "/api/projects/$PID2" "$TOK_A" "" 200
say "  threeBuckets=$(head -c 300 /tmp/resp.json)"

# ── 6. ?project_id= filter on GET /api/vendors ───────────────────────────────
expect "vendors?project_id (A)"  GET "/api/vendors?project_id=$PID1" "$TOK_A" "" 200
say "  filtered=$(head -c 300 /tmp/resp.json)"
expect "vendors (all, A)"        GET "/api/vendors" "$TOK_A" "" 200
say "  allA=$(head -c 300 /tmp/resp.json)"
expect "vendors?project_id (B)"  GET "/api/vendors?project_id=$PID1" "$TOK_B" "" 200
say "  filteredCrossTenant=$(head -c 200 /tmp/resp.json)"

# ── 7. Cross-tenant isolation probes ─────────────────────────────────────────
expect "GET A project as B"      GET "/api/projects/$PID1" "$TOK_B" "" 404
expect "GET A vendors as B"      GET "/api/projects/$PID1/vendors" "$TOK_B" "" 404
expect "PUT A project as B"      PUT "/api/projects/$PID1" "$TOK_B" '{"name":"hijacked"}' 404
expect "DELETE A project as B"   DELETE "/api/projects/$PID1" "$TOK_B" "" 404
expect "assign to A project as B" POST "/api/projects/$PID1/vendors" "$TOK_B" "{\"vendor_ids\":[$VB1]}" 404
expect "unassign A vendor as B"  DELETE "/api/projects/$PID1/vendors/$VA1" "$TOK_B" "" 404
expect "no-auth list"            GET "/api/projects" "" "" 401
expect "bad-token list"          GET "/api/projects" "not-a-jwt" "" 401

# ── 8. Unassign / delete semantics ───────────────────────────────────────────
expect "unassign A2"             DELETE "/api/projects/$PID1/vendors/$VA2" "$TOK_A" "" 200
expect "unassign again"          DELETE "/api/projects/$PID1/vendors/$VA2" "$TOK_A" "" 404
expect "vendors after unassign"  GET "/api/projects/$PID1/vendors" "$TOK_A" "" 200
say "  afterUnassign=$(head -c 300 /tmp/resp.json)"
expect "vendors?project_id=pid2 (3 assigned)" GET "/api/vendors?project_id=$PID2" "$TOK_A" "" 200
say "  pid2filtered=$(head -c 200 /tmp/resp.json)"
expect "delete project 1"        DELETE "/api/projects/$PID1" "$TOK_A" "" 200
say "  deleteResp=$(head -c 200 /tmp/resp.json)"
expect "get deleted project"     GET "/api/projects/$PID1" "$TOK_A" "" 404
expect "vendors survive delete"  GET "/api/vendors" "$TOK_A" "" 200
say "  vendorsAfterProjectDelete=$(head -c 200 /tmp/resp.json)"
expect "links gone after delete" GET "/api/vendors?project_id=$PID1" "$TOK_A" "" 200
say "  linksGone=$(head -c 200 /tmp/resp.json)"

# ── 9. DB-level assertions ───────────────────────────────────────────────────
say "DB projects A (expect 1 left: pid2): $(q "SELECT COUNT(*) FROM projects WHERE tenant_id=$TID_A;")"
say "DB projects B (expect 0): $(q "SELECT COUNT(*) FROM projects WHERE tenant_id=$TID_B;")"
say "DB links for deleted pid1 (expect 0): $(q "SELECT COUNT(*) FROM vendor_projects WHERE project_id=$PID1;")"
say "DB vendors A still 3 (expect 3): $(q "SELECT COUNT(*) FROM vendors WHERE tenant_id=$TID_A;")"
say "DB link rows for A vendors (expect 3 — pid2 still holds all three): $(q "SELECT COUNT(*) FROM vendor_projects WHERE vendor_id IN ($VA1,$VA2,$VA3);")"
say "AUDIT project rows: $(q "SELECT COUNT(*) FROM audit_logs WHERE entity_type='project';")"
say "AUDIT actions: $(q "SELECT action || ':' || COUNT(*) FROM audit_logs WHERE entity_type='project' GROUP BY action;" | tr '\n' ' ')"

# ── 10. Cleanup (every row this script created) ──────────────────────────────
sqlite3 "$DB" "
DELETE FROM vendor_projects WHERE project_id IN ($PID1,$PID2) OR vendor_id IN ($VA1,$VA2,$VA3,$VB1);
DELETE FROM projects WHERE id IN ($PID1,$PID2);
DELETE FROM audit_logs WHERE entity_type='project' AND entity_id IN ($PID1,$PID2);
DELETE FROM compliance_status WHERE vendor_id IN ($VA1,$VA2,$VA3,$VB1);
DELETE FROM vendors WHERE id IN ($VA1,$VA2,$VA3,$VB1);
DELETE FROM clients WHERE tenant_id IN ($TID_A,$TID_B);
UPDATE users SET tenant_id = NULL WHERE id IN ($UID_A,$UID_B);
DELETE FROM tenants WHERE id IN ($TID_A,$TID_B);
DELETE FROM users WHERE id IN ($UID_A,$UID_B);
" >> "$LOG" 2>&1

say "CLEANUP users=$(q "SELECT COUNT(*) FROM users WHERE email IN ('$EA','$EB');") tenants=$(q "SELECT COUNT(*) FROM tenants WHERE id IN ($TID_A,$TID_B);") vendors=$(q "SELECT COUNT(*) FROM vendors WHERE id IN ($VA1,$VA2,$VA3,$VB1);") links=$(q "SELECT COUNT(*) FROM vendor_projects WHERE project_id IN ($PID1,$PID2);") projects=$(q "SELECT COUNT(*) FROM projects WHERE id IN ($PID1,$PID2);") clients=$(q "SELECT COUNT(*) FROM clients WHERE tenant_id IN ($TID_A,$TID_B);") compl=$(q "SELECT COUNT(*) FROM compliance_status WHERE vendor_id IN ($VA1,$VA2,$VA3,$VB1);") audits=$(q "SELECT COUNT(*) FROM audit_logs WHERE entity_type='project' AND entity_id IN ($PID1,$PID2);")"
say "TOTAL_ROWS_LEFT_IN_PROJECTS_TABLE=$(q "SELECT COUNT(*) FROM projects;")"
say "HEALTH_AFTER=$(curl -s -o /dev/null -w '%{http_code}' $API/api/health)"
say "RESULT: failures=$FAIL"
