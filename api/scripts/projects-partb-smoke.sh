#!/bin/bash
# ClearToPay — Projects (Part B) smoke test: dashboard "By project" readiness +
# weekly-report "By project" grouping (PDF / XLSX / CSV).
#
# Throwaway tenants via the sqlite3 CLI (never a 2nd bun:sqlite process), real
# JWTs minted with the app's own signer, live API. Ends by deleting every row it
# created AND every report object it generated in object storage.
#
# Covers:
#   * dashboard route returns per-project readiness (counts, all_clear, vendors)
#     that matches GET /api/projects exactly;
#   * a vendor on two projects, an empty project, and an unassigned vendor;
#   * a project shared with ANOTHER client of the same tenant — the dashboard
#     counts it tenant-wide, the weekly report for client A counts only client
#     A's vendors (no cross-client row leaks into the report);
#   * PDF + XLSX + CSV all carry the "By project" grouping;
#   * a tenant with NO projects gets the unchanged report (no section 7, no
#     "By Project" sheet, no project rows in the CSV) and an empty
#     dashboard `projects` array.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)          # .../clear-to-pay/api
DB="$ROOT/data/cleartopay.db"
API="${1:-http://localhost:3001}"
SLUG="PB$(date +%s)"
LOG=/tmp/projects-partb-smoke.log
TMPD=$(mktemp -d)
FAIL=0

: > "$LOG"
say() { echo "$@" | tee -a "$LOG"; }
fail() { FAIL=$((FAIL+1)); say "FAIL [$1] $2"; }
check() { # label expected actual
  if [ "$2" = "$3" ]; then say "PASS [$1] $3"; else FAIL=$((FAIL+1)); say "FAIL [$1] want=$2 got=$3"; fi
}

echo "### health"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$API/api/health")" = "200" ] || { echo "API not healthy"; exit 1; }

# ── 1. Seed two throwaway tenants ────────────────────────────────────────────
# Tenant A: 2 clients, 6 vendors, 4 projects (one empty, one shared across clients)
# Tenant B: 1 client, 1 vendor, NO projects (the unchanged-format control)
echo "### seed throwaway tenants"
sqlite3 "$DB" "
INSERT INTO users (full_name, company_name, email, password_hash) VALUES ('PB A','PB A','pb-a-$SLUG@example.test','x');
INSERT INTO tenants (name, owner_user_id, inbox_slug, subscription_status) VALUES ('PB A $SLUG', last_insert_rowid(), '$SLUG-a', 'TRIAL');
UPDATE users SET tenant_id = last_insert_rowid() WHERE email = 'pb-a-$SLUG@example.test';

INSERT INTO users (full_name, company_name, email, password_hash) VALUES ('PB B','PB B','pb-b-$SLUG@example.test','x');
INSERT INTO tenants (name, owner_user_id, inbox_slug, subscription_status) VALUES ('PB B $SLUG', last_insert_rowid(), '$SLUG-b', 'TRIAL');
UPDATE users SET tenant_id = last_insert_rowid() WHERE email = 'pb-b-$SLUG@example.test';
"

TIDA=$(sqlite3 "$DB" "SELECT id FROM tenants WHERE name='PB A $SLUG';")
TIDB=$(sqlite3 "$DB" "SELECT id FROM tenants WHERE name='PB B $SLUG';")
UIDA=$(sqlite3 "$DB" "SELECT id FROM users WHERE email='pb-a-$SLUG@example.test';")
UIDB=$(sqlite3 "$DB" "SELECT id FROM users WHERE email='pb-b-$SLUG@example.test';")

sqlite3 "$DB" "
INSERT INTO clients (name, tenant_id) VALUES ('PB Client A1', $TIDA);
INSERT INTO clients (name, tenant_id) VALUES ('PB Client A2', $TIDA);
INSERT INTO clients (name, tenant_id) VALUES ('PB Client B1', $TIDB);
"
CA1=$(sqlite3 "$DB" "SELECT id FROM clients WHERE name='PB Client A1' AND tenant_id=$TIDA;")
CA2=$(sqlite3 "$DB" "SELECT id FROM clients WHERE name='PB Client A2' AND tenant_id=$TIDA;")
CB1=$(sqlite3 "$DB" "SELECT id FROM clients WHERE name='PB Client B1' AND tenant_id=$TIDB;")

