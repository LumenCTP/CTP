#!/usr/bin/env bash
# poll-inbox.sh — Run by agent-lead to check inbox and push to API
# Usage: bash poll-inbox.sh
#
# This script logs into the API, gets the queue secret, then
# prints instructions for the agent to use listMessages/readMessage
# and curl each new inbound email to /api/inbox/receive.
#
# Because the platform email tools (listMessages, readMessage) are
# agent-only and not available as CLI commands, the actual inbox
# checking must be done by the agent. This script just pre-fetches
# the credentials needed.

set -e

API_URL="${API_URL:-http://localhost:3001}"
QUEUE_SECRET="${QUEUE_SECRET:-}"

if [ -z "$QUEUE_SECRET" ]; then
  QUEUE_SECRET=$(cd "$(dirname "$0")" && bun -e "import { QUEUE_SECRET } from './src/secrets'; console.log(QUEUE_SECRET);" 2>/dev/null)
fi

echo "API:     $API_URL"
echo "Secret:  ${QUEUE_SECRET:0:8}..."
echo ""
echo "To process an email, POST to $API_URL/api/inbox/receive:"
echo ""
echo "curl -s -X POST $API_URL/api/inbox/receive \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'X-Queue-Secret: $QUEUE_SECRET' \\"
echo "  -d '{\"to_address\":\"<recipient>\",\"from_address\":\"<sender>\",\"from_name\":\"<name>\",\"subject\":\"<subj>\",\"body_text\":\"<body>\",\"attachments\":[{\"filename\":\"doc.pdf\",\"content_type\":\"application/pdf\",\"content_base64\":\"<base64>\"}]}'"
echo ""
echo "Done. Use listMessages to check for new inbound mail, then curl each one."
