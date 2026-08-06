#!/usr/bin/env bash
set -euo pipefail
API_URL="${API_URL:-http://localhost:3001}"
QUEUE_SECRET="${QUEUE_SECRET:-${INBOX_QUEUE_SECRET:-}}"
: "${QUEUE_SECRET:?Set QUEUE_SECRET}"
TOKEN=$(curl -sf "$API_URL/api/auth/login" -H 'Content-Type: application/json' -d '{"email":"quicktest@qa.com","password":"Quicktest123!"}' | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
ME=$(curl -sf "$API_URL/api/auth/me" -H "Authorization: Bearer $TOKEN")
SLUG=$(printf '%s' "$ME" | sed -n 's/.*"inbox_slug":"\([^"]*\)".*/\1/p')
BODY=$(printf 'fake coi pdf' | base64 -w0)
RES=$(curl -sf -X POST "$API_URL/api/inbox/receive" -H "X-Queue-Secret: $QUEUE_SECRET" -H 'Content-Type: application/json' -d "{\"to_address\":\"cleartopay-compliance-0d8d884b+$SLUG@ctomail.io\",\"from_address\":\"vendor@example.com\",\"attachments\":[{\"filename\":\"sample.pdf\",\"content_type\":\"application/pdf\",\"content_base64\":\"$BODY\"}]}" )
echo "$RES"
curl -sf "$API_URL/api/documents" -H "Authorization: Bearer $TOKEN" | grep -q sample.pdf
echo 'inbox receive test passed'