# No coverage_requirement on purpose: the coverage gate is not what this test is
# about, and leaving it NULL keeps an approved vendor approved.
sqlite3 "$DB" "
INSERT INTO client_required_documents (client_id, document_type) VALUES ($CA1, 'General Liability');
INSERT INTO client_required_documents (client_id, document_type) VALUES ($CA2, 'General Liability');
INSERT INTO client_required_documents (client_id, document_type) VALUES ($CB1, 'General Liability');

INSERT INTO vendors (tenant_id, client_id, name, contact_email) VALUES ($TIDA, $CA1, 'PB Alpha Roofing', 'alpha-$SLUG@example.test');
INSERT INTO vendors (tenant_id, client_id, name, contact_email) VALUES ($TIDA, $CA1, 'PB Bravo Electric', 'bravo-$SLUG@example.test');
INSERT INTO vendors (tenant_id, client_id, name, contact_email) VALUES ($TIDA, $CA1, 'PB Charlie Plumbing', 'charlie-$SLUG@example.test');
INSERT INTO vendors (tenant_id, client_id, name, contact_email) VALUES ($TIDA, $CA1, 'PB Delta Concrete', 'delta-$SLUG@example.test');
INSERT INTO vendors (tenant_id, client_id, name, contact_email) VALUES ($TIDA, $CA2, 'PB Echo Excavating', 'echo-$SLUG@example.test');
INSERT INTO vendors (tenant_id, client_id, name, contact_email) VALUES ($TIDA, $CA1, 'PB Foxtrot Framing', 'foxtrot-$SLUG@example.test');
INSERT INTO vendors (tenant_id, client_id, name, contact_email) VALUES ($TIDB, $CB1, 'PB Golf Mechanical', 'golf-$SLUG@example.test');
"
V1=$(sqlite3 "$DB" "SELECT id FROM vendors WHERE name='PB Alpha Roofing' AND tenant_id=$TIDA;")
V2=$(sqlite3 "$DB" "SELECT id FROM vendors WHERE name='PB Bravo Electric' AND tenant_id=$TIDA;")
V3=$(sqlite3 "$DB" "SELECT id FROM vendors WHERE name='PB Charlie Plumbing' AND tenant_id=$TIDA;")
V4=$(sqlite3 "$DB" "SELECT id FROM vendors WHERE name='PB Delta Concrete' AND tenant_id=$TIDA;")
V5=$(sqlite3 "$DB" "SELECT id FROM vendors WHERE name='PB Echo Excavating' AND tenant_id=$TIDA;")
V6=$(sqlite3 "$DB" "SELECT id FROM vendors WHERE name='PB Foxtrot Framing' AND tenant_id=$TIDA;")
VB1=$(sqlite3 "$DB" "SELECT id FROM vendors WHERE name='PB Golf Mechanical' AND tenant_id=$TIDB;")

# Documents that make the compliance engine compute exactly the statuses seeded
# below: reviewed + far-future expiry → approved, unreviewed → review, no doc at
# all → hold. Seeding compliance_status too lets the DASHBOARD be asserted before
# any report is generated (the dashboard reads the stored rows); generating the
# report re-runs the engine, which must land on the same verdicts.
seedDoc() { # vendor client reviewed confidence — tenant comes from the vendor row
  sqlite3 "$DB" "
    INSERT INTO documents (vendor_id, client_id, document_type, file_path, original_filename, received_date, tenant_id)
      VALUES ($1, $2, 'General Liability', 'documents/pb-$1.pdf', 'pb-$1.pdf', datetime('now'), (SELECT tenant_id FROM vendors WHERE id=$1));
    INSERT INTO document_extractions (document_id, document_type, expiration_date, is_reviewed, ai_confidence_score)
      VALUES (last_insert_rowid(), 'General Liability', '2027-06-30', $3, $4);
  "
}
seedDoc "$V1" "$CA1" 1 0.95
seedDoc "$V3" "$CA1" 0 0.40     # unreviewed → review
seedDoc "$V4" "$CA1" 1 0.95
seedDoc "$V6" "$CA1" 1 0.95
seedDoc "$VB1" "$CB1" 1 0.95

