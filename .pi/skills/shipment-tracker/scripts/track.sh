#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: track.sh [--lookup] <TRACKING_NUMBER>"
  echo "  --lookup   Only return the Veeqo ID (skip tracking events)"
  exit 1
}

LOOKUP_ONLY=false
if [[ "${1:-}" == "--lookup" ]]; then
  LOOKUP_ONLY=true
  shift
fi

TRACKING_NUMBER="${1:-}"
if [[ -z "$TRACKING_NUMBER" ]]; then
  usage
fi

if [[ -z "${AIRTABLE_API_KEY:-}" ]]; then
  echo "Error: AIRTABLE_API_KEY is not set" >&2
  exit 1
fi

if [[ "$LOOKUP_ONLY" == false && -z "${VEEQO_API_KEY:-}" ]]; then
  echo "Error: VEEQO_API_KEY is not set" >&2
  exit 1
fi

# URL-encode the filter formula
ENCODED_FORMULA=$(node -e "console.log(encodeURIComponent(\"{Tracking Number} = '${TRACKING_NUMBER}'\"))")

# Step 1: Look up Veeqo ID from Airtable
AIRTABLE_RESPONSE=$(curl -s -f \
  "https://api.airtable.com/v0/appUrgJo3JcB1UbfG/tblEPfiIJqdKRnUaV?filterByFormula=${ENCODED_FORMULA}" \
  -H "Authorization: Bearer ${AIRTABLE_API_KEY}" \
  -H "Content-Type: application/json")

# Extract Veeqo ID from response
VEEQO_ID=$(echo "$AIRTABLE_RESPONSE" | node -e "
  const data = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const records = data.records || [];
  if (records.length === 0) {
    console.error('No record found for tracking number: ${TRACKING_NUMBER}');
    process.exit(1);
  }
  const id = records[0].fields['Veeqo ID'];
  if (!id) {
    console.error('Veeqo ID field is empty for this record');
    process.exit(1);
  }
  console.log(id);
")

if [[ -z "$VEEQO_ID" ]]; then
  echo "Error: Could not extract Veeqo ID" >&2
  exit 1
fi

if [[ "$LOOKUP_ONLY" == true ]]; then
  echo "$VEEQO_ID"
  exit 0
fi

echo "Tracking Number: ${TRACKING_NUMBER}"
echo "Veeqo ID: ${VEEQO_ID}"
echo "---"

# Step 2: Fetch tracking events from Veeqo
curl -s -f -X GET \
  "https://api.veeqo.com/shipping/tracking_events/${VEEQO_ID}" \
  -H "x-api-key: ${VEEQO_API_KEY}" \
  -H "Content-Type: application/json"
