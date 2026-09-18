#!/bin/bash
# Verify the weekly Clear-to-Pay report SURFACES coverage-enforcement issues in
# all generated artifacts (CSV text, XLSX cell, PDF text). Throwaway tenant via
# the sqlite3 CLI (never a 2nd bun:sqlite process), real JWT, live API, then
# delete every row + the generated report objects.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)          # .../clear-to-pay/api
DB="$ROOT/data/cleartopay.db"
API="${1:-http://localhost:3001}"
SLUG="CovRep$(date +%s)"
EMAIL="covrep-$SLUG@example.com"
NEEDLE="coverage 500,000 below required 1,000,000"
FAIL=0
TMPD=$(mktemp -d)

echo "### health"
[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$API/api/health")" = "200" ] || { echo "API not healthy"; exit 1; }

echo "### seed throwaway tenant (below-limit GL doc)"
sqlite3 "$DB" "INSERT INTO users (full_name,company_name,email,password_hash) VALUES ('CovRep','CovRep','$EMAIL','x');"
USER_ID=$(sqlite3 "$DB" "SELECT id FROM users WHERE email='$EMAIL';")
TID=$(sqlite3 "$DB" "INSERT INTO tenants (name,owner_user_id,inbox_slug,subscription_status) VALUES ('CovRep-$SLUG',$USER_ID,'$SLUG','TRIAL'); SELECT last_insert_rowid();")
sqlite3 "$DB" "UPDATE users SET tenant_id=$TID WHERE id=$USER_ID;"
CID=$(sqlite3 "$DB" "INSERT INTO clients (name,tenant_id) VALUES ('CovRep Client',$TID); SELECT last_insert_rowid();")
sqlite3 "$DB" "INSERT INTO client_required_documents (client_id,document_type,coverage_requirement) VALUES ($CID,'General Liability','1M');"
VID=$(sqlite3 "$DB" "INSERT INTO vendors (client_id,name,tenant_id) VALUES ($CID,'CovRep Vendor',$TID); SELECT last_insert_rowid();")
DID=$(sqlite3 "$DB" "INSERT INTO documents (vendor_id,client_id,document_type,file_path,original_filename,received_date,tenant_id) VALUES ($VID,$CID,'General Liability','documents/$TID/cov.pdf','cov.pdf',datetime('now'),$TID); SELECT last_insert_rowid();")
sqlite3 "$DB" "INSERT INTO document_extractions (document_id,expiration_date,is_reviewed,coverage_gl_occurrence,document_type) VALUES ($DID,'2027-06-30',1,500000,'General Liability');"
echo "user=$USER_ID tenant=$TID client=$CID vendor=$VID doc=$DID"

cat > "$TMPD/mint.ts" <<EOF
import { createAuthToken } from "$ROOT/src/middleware";
console.log(await createAuthToken({ user_id: Number(process.argv[2]), email: process.argv[3], full_name: "CovRep" }));
EOF
bun run "$TMPD/mint.ts" "$USER_ID" "$EMAIL" > "$TMPD/token.out" 2>&1
TOKEN=$(tail -1 "$TMPD/token.out")

echo "### generate reports (PDF + XLSX via format=both)"
curl -s -m 60 -X POST "$API/api/reports/clear-to-pay" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"client_id\":$CID,\"format\":\"both\"}" -o "$TMPD/gen.json"
PDF_URL=$(jq -r '.pdf_url' "$TMPD/gen.json")
XLS_URL=$(jq -r '.excel_url' "$TMPD/gen.json")
echo "summary: $(jq -c '{hold_count,review_count,missing_count}' "$TMPD/gen.json")"
echo "pdf_url=$PDF_URL"
echo "xls_url=$XLS_URL"
[ -n "$PDF_URL" ] && [ "$PDF_URL" != "null" ] || { echo "  FAIL no pdf_url"; FAIL=1; }

curl -s -m 60 "$API$PDF_URL" -H "Authorization: Bearer $TOKEN" -o "$TMPD/rep.pdf"
curl -s -m 60 "$API$XLS_URL" -H "Authorization: Bearer $TOKEN" -o "$TMPD/rep.xlsx"
curl -s -m 60 -X POST "$API/api/reports/clear-to-pay" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d "{\"client_id\":$CID,\"format\":\"csv\"}" -o "$TMPD/rep.csv"
echo "sizes: pdf=$(stat -c%s "$TMPD/rep.pdf") xlsx=$(stat -c%s "$TMPD/rep.xlsx") csv=$(stat -c%s "$TMPD/rep.csv")"

echo "### CSV carries the coverage reason"
if grep -q "below required 1,000,000" "$TMPD/rep.csv"; then echo "  OK csv contains 'below required 1,000,000'"; else echo "  FAIL csv missing coverage text"; FAIL=1; fi

