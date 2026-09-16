#!/usr/bin/env bash
# Branded-inbox receive test (owner directive 2026-09-10): posts a document
# email TO documents@cleartopayconstruction.com (the shared inbox) and asserts
# it is routed to the right tenant by SENDER (a vendor contact_email).
set -euo pipefail
API_URL="${API_URL:-http://localhost:3001}"
QUEUE_SECRET="${QUEUE_SECRET:-${INBOX_QUEUE_SECRET:-}}"
: "${QUEUE_SECRET:?Set QUEUE_SECRET}"
TOKEN=$(curl -sf "$API_URL/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"quicktest@qa.com","password":"Quicktest123!"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
# The sender must match a vendor email in the tenant — create/ensure a client + vendor.
CLIENT_ID=$(curl -sf "$API_URL/api/clients" -H "Authorization: Bearer $TOKEN" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)
if [ -z "$CLIENT_ID" ]; then
  CLIENT_ID=$(curl -sf -X POST "$API_URL/api/clients" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"name":"Inbox Test Co"}' | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
fi
VENDOR_ID=$(curl -sf "$API_URL/api/vendors?client_id=$CLIENT_ID" -H "Authorization: Bearer $TOKEN" | sed -n 's/.*"id":\([0-9]*\).*/\1/p' | head -1)
if [ -z "$VENDOR_ID" ]; then
  VENDOR_ID=$(curl -sf -X POST "$API_URL/api/vendors" -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d "{\"client_id\":$CLIENT_ID,\"name\":\"Inbox Test Vendor\",\"contact_email\":\"vendor@example.com\"}" | sed -n 's/.*"id":\([0-9]*\).*/\1/p')
fi
BODY=$(printf 'fake coi pdf' | base64 -w0)
RES=$(curl -sf -X POST "$API_URL/api/inbox/receive" -H "X-Queue-Secret: $QUEUE_SECRET" -H 'Content-Type: application/json' -d "{\"to_address\":\"documents@cleartopayconstruction.com\",\"from_address\":\"vendor@example.com\",\"from_name\":\"Inbox Test Vendor\",\"attachments\":[{\"filename\":\"sample.pdf\",\"content_type\":\"application/pdf\",\"content_base64\":\"$BODY\"}]}" )
echo "$RES"
echo "$RES" | grep -q '"routed":true'
curl -sf "$API_URL/api/documents" -H "Authorization: Bearer $TOKEN" | grep -q sample.pdf
echo 'inbox receive test passed (sender-routed to shared branded inbox)'
