#!/usr/bin/env bash
set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────
MARKETPLACE_ID="${SP_API_MARKETPLACE_ID:-ATVPDKIKX0DER}"
REGION="${SP_API_REGION:-us-east-1}"
TOKEN_CACHE="/tmp/.spapi_token_cache"

case "$REGION" in
  us-east-1)  HOST="sellingpartnerapi-na.amazon.com" ;;
  eu-west-1)  HOST="sellingpartnerapi-eu.amazon.com" ;;
  us-west-2)  HOST="sellingpartnerapi-fe.amazon.com" ;;
  *)          HOST="sellingpartnerapi-na.amazon.com" ;;
esac

# ─── Helpers ──────────────────────────────────────────────────────────
die() { echo "Error: $*" >&2; exit 1; }

check_deps() {
  for cmd in curl jq; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"
  done
}

check_env() {
  [[ -n "${SP_API_REFRESH_TOKEN:-}" ]] || die "SP_API_REFRESH_TOKEN not set"
  [[ -n "${SP_API_CLIENT_ID:-}" ]]     || die "SP_API_CLIENT_ID not set"
  [[ -n "${SP_API_CLIENT_SECRET:-}" ]] || die "SP_API_CLIENT_SECRET not set"
}

# ─── LWA Token ────────────────────────────────────────────────────────
get_access_token() {
  if [[ -f "$TOKEN_CACHE" ]]; then
    local cached_at now
    cached_at=$(jq -r '.cached_at' "$TOKEN_CACHE" 2>/dev/null || echo 0)
    now=$(date +%s)
    if (( now - cached_at < 3000 )); then
      jq -r '.access_token' "$TOKEN_CACHE"
      return
    fi
  fi

  local response
  response=$(curl -s -X POST https://api.amazon.com/auth/o2/token \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -d "grant_type=refresh_token" \
    -d "refresh_token=${SP_API_REFRESH_TOKEN}" \
    -d "client_id=${SP_API_CLIENT_ID}" \
    -d "client_secret=${SP_API_CLIENT_SECRET}")

  local token
  token=$(echo "$response" | jq -r '.access_token // empty')
  [[ -n "$token" ]] || die "Failed to get access token: $response"

  echo "$response" | jq --arg t "$(date +%s)" '{access_token, cached_at: ($t | tonumber)}' > "$TOKEN_CACHE"
  echo "$token"
}

# ─── API Call ─────────────────────────────────────────────────────────
api_get() {
  local path="$1" query="${2:-}"
  local access_token
  access_token=$(get_access_token)

  local url="https://${HOST}${path}"
  [[ -n "$query" ]] && url="${url}?${query}"

  local full_response http_code body
  full_response=$(curl -s -w "\n%{http_code}" -X GET "$url" \
    -H "x-amz-access-token: ${access_token}" \
    -H "Content-Type: application/json" \
    -H "User-Agent: OpenClawSPAPI/1.0")

  http_code=$(echo "$full_response" | tail -1)
  body=$(echo "$full_response" | sed '$d')

  if [[ "$http_code" -ge 400 ]]; then
    echo "HTTP $http_code error:" >&2
    echo "$body" | jq . 2>/dev/null || echo "$body" >&2
    return 1
  fi

  echo "$body"
}

api_post() {
  local path="$1" payload="${2:-}"
  local access_token
  access_token=$(get_access_token)

  local full_response http_code body
  full_response=$(curl -s -w "\n%{http_code}" -X POST "https://${HOST}${path}" \
    -H "x-amz-access-token: ${access_token}" \
    -H "Content-Type: application/json" \
    -H "User-Agent: OpenClawSPAPI/1.0" \
    -d "$payload")

  http_code=$(echo "$full_response" | tail -1)
  body=$(echo "$full_response" | sed '$d')

  if [[ "$http_code" -ge 400 ]]; then
    echo "HTTP $http_code error:" >&2
    echo "$body" | jq . 2>/dev/null || echo "$body" >&2
    return 1
  fi

  echo "$body"
}

# ─── Commands ─────────────────────────────────────────────────────────

cmd_auth_test() {
  echo "Testing SP-API authentication..."
  local token
  token=$(get_access_token)
  echo "Access token obtained: ${token:0:20}..."
  echo "Marketplace: $MARKETPLACE_ID"
  echo "Region: $REGION"
  echo "Endpoint: $HOST"
  echo "Auth OK"
}

cmd_orders_list() {
  local since="${1:-7}"
  local since_date

  if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    since_date="${since}T00:00:00Z"
  else
    since_date=$(date -u -d "${since} days ago" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
      || date -u -v-"${since}d" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
      || date -u +"%Y-%m-%dT00:00:00Z")
  fi

  local query="MarketplaceIds=${MARKETPLACE_ID}&LastUpdatedAfter=${since_date}&MaxResultsPerPage=50"
  api_get "/orders/v0/orders" "$query"
}

cmd_orders_pending() {
  local since_date
  since_date=$(date -u -d "30 days ago" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
    || date -u -v-30d +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
    || date -u +"%Y-%m-%dT00:00:00Z")

  local query="MarketplaceIds=${MARKETPLACE_ID}&LastUpdatedAfter=${since_date}&OrderStatuses=Unshipped,PartiallyShipped&MaxResultsPerPage=50"
  api_get "/orders/v0/orders" "$query"
}

cmd_orders_get() {
  local order_id="$1"
  [[ -n "$order_id" ]] || die "Usage: spapi.sh orders get <order-id>"
  api_get "/orders/v0/orders/${order_id}" ""
}

cmd_orders_items() {
  local order_id="$1"
  [[ -n "$order_id" ]] || die "Usage: spapi.sh orders items <order-id>"
  api_get "/orders/v0/orders/${order_id}/orderItems" ""
}