echo "### XLSX Status cell carries the coverage text"
if unzip -p "$TMPD/rep.xlsx" xl/sharedStrings.xml 2>/dev/null | grep -q "$NEEDLE"; then echo "  OK xlsx contains '$NEEDLE'"; else echo "  FAIL xlsx missing '$NEEDLE'; saw: $(unzip -p "$TMPD/rep.xlsx" xl/sharedStrings.xml 2>/dev/null | tr '<' '\n' | grep -i "coverage" | head -3)"; FAIL=1; fi
if unzip -p "$TMPD/rep.xlsx" xl/sharedStrings.xml 2>/dev/null | grep -q "below_limit"; then echo "  FAIL raw 'below_limit' token leaked into the XLSX"; FAIL=1; else echo "  OK no raw 'below_limit' token in the XLSX"; fi

echo "### PDF text carries the coverage text (pdfjs text extraction)"
cat > "$TMPD/pdftext.ts" <<'EOF'
// Text extraction with the same pdfjs-dist legacy build the API already uses.
const pdfjsLib: any = await import(
  "/home/team/shared/clear-to-pay/api/node_modules/pdfjs-dist/legacy/build/pdf.mjs"
);
const data = new Uint8Array(await Bun.file(process.argv[2]!).arrayBuffer());
const needle = process.argv[3]!;
const doc = await pdfjsLib.getDocument({
  data,
  useSystemFonts: false,
  isEvalSupported: false,
  standardFontDataUrl: "/home/team/shared/clear-to-pay/api/node_modules/pdfjs-dist/standard_fonts/",
}).promise;
let text = "";
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const tc = await page.getTextContent();
  text += tc.items.map((it: any) => it.str).join(" ") + "\n";
}
console.log(`pages=${doc.numPages} textlen=${text.length}`);
console.log(text.includes(needle) ? "PDF_HAS_COVERAGE_TEXT=yes" : "PDF_HAS_COVERAGE_TEXT=no");
console.log(text.includes("below_limit") ? "PDF_HAS_RAW_TOKEN=yes" : "PDF_HAS_RAW_TOKEN=no");
if (!text.includes(needle)) console.log("text dump: " + JSON.stringify(text.slice(0, 900)));
EOF
bun run "$TMPD/pdftext.ts" "$TMPD/rep.pdf" "$NEEDLE" 2>/dev/null | tee "$TMPD/pdfscan.out"
grep -q "PDF_HAS_COVERAGE_TEXT=yes" "$TMPD/pdfscan.out" || { echo "  FAIL pdf missing coverage text"; FAIL=1; }
grep -q "PDF_HAS_RAW_TOKEN=no" "$TMPD/pdfscan.out" || { echo "  FAIL raw 'below_limit' token leaked into the PDF"; FAIL=1; }

echo "### cleanup (rows + generated report objects)"
PDF_KEY=$(jq -r '.pdf_url' "$TMPD/gen.json" | sed 's|/api/reports/download/||'); PDF_KEY=$(printf '%b' "${PDF_KEY//%/\\x}")
XLS_KEY=$(jq -r '.excel_url' "$TMPD/gen.json" | sed 's|/api/reports/download/||'); XLS_KEY=$(printf '%b' "${XLS_KEY//%/\\x}")
cat > "$TMPD/rm.ts" <<EOF
import { storageDelete } from "$ROOT/src/storage";
for (const k of ["reports/tenant-$TID/$PDF_KEY", "reports/tenant-$TID/$XLS_KEY"]) {
  try { await storageDelete(k); console.log("deleted " + k); } catch (e) { console.log("skip " + k + ": " + (e as Error).message); }
}
EOF
bun run "$TMPD/rm.ts" 2>&1 | tail -3
sqlite3 "$DB" "DELETE FROM compliance_status WHERE vendor_id=$VID;
DELETE FROM document_extractions WHERE document_id=$DID;
DELETE FROM documents WHERE tenant_id=$TID;
DELETE FROM vendors WHERE id=$VID;
DELETE FROM client_required_documents WHERE client_id=$CID;
DELETE FROM clients WHERE id=$CID;
DELETE FROM users WHERE id=$USER_ID;
DELETE FROM tenants WHERE id=$TID;"
echo "leftovers: tenant=$(sqlite3 "$DB" "SELECT COUNT(*) FROM tenants WHERE id=$TID;") user=$(sqlite3 "$DB" "SELECT COUNT(*) FROM users WHERE id=$USER_ID;") doc=$(sqlite3 "$DB" "SELECT COUNT(*) FROM documents WHERE tenant_id=$TID;")"
cp "$TMPD/rep.pdf" /tmp/covrep-last.pdf 2>/dev/null; cp "$TMPD/rep.xlsx" /tmp/covrep-last.xlsx 2>/dev/null
rm -rf "$TMPD"
echo "### RESULT FAIL=$FAIL"
exit "$FAIL"