seedStatus() { # vendor client status payment score label
  sqlite3 "$DB" "INSERT INTO compliance_status (vendor_id, client_id, status, payment_status, compliance_score, score_label)
    VALUES ($1, $2, '$3', '$4', $5, '$6');"
}
seedStatus "$V1" "$CA1" compliant approved 100 Good
# A required document that is absent shows as "expired" (see worstStatus) with a
# 0/Poor score — that is exactly what the engine persists, so the seeded rows the
# dashboard reads and the rows the report's recompute writes are identical.
seedStatus "$V2" "$CA1" expired hold 0 Poor
seedStatus "$V3" "$CA1" needs_review review 50 Fair
seedStatus "$V4" "$CA1" compliant approved 100 Good
seedStatus "$V5" "$CA2" expired hold 0 Poor
seedStatus "$V6" "$CA1" compliant approved 100 Good
seedStatus "$VB1" "$CB1" compliant approved 100 Good

sqlite3 "$DB" "
INSERT INTO projects (tenant_id, name) VALUES ($TIDA, 'Part B Maple St Remodel');
INSERT INTO projects (tenant_id, name) VALUES ($TIDA, 'Part B Oak Ave Warehouse');
INSERT INTO projects (tenant_id, name) VALUES ($TIDA, 'Part B Cedar Ct');
INSERT INTO projects (tenant_id, name) VALUES ($TIDA, 'Part B Empty Lot');
"
P1=$(sqlite3 "$DB" "SELECT id FROM projects WHERE name='Part B Maple St Remodel' AND tenant_id=$TIDA;")
P2=$(sqlite3 "$DB" "SELECT id FROM projects WHERE name='Part B Oak Ave Warehouse' AND tenant_id=$TIDA;")
P3=$(sqlite3 "$DB" "SELECT id FROM projects WHERE name='Part B Cedar Ct' AND tenant_id=$TIDA;")
P4=$(sqlite3 "$DB" "SELECT id FROM projects WHERE name='Part B Empty Lot' AND tenant_id=$TIDA;")

# V1 sits on TWO projects; V5 belongs to the OTHER client of the same tenant;
# V6 belongs to no project; P4 has no vendors at all.
sqlite3 "$DB" "
INSERT INTO vendor_projects (vendor_id, project_id) VALUES ($V1,$P1),($V2,$P1),($V5,$P1),($V1,$P2),($V3,$P2),($V4,$P3);
"
say "seeded tenantA=$TIDA (clients $CA1/$CA2) tenantB=$TIDB (client $CB1)"
say "vendors A: V1=$V1 V2=$V2 V3=$V3 V4=$V4 V5=$V5 V6=$V6 | B: VB1=$VB1"
say "projects A: P1=$P1 P2=$P2 P3=$P3 P4=$P4 (empty)"

# ── 2. Mint real JWTs with the app's own signer ──────────────────────────────
cat > "$TMPD/mint.ts" <<EOF
import { createAuthToken } from "$ROOT/src/middleware";
console.log(await createAuthToken({ user_id: Number(process.argv[2]), email: process.argv[3], full_name: "PB Smoke" }));
EOF
(cd "$ROOT" && bun run "$TMPD/mint.ts" "$UIDA" "pb-a-$SLUG@example.test" > "$TMPD/tokA.out" 2>&1)
(cd "$ROOT" && bun run "$TMPD/mint.ts" "$UIDB" "pb-b-$SLUG@example.test" > "$TMPD/tokB.out" 2>&1)
TOKA=$(tail -1 "$TMPD/tokA.out")
TOKB=$(tail -1 "$TMPD/tokB.out")
say "tokens: lenA=${#TOKA} lenB=${#TOKB}"

jqf() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)" 2>/dev/null; }