cmd_inventory_summary() {
  local query="granularityType=Marketplace&granularityId=${MARKETPLACE_ID}&marketplaceIds=${MARKETPLACE_ID}"
  api_get "/fba/inventory/v1/summaries" "$query"
}

cmd_inventory_check() {
  local sku="$1"
  [[ -n "$sku" ]] || die "Usage: spapi.sh inventory check <sku>"
  local query="granularityType=Marketplace&granularityId=${MARKETPLACE_ID}&marketplaceIds=${MARKETPLACE_ID}&sellerSkus=${sku}"
  api_get "/fba/inventory/v1/summaries" "$query"
}

cmd_inventory_low() {
  local result
  result=$(cmd_inventory_summary)
  echo "$result" | jq '[.payload.inventorySummaries[] | select(.inventoryDetails.fulfillableQuantity < 10)] | sort_by(.inventoryDetails.fulfillableQuantity)' 2>/dev/null || echo "$result"
}

cmd_catalog_search() {
  local query_text="$1"
  [[ -n "$query_text" ]] || die "Usage: spapi.sh catalog search <query>"
  local encoded
  encoded=$(node -e "console.log(encodeURIComponent('$query_text'))" 2>/dev/null \
    || python3 -c "import urllib.parse; print(urllib.parse.quote('$query_text'))")
  local query="keywords=${encoded}&marketplaceIds=${MARKETPLACE_ID}"
  api_get "/catalog/2022-04-01/items" "$query"
}

cmd_catalog_get() {
  local asin="$1"
  [[ -n "$asin" ]] || die "Usage: spapi.sh catalog get <asin>"
  local query="marketplaceIds=${MARKETPLACE_ID}&includedData=summaries,attributes,images,salesRanks"
  api_get "/catalog/2022-04-01/items/${asin}" "$query"
}

cmd_reports_create() {
  local report_type="$1"
  [[ -n "$report_type" ]] || die "Usage: spapi.sh reports create <report-type>"
  local payload
  payload=$(jq -n --arg rt "$report_type" --arg mp "$MARKETPLACE_ID" \
    '{reportType: $rt, marketplaceIds: [$mp]}')
  api_post "/reports/2021-06-30/reports" "$payload"
}

cmd_reports_status() {
  local report_id="$1"
  [[ -n "$report_id" ]] || die "Usage: spapi.sh reports status <report-id>"
  api_get "/reports/2021-06-30/reports/${report_id}" ""
}

cmd_reports_download() {
  local doc_id="$1"
  [[ -n "$doc_id" ]] || die "Usage: spapi.sh reports download <report-document-id>"
  local doc_info
  doc_info=$(api_get "/reports/2021-06-30/documents/${doc_id}" "")
  local url
  url=$(echo "$doc_info" | jq -r '.url // empty')
  [[ -n "$url" ]] || die "No download URL in response: $doc_info"
  curl -s "$url"
}

cmd_pricing_get() {
  local asin="$1"
  [[ -n "$asin" ]] || die "Usage: spapi.sh pricing get <asin>"
  local query="MarketplaceId=${MARKETPLACE_ID}&ItemType=Asin&Asins=${asin}"
  api_get "/products/pricing/v0/price" "$query"
}

# ─── Quick Order Lookup ──────────────────────────────────────────────
cmd_order() {
  local order_id="$1"
  [[ -n "$order_id" ]] || die "Usage: spapi.sh order <order-id>"
  echo "=== Order Details ==="
  cmd_orders_get "$order_id"
  echo ""
  echo "=== Order Items ==="
  cmd_orders_items "$order_id"
}

# ─── Router ───────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: spapi.sh <command> <subcommand> [args]

Commands:
  auth test                          Test authentication
  orders list [--since N|YYYY-MM-DD] List recent orders (default: 7 days)
  orders pending                     Show unshipped orders
  orders get <order-id>              Get order details
  orders items <order-id>            Get order line items
  inventory summary                  FBA inventory summary
  inventory check <sku>              Check specific SKU
  inventory low                      Show low stock items (<10 units)
  catalog search <query>             Search catalog
  catalog get <asin>                 Get ASIN details
  reports create <type>              Request a report
  reports status <report-id>         Check report status
  reports download <doc-id>          Download report document
  pricing get <asin>                 Get competitive pricing
EOF
  exit 1
}

main() {
  check_deps

  local cmd="${1:-}"
  local sub="${2:-}"
  shift 2 2>/dev/null || true

  local since_val=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since) since_val="$2"; shift 2 ;;
      --since=*) since_val="${1#*=}"; shift ;;
      *) break ;;
    esac
  done

  [[ "$cmd" == "auth" ]] || check_env

  case "${cmd}:${sub}" in
    auth:test)           cmd_auth_test ;;
    orders:list)         cmd_orders_list "${since_val:-7}" ;;
    orders:pending)      cmd_orders_pending ;;
    orders:get)          cmd_orders_get "${1:-}" ;;
    orders:items)        cmd_orders_items "${1:-}" ;;
    inventory:summary)   cmd_inventory_summary ;;
    inventory:check)     cmd_inventory_check "${1:-}" ;;
    inventory:low)       cmd_inventory_low ;;
    catalog:search)      cmd_catalog_search "$*" ;;
    catalog:get)         cmd_catalog_get "${1:-}" ;;
    reports:create)      cmd_reports_create "${1:-}" ;;
    reports:status)      cmd_reports_status "${1:-}" ;;
    reports:download)    cmd_reports_download "${1:-}" ;;
    pricing:get)         cmd_pricing_get "${1:-}" ;;
    order:*)             cmd_order "${sub:-${1:-}}" ;;
    *)                   usage ;;
  esac
}

main "$@"