# Per-project reads of the dashboard payload (each is ONE python expression, so
# there is no shell-quoting gymnastics around multi-statement snippets).
pcounts() { python3 -c "
import json,sys
d=json.load(open('$TMPD/dashA.json'))
g=[p for p in d['projects'] if p['project_name']==sys.argv[1]][0]
print(g['vendor_count'], g['approved_count'], g['review_count'], g['hold_count'])
" "$1" 2>/dev/null; }
pclear() { python3 -c "
import json,sys
d=json.load(open('$TMPD/dashA.json'))
g=[p for p in d['projects'] if p['project_name']==sys.argv[1]][0]
print(g['all_clear'])
" "$1" 2>/dev/null; }
pvendors() { python3 -c "
import json,sys
d=json.load(open('$TMPD/dashA.json'))
g=[p for p in d['projects'] if p['project_name']==sys.argv[1]][0]
print(sorted(v['vendor_id'] for v in g['vendors']))
" "$1" 2>/dev/null; }
preasons() { python3 -c "
import json,sys
d=json.load(open('$TMPD/dashA.json'))
g=[p for p in d['projects'] if p['project_name']==sys.argv[1]][0]
print(all(bool(v.get('reason')) for v in g['vendors']))
" "$1" 2>/dev/null; }
ponprojects() { python3 -c "
import json,sys
d=json.load(open('$TMPD/dashA.json'))
print(sum(1 for p in d['projects'] if any(v['vendor_id']==int(sys.argv[1]) for v in p['vendors'])))
" "$1" 2>/dev/null; }

# ── 3. Dashboard "By project" ────────────────────────────────────────────────
echo "### dashboard /api/dashboard/clear-to-pay — per-project readiness"
curl -s -m 30 "$API/api/dashboard/clear-to-pay" -H "Authorization: Bearer $TOKA" -o "$TMPD/dashA.json"
cp "$TMPD/dashA.json" "$LOG.dashA.json"

check "dashboard projects length"    4      "$(jqf "len(d['projects'])" < "$TMPD/dashA.json")"
check "dashboard project order"      "['Part B Cedar Ct', 'Part B Empty Lot', 'Part B Maple St Remodel', 'Part B Oak Ave Warehouse']" "$(jqf "[p['project_name'] for p in d['projects']]" < "$TMPD/dashA.json")"
# Cedar Ct: one approved vendor → all clear
check "Cedar Ct count/approved"      "1 1 0 0"  "$(pcounts 'Part B Cedar Ct')"
check "Cedar Ct all_clear"           "True"    "$(pclear 'Part B Cedar Ct')"
check "Cedar Ct vendors listed"      "[$V4]"   "$(pvendors 'Part B Cedar Ct')"
# Maple St: V1 approved (client A1), V2 hold (A1), V5 hold (OTHER client A2)
check "Maple St counts (tenant-wide)" "3 1 0 2" "$(pcounts 'Part B Maple St Remodel')"
check "Maple St all_clear"           "False"   "$(pclear 'Part B Maple St Remodel')"
check "Maple St vendors listed"      "[$V1, $V2, $V5]" "$(pvendors 'Part B Maple St Remodel')"
check "Maple St vendor has reason"   "True"    "$(preasons 'Part B Maple St Remodel')"
# Oak Ave: V1 approved on two projects, V3 review
check "Oak Ave counts"               "2 1 1 0" "$(pcounts 'Part B Oak Ave Warehouse')"
check "vendor on two projects"       "2"       "$(ponprojects "$V1")"
# Empty project still appears (so the client sees it has no vendors yet)
check "empty project vendor_count"   "0 0 0 0" "$(pcounts 'Part B Empty Lot')"
check "empty project all_clear"      "False"   "$(pclear 'Part B Empty Lot')"
check "flat vendor list intact"      "6"       "$(jqf "len(d['vendors'])" < "$TMPD/dashA.json")"
check "unassigned_vendor_count"      "1"       "$(jqf "d['unassigned_vendor_count']" < "$TMPD/dashA.json")"

# Dashboard counts must equal GET /api/projects (same readiness query)
echo "### GET /api/projects consistency"
curl -s -m 30 "$API/api/projects" -H "Authorization: Bearer $TOKA" -o "$TMPD/projA.json"
check "projects endpoint matched"    "True"    "$(python3 -c "
import json
dash={p['project_name']:(p['vendor_count'],p['approved_count'],p['review_count'],p['hold_count'],p['all_clear']) for p in json.load(open('$TMPD/dashA.json'))['projects']}
lst={p['name']:(p['vendor_count'],p['approved_count'],p['review_count'],p['hold_count'],p['all_clear']) for p in json.load(open('$TMPD/projA.json'))}
print(dash==lst)")"

# Tenant B (no projects): the dashboard is the flat view it always was
echo "### tenant B dashboard is unchanged"
curl -s -m 30 "$API/api/dashboard/clear-to-pay" -H "Authorization: Bearer $TOKB" -o "$TMPD/dashB.json"
check "B projects empty"             "[]"      "$(jqf "d['projects']" < "$TMPD/dashB.json")"
check "B unassigned count"           "0"       "$(jqf "d['unassigned_vendor_count']" < "$TMPD/dashB.json")"
check "B flat vendors"               "1"       "$(jqf "len(d['vendors'])" < "$TMPD/dashB.json")"

# ── 4. Weekly report: PDF + XLSX for client A1 ───────────────────────────────
echo "### report for PB Client A1 (format=both + csv)"
genBoth() { # client token outf
  curl -s -m 90 -X POST "$API/api/reports/clear-to-pay" -H "Authorization: Bearer $2" \
    -H 'Content-Type: application/json' -d "{\"client_id\":$1,\"format\":\"both\"}" -o "$3"
}
genCsv() { # client token bodyfile headerfile
  curl -s -m 90 -D "$4" -X POST "$API/api/reports/clear-to-pay" -H "Authorization: Bearer $2" \
    -H 'Content-Type: application/json' -d "{\"client_id\":$1,\"format\":\"csv\"}" -o "$3"
}
dl() { # url token outfile
  curl -s -m 90 "$API$1" -H "Authorization: Bearer $2" -o "$3"
}
csvName() { grep -i '^content-disposition' "$1" | sed -E 's/.*filename="([^"]+)".*/\1/' | tr -d '\r'; }

genBoth "$CA1" "$TOKA" "$TMPD/ca1both.json"
PDFCA1=$(jqf "d['pdf_url']" < "$TMPD/ca1both.json")
XLSCA1=$(jqf "d['excel_url']" < "$TMPD/ca1both.json")
check "ca1 pdf_url present" "yes" "$([ -n "$PDFCA1" ] && [ "$PDFCA1" != "None" ] && echo yes || echo no)"; say "  ca1 urls: $PDFCA1 | $XLSCA1"
dl "$PDFCA1" "$TOKA" "$TMPD/ca1.pdf"
dl "$XLSCA1" "$TOKA" "$TMPD/ca1.xlsx"
genCsv "$CA1" "$TOKA" "$TMPD/ca1.csv" "$TMPD/ca1.csv.h"
CSVCA1=$(csvName "$TMPD/ca1.csv.h")
check "ca1 artifacts downloaded" "yes" "$([ -s "$TMPD/ca1.pdf" ] && [ -s "$TMPD/ca1.xlsx" ] && [ -s "$TMPD/ca1.csv" ] && [ -n "$CSVCA1" ] && echo yes || echo no)"; say "  ca1 csv=$(stat -c%s "$TMPD/ca1.csv")B pdf=$(stat -c%s "$TMPD/ca1.pdf")B xlsx=$(stat -c%s "$TMPD/ca1.xlsx")B name=$CSVCA1"

echo "### CSV carries the by-project block (client A1)"
grep -q '"By Project","Part B Cedar Ct","","","ALL CLEAR — 1 of 1 approved for payment"' "$TMPD/ca1.csv" \
  && say "PASS [csv cedar all-clear header]" || fail "csv cedar all-clear header" "$(grep -m2 'By Project' "$TMPD/ca1.csv")"
grep -q '"Project: Part B Maple St Remodel","PB Alpha Roofing"' "$TMPD/ca1.csv" \
  && say "PASS [csv maple vendor rows]" || fail "csv maple vendor rows" "no Project: rows"
grep -q '"By Project","Part B Oak Ave Warehouse","","","1 approved · 1 review"' "$TMPD/ca1.csv" \
  && say "PASS [csv oak readiness]" || fail "csv oak readiness" "$(grep -m1 'Oak Ave' "$TMPD/ca1.csv")"
grep -q '"By Project","(Not assigned to a project)","","","ALL CLEAR — 1 of 1 approved for payment"' "$TMPD/ca1.csv" \
  && say "PASS [csv unassigned group]" || fail "csv unassigned group" "$(grep -m1 'Not assigned' "$TMPD/ca1.csv")"
grep -q 'Part B Empty Lot' "$TMPD/ca1.csv" && fail "csv empty project listed" "empty project appears" || say "PASS [csv empty project omitted]"
grep -q 'PB Echo Excavating' "$TMPD/ca1.csv" && fail "csv cross-client leak" "client A2 vendor in client A1 report" || say "PASS [csv no cross-client vendor]"
grep -q '"Hold","PB Bravo Electric"' "$TMPD/ca1.csv" && say "PASS [csv flat rows intact]" || fail "csv flat rows intact" "missing flat hold row"
grep -q 'This report reflects documents on file' "$TMPD/ca1.csv" && say "PASS [csv disclaimer intact]" || fail "csv disclaimer intact" "missing"

echo "### XLSX has the By Project sheet (client A1)"
unzip -p "$TMPD/ca1.xlsx" xl/workbook.xml 2>/dev/null | grep -q 'name="By Project"' \
  && say "PASS [xlsx By Project sheet]" || fail "xlsx By Project sheet" "no sheet"
unzip -p "$TMPD/ca1.xlsx" xl/sharedStrings.xml 2>/dev/null | grep -q 'Part B Oak Ave Warehouse' \
  && say "PASS [xlsx project names]" || fail "xlsx project names" "missing"
unzip -p "$TMPD/ca1.xlsx" xl/sharedStrings.xml 2>/dev/null | grep -q 'All clear for payment (1 vendor)' \
  && say "PASS [xlsx all-clear readiness text]" || fail "xlsx all-clear readiness text" "missing"
unzip -p "$TMPD/ca1.xlsx" xl/sharedStrings.xml 2>/dev/null | grep -q 'PB Echo Excavating' \
  && fail "xlsx cross-client leak" "client A2 vendor in client A1 workbook" || say "PASS [xlsx no cross-client vendor]"
unzip -p "$TMPD/ca1.xlsx" xl/sharedStrings.xml 2>/dev/null | grep -q 'Part B Empty Lot' \
  && fail "xlsx empty project listed" "empty project appears" || say "PASS [xlsx empty project omitted]"

echo "### PDF carries section 7 by project (client A1)"
cat > "$TMPD/pdftext.mjs" <<'EOF'
const pdfjsLib = await import("/home/team/shared/clear-to-pay/api/node_modules/pdfjs-dist/legacy/build/pdf.mjs");
const data = new Uint8Array(await Bun.file(process.argv[2]).arrayBuffer());
const doc = await pdfjsLib.getDocument({ data, useSystemFonts: false, isEvalSupported: false,
  standardFontDataUrl: "/home/team/shared/clear-to-pay/api/node_modules/pdfjs-dist/standard_fonts/" }).promise;
let text = "";
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent();
  text += tc.items.map((it) => it.str).join(" ") + "\n";
}
console.log(`PDFPAGES=${doc.numPages}`);
await Bun.write(process.argv[3], text);
EOF
bun run "$TMPD/pdftext.mjs" "$TMPD/ca1.pdf" "$TMPD/ca1.txt" 2>/dev/null | tee -a "$LOG"
for needle in "7. By Project" "Part B Cedar Ct" "all clear for payment" "Part B Maple St Remodel" "Hold Payment" "PB Alpha Roofing"; do
  if grep -q "$needle" "$TMPD/ca1.txt"; then say "PASS [pdf has: $needle]"; else fail "pdf has: $needle" "$(head -c 300 "$TMPD/ca1.txt")"; fi
done
grep -q "PB Echo Excavating" "$TMPD/ca1.txt" && fail "pdf cross-client leak" "client A2 vendor in client A1 pdf" || say "PASS [pdf no cross-client vendor]"

# ── 5. Report for the OTHER client of the same tenant (shared project) ───────
echo "### report for PB Client A2 (shares Maple St with client A1)"
genCsv "$CA2" "$TOKA" "$TMPD/ca2.csv" "$TMPD/ca2.csv.h"
CSVCA2=$(csvName "$TMPD/ca2.csv.h")
check "ca2 csv section present" "1" "$(grep -c '^"By Project"' "$TMPD/ca2.csv")"
check "ca2 maple count is 1"  "1" "$(grep -m1 '"By Project","Part B Maple St Remodel"' "$TMPD/ca2.csv" | grep -c '"1 hold"')"
grep -q '"Project: Part B Maple St Remodel","PB Echo Excavating"' "$TMPD/ca2.csv" && say "PASS [ca2 own vendor listed]" || fail "ca2 own vendor listed" "missing"
grep -q 'PB Alpha Roofing' "$TMPD/ca2.csv" && fail "ca2 sees other client vendor" "client A1 vendor in client A2 report" || say "PASS [ca2 no other-client vendor]"
grep -q 'Not assigned to a project' "$TMPD/ca2.csv" && fail "ca2 spurious unassigned group" "unassigned group without any assigned vendor" || say "PASS [ca2 no unassigned group]"
say "  ca2 by-project rows: $(grep 'By Project' "$TMPD/ca2.csv" | head -3 | tr '\n' ' ')"

# ── 6. Control: tenant with NO projects keeps the old report exactly ─────────
echo "### control: tenant B (no projects) report is unchanged"
genBoth "$CB1" "$TOKB" "$TMPD/b1both.json"
PDFB=$(jqf "d['pdf_url']" < "$TMPD/b1both.json")
XLSB=$(jqf "d['excel_url']" < "$TMPD/b1both.json")
dl "$PDFB" "$TOKB" "$TMPD/b1.pdf"
dl "$XLSB" "$TOKB" "$TMPD/b1.xlsx"
genCsv "$CB1" "$TOKB" "$TMPD/b1.csv" "$TMPD/b1.csv.h"
CSVB=$(csvName "$TMPD/b1.csv.h")
grep -q 'By Project' "$TMPD/b1.csv" && fail "control csv has project block" "unexpected By Project rows" || say "PASS [control csv flat only]"
check "control csv flat row" "1" "$(grep -c '^"Approved","PB Golf Mechanical"' "$TMPD/b1.csv")"
unzip -p "$TMPD/b1.xlsx" xl/workbook.xml 2>/dev/null | grep -q 'name="By Project"' \
  && fail "control xlsx has sheet" "unexpected By Project sheet" || say "PASS [control xlsx has no By Project sheet]"
unzip -p "$TMPD/b1.xlsx" xl/sharedStrings.xml 2>/dev/null | grep -q 'This report reflects documents on file' \
  && say "PASS [control xlsx notice intact]" || fail "control xlsx notice intact" "missing"
bun run "$TMPD/pdftext.mjs" "$TMPD/b1.pdf" "$TMPD/b1.txt" 2>/dev/null | tee -a "$LOG"
grep -q "7. By Project" "$TMPD/b1.txt" && fail "control pdf section 7" "unexpected section 7" || say "PASS [control pdf has no section 7]"
for needle in "1. Approved for Payment This Week" "6. Needs Attention" "PB Golf Mechanical"; do
  if grep -q "$needle" "$TMPD/b1.txt"; then say "PASS [control pdf has: $needle]"; else fail "control pdf has: $needle" "$(head -c 200 "$TMPD/b1.txt")"; fi
done

# ── 7. Dashboard readiness survives the report's compliance recompute ────────
echo "### dashboard after report generation (compliance recomputed by the engine)"
curl -s -m 30 "$API/api/dashboard/clear-to-pay" -H "Authorization: Bearer $TOKA" -o "$TMPD/dashA2.json"
check "counts stable after recompute" "True" "$(python3 -c "
import json
a={p['project_name']:(p['vendor_count'],p['approved_count'],p['review_count'],p['hold_count'],p['all_clear']) for p in json.load(open('$TMPD/dashA.json'))['projects']}
b={p['project_name']:(p['vendor_count'],p['approved_count'],p['review_count'],p['hold_count'],p['all_clear']) for p in json.load(open('$TMPD/dashA2.json'))['projects']}
print(a==b)")"
check "engine agreed with seeded statuses" "True" "$(python3 -c "
import json
b={p['project_name']:(p['vendor_count'],p['approved_count'],p['review_count'],p['hold_count']) for p in json.load(open('$TMPD/dashA2.json'))['projects']}
want={'Part B Cedar Ct':(1,1,0,0),'Part B Empty Lot':(0,0,0,0),'Part B Maple St Remodel':(3,1,0,2),'Part B Oak Ave Warehouse':(2,1,1,0)}
print(b==want)")"

say "DB vendor_projects rows for A (expect 6): $(sqlite3 "$DB" "SELECT COUNT(*) FROM vendor_projects WHERE project_id IN ($P1,$P2,$P3,$P4);")"
say "DB projects for A (expect 4): $(sqlite3 "$DB" "SELECT COUNT(*) FROM projects WHERE tenant_id=$TIDA;")"

# ── 8. Cleanup: report objects, then every row ───────────────────────────────
echo "### cleanup (report objects + rows)"
PDFCA1K=$(printf '%b' "${PDFCA1//%/\\x}"); PDFCA1K=${PDFCA1K#/api/reports/download/}
XLSCA1K=$(printf '%b' "${XLSCA1//%/\\x}"); XLSCA1K=${XLSCA1K#/api/reports/download/}
PDFBK=$(printf '%b' "${PDFB//%/\\x}"); PDFBK=${PDFBK#/api/reports/download/}
XLSBK=$(printf '%b' "${XLSB//%/\\x}"); XLSBK=${XLSBK#/api/reports/download/}
cat > "$TMPD/rm.ts" <<EOF
import { storageDelete } from "$ROOT/src/storage";
const keys = [
  "reports/tenant-$TIDA/$PDFCA1K", "reports/tenant-$TIDA/$XLSCA1K", "reports/tenant-$TIDA/$CSVCA1",
  "reports/tenant-$TIDA/$CSVCA2",
  "reports/tenant-$TIDB/$PDFBK", "reports/tenant-$TIDB/$XLSBK", "reports/tenant-$TIDB/$CSVB",
];
for (const k of keys) {
  try { await storageDelete(k); console.log("deleted " + k); } catch (e) { console.log("skip " + k + ": " + (e as Error).message); }
}
EOF
(cd "$ROOT" && bun run "$TMPD/rm.ts" 2>&1 | tail -10) | tee -a "$LOG"

sqlite3 "$DB" "
DELETE FROM vendor_projects WHERE project_id IN ($P1,$P2,$P3,$P4) OR vendor_id IN ($V1,$V2,$V3,$V4,$V5,$V6,$VB1);
DELETE FROM projects WHERE tenant_id IN ($TIDA,$TIDB);
DELETE FROM audit_logs WHERE entity_type='project' AND entity_id IN ($P1,$P2,$P3,$P4);
DELETE FROM compliance_status WHERE vendor_id IN ($V1,$V2,$V3,$V4,$V5,$V6,$VB1);
DELETE FROM document_extractions WHERE document_id IN (SELECT id FROM documents WHERE tenant_id IN ($TIDA,$TIDB));
DELETE FROM documents WHERE tenant_id IN ($TIDA,$TIDB);
DELETE FROM vendors WHERE tenant_id IN ($TIDA,$TIDB);
DELETE FROM client_required_documents WHERE client_id IN ($CA1,$CA2,$CB1);
DELETE FROM clients WHERE tenant_id IN ($TIDA,$TIDB);
UPDATE users SET tenant_id = NULL WHERE id IN ($UIDA,$UIDB);
DELETE FROM tenants WHERE id IN ($TIDA,$TIDB);
DELETE FROM users WHERE id IN ($UIDA,$UIDB);
" >> "$LOG" 2>&1

say "CLEANUP tenants=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tenants WHERE id IN ($TIDA,$TIDB);") users=$(sqlite3 "$DB" "SELECT COUNT(*) FROM users WHERE id IN ($UIDA,$UIDB);") clients=$(sqlite3 "$DB" "SELECT COUNT(*) FROM clients WHERE id IN ($CA1,$CA2,$CB1);") vendors=$(sqlite3 "$DB" "SELECT COUNT(*) FROM vendors WHERE id IN ($V1,$V2,$V3,$V4,$V5,$V6,$VB1);") projects=$(sqlite3 "$DB" "SELECT COUNT(*) FROM projects WHERE id IN ($P1,$P2,$P3,$P4);") links=$(sqlite3 "$DB" "SELECT COUNT(*) FROM vendor_projects WHERE project_id IN ($P1,$P2,$P3,$P4);") docs=$(sqlite3 "$DB" "SELECT COUNT(*) FROM documents WHERE tenant_id IN ($TIDA,$TIDB);") compliance=$(sqlite3 "$DB" "SELECT COUNT(*) FROM compliance_status WHERE vendor_id IN ($V1,$V2,$V3,$V4,$V5,$V6,$VB1);")"
say "TOTAL_PROJECTS_TABLE=$(sqlite3 "$DB" "SELECT COUNT(*) FROM projects;")"
say "HEALTH_AFTER=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$API/api/health")"
say "RESULT: failures=$FAIL"
cp "$TMPD/ca1.csv" /tmp/pb-last-report.csv 2>/dev/null
cp "$TMPD/ca1.txt" /tmp/pb-last-report-pdftext.txt 2>/dev/null
rm -rf "$TMPD"
exit "$FAIL"
