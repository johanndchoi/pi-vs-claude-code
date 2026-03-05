#!/usr/bin/env bash
set -euo pipefail

# ─── Config ───────────────────────────────────────────────────────────
BASE_URL="https://marketplace.walmartapis.com/v3"
TOKEN_CACHE="/tmp/.walmart_token_cache"

# ─── Helpers ──────────────────────────────────────────────────────────
die() { echo "Error: $*" >&2; exit 1; }

check_deps() {
  for cmd in curl jq op; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required"
  done
}

get_credentials() {
  WALMART_CLIENT_ID=$(op read "op://Agents Service Accounts/Walmart API Credentials/username" 2>/dev/null) \
    || die "Failed to read Walmart Client ID from 1Password"
  WALMART_CLIENT_SECRET=$(op read "op://Agents Service Accounts/Walmart API Credentials/credential" 2>/dev/null) \
    || die "Failed to read Walmart Client Secret from 1Password"
}

# ─── Auth Token ───────────────────────────────────────────────────────
get_access_token() {
  if [[ -f "$TOKEN_CACHE" ]]; then
    local cached_at now
    cached_at=$(jq -r '.cached_at' "$TOKEN_CACHE" 2>/dev/null || echo 0)
    now=$(date +%s)
    if (( now - cached_at < 800 )); then
      jq -r '.access_token' "$TOKEN_CACHE"
      return
    fi
  fi

  local auth_base64
  auth_base64=$(printf '%s:%s' "$WALMART_CLIENT_ID" "$WALMART_CLIENT_SECRET" | base64 | tr -d '\n')

  local response
  response=$(curl -s -X POST "${BASE_URL}/token" \
    -H "Authorization: Basic ${auth_base64}" \
    -H "Content-Type: application/x-www-form-urlencoded" \
    -H "Accept: application/json" \
    -H "WM_SVC.NAME: Walmart Marketplace" \
    -H "WM_QOS.CORRELATION_ID: $(uuidgen 2>/dev/null || date +%s)" \
    -d "grant_type=client_credentials")

  local token
  token=$(echo "$response" | jq -r '.access_token // empty')
  [[ -n "$token" ]] || die "Failed to get access token: $response"

  echo "$response" | jq --arg t "$(date +%s)" '{access_token, cached_at: ($t | tonumber)}' > "$TOKEN_CACHE"
  echo "$token"
}

# ─── API Call ─────────────────────────────────────────────────────────
correlation_id() {
  uuidgen 2>/dev/null || echo "corr-$(date +%s)-$$"
}

api_get() {
  local path="$1" query="${2:-}"
  local access_token
  access_token=$(get_access_token)

  local url="${BASE_URL}${path}"
  [[ -n "$query" ]] && url="${url}?${query}"

  local full_response http_code body
  full_response=$(curl -s -w "\n%{http_code}" -X GET "$url" \
    -H "WM_SEC.ACCESS_TOKEN: ${access_token}" \
    -H "WM_SVC.NAME: Walmart Marketplace" \
    -H "WM_QOS.CORRELATION_ID: $(correlation_id)" \
    -H "Accept: application/json" \
    -H "Content-Type: application/json")

  http_code=$(echo "$full_response" | tail -1)
  body=$(echo "$full_response" | sed '$d')

  if [[ "$http_code" -ge 400 ]]; then
    echo "HTTP $http_code error:" >&2
    echo "$body" | jq . 2>/dev/null || echo "$body" >&2
    return 1
  fi

  echo "$body"
}

api_get_accept() {
  local path="$1" query="${2:-}" accept="${3:-application/json}"
  local access_token
  access_token=$(get_access_token)

  local url="${BASE_URL}${path}"
  [[ -n "$query" ]] && url="${url}?${query}"

  local full_response http_code body
  full_response=$(curl -s -w "\n%{http_code}" -X GET "$url" \
    -H "WM_SEC.ACCESS_TOKEN: ${access_token}" \
    -H "WM_SVC.NAME: Walmart Marketplace" \
    -H "WM_QOS.CORRELATION_ID: $(correlation_id)" \
    -H "Accept: ${accept}" \
    -H "Content-Type: application/json")

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
  local path="$1" payload="${2:-}" content_type="${3:-application/json}"
  local access_token
  access_token=$(get_access_token)

  local full_response http_code body
  full_response=$(curl -s -w "\n%{http_code}" -X POST "${BASE_URL}${path}" \
    -H "WM_SEC.ACCESS_TOKEN: ${access_token}" \
    -H "WM_SVC.NAME: Walmart Marketplace" \
    -H "WM_QOS.CORRELATION_ID: $(correlation_id)" \
    -H "Accept: application/json" \
    -H "Content-Type: ${content_type}" \
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
  echo "Testing Walmart Marketplace API authentication..."
  local token
  token=$(get_access_token)
  echo "Access token obtained: ${token:0:20}..."
  echo "Endpoint: ${BASE_URL}"
  echo "Auth OK ✅"
}

# ── Orders ────────────────────────────────────────────────────────────

cmd_orders_list() {
  local since="${1:-7}"
  local since_date

  if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    since_date="${since}T00:00:00Z"
  else
    since_date=$(date -u -v-"${since}d" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
      || date -u -d "${since} days ago" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
      || date -u +"%Y-%m-%dT00:00:00Z")
  fi

  local query="createdStartDate=${since_date}&limit=200"
  api_get "/orders" "$query"
}

cmd_orders_released() {
  local since="${1:-7}"
  local since_date

  if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    since_date="${since}T00:00:00Z"
  else
    since_date=$(date -u -v-"${since}d" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
      || date -u -d "${since} days ago" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
      || date -u +"%Y-%m-%dT00:00:00Z")
  fi

  local query="createdStartDate=${since_date}&status=Created&limit=200"
  api_get "/orders/released" "$query"
}

cmd_orders_get() {
  local purchase_order_id="$1"
  [[ -n "$purchase_order_id" ]] || die "Usage: walmart.sh orders get <purchaseOrderId>"
  api_get "/orders/${purchase_order_id}" ""
}

cmd_orders_by_status() {
  local status="$1" since="${2:-30}"
  [[ -n "$status" ]] || die "Usage: walmart.sh orders status <status> [days-back|YYYY-MM-DD]"
  local since_date

  if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    since_date="${since}T00:00:00Z"
  else
    since_date=$(date -u -v-"${since}d" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
      || date -u -d "${since} days ago" +"%Y-%m-%dT00:00:00Z" 2>/dev/null \
      || date -u +"%Y-%m-%dT00:00:00Z")
  fi

  local query="createdStartDate=${since_date}&status=${status}&limit=200"
  api_get "/orders" "$query"
}

cmd_orders_all_2025() {
  echo "Fetching all orders for 2025..." >&2
  local start_date="2025-01-01T00:00:00Z"
  local end_date="2025-12-31T23:59:59Z"
  local all_orders="[]"
  local cursor=""
  local page=0

  while true; do
    page=$((page + 1))
    echo "  Fetching page ${page}..." >&2

    local query="createdStartDate=${start_date}&createdEndDate=${end_date}&limit=200"
    [[ -n "$cursor" ]] && query="${query}&nextCursor=${cursor}"

    local response
    response=$(api_get "/orders" "$query")

    local orders
    orders=$(echo "$response" | jq '.list.elements.order // []')
    local count
    count=$(echo "$orders" | jq 'length')
    echo "  Got ${count} orders on page ${page}" >&2

    all_orders=$(echo "$all_orders" "$orders" | jq -s '.[0] + .[1]')

    cursor=$(echo "$response" | jq -r '.list.meta.nextCursor // empty')
    [[ -n "$cursor" ]] || break
  done

  local total
  total=$(echo "$all_orders" | jq 'length')
  echo "Total orders fetched: ${total}" >&2
  echo "$all_orders"
}

cmd_orders_csv() {
  local year="${1:-2025}"
  local start_date="${year}-01-01T00:00:00Z"
  local end_date="${year}-12-31T23:59:59Z"
  local outfile="${2:-walmart_orders_${year}.csv}"

  echo "Fetching all orders for ${year} and exporting to CSV..." >&2

  local all_orders="[]"
  local cursor=""
  local page=0

  while true; do
    page=$((page + 1))
    echo "  Fetching page ${page}..." >&2

    local query="createdStartDate=${start_date}&createdEndDate=${end_date}&limit=200"
    [[ -n "$cursor" ]] && query="${query}&nextCursor=${cursor}"

    local response
    response=$(api_get "/orders" "$query")

    local orders
    orders=$(echo "$response" | jq '.list.elements.order // []')
    local count
    count=$(echo "$orders" | jq 'length')
    echo "  Got ${count} orders on page ${page}" >&2

    [[ "$count" -eq 0 ]] && break

    all_orders=$(echo "$all_orders" "$orders" | jq -s '.[0] + .[1]')

    cursor=$(echo "$response" | jq -r '.list.meta.nextCursor // empty')
    [[ -n "$cursor" ]] || break
  done

  local total
  total=$(echo "$all_orders" | jq 'length')
  echo "Total orders fetched: ${total}" >&2

  # Generate CSV
  echo "purchaseOrderId,customerOrderId,orderDate,status,customerName,estimatedDeliveryDate,estimatedShipDate,sku,productName,quantity,unitPrice,totalPrice" > "$outfile"

  echo "$all_orders" | jq -r '
    .[] |
    . as $order |
    (.orderLines.orderLine // [])[] |
    [
      ($order.purchaseOrderId // ""),
      ($order.customerOrderId // ""),
      ($order.orderDate // ""),
      (.orderLineStatuses.orderLineStatus[0].status // $order.shippingInfo.estimatedDeliveryDate // ""),
      (($order.shippingInfo.postalAddress.name // "") | gsub(","; " ")),
      ($order.shippingInfo.estimatedDeliveryDate // ""),
      ($order.shippingInfo.estimatedShipDate // ""),
      (.item.sku // ""),
      ((.item.productName // "") | gsub(","; " ") | gsub("\n"; " ")),
      (.orderLineQuantity.amount // ""),
      (.charges.charge[0].chargeAmount.amount // ""),
      (.charges.charge[0].chargeAmount.amount // "")
    ] | @csv
  ' >> "$outfile"

  echo "CSV exported to: ${outfile}" >&2
  echo "Rows: $(( $(wc -l < "$outfile") - 1 ))" >&2
  echo "$outfile"
}

# ── Items / Inventory ────────────────────────────────────────────────

cmd_items_list() {
  local limit="${1:-20}" offset="${2:-0}"
  api_get "/items" "limit=${limit}&offset=${offset}"
}

cmd_items_get() {
  local sku="$1"
  [[ -n "$sku" ]] || die "Usage: walmart.sh items get <sku>"
  api_get "/items/${sku}" ""
}

cmd_inventory_get() {
  local sku="$1"
  [[ -n "$sku" ]] || die "Usage: walmart.sh inventory get <sku>"
  api_get "/inventory" "sku=${sku}"
}

cmd_inventory_list() {
  local limit="${1:-50}" offset="${2:-0}"
  api_get "/inventories" "limit=${limit}&offset=${offset}"
}

# ── Returns ───────────────────────────────────────────────────────────

cmd_returns_list() {
  local since="${1:-7}"
  local since_date

  if [[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    since_date="${since}"
  else
    since_date=$(date -u -v-"${since}d" +"%Y-%m-%d" 2>/dev/null \
      || date -u -d "${since} days ago" +"%Y-%m-%d" 2>/dev/null \
      || date -u +"%Y-%m-%d")
  fi

  api_get "/returns" "returnCreationStartDate=${since_date}&limit=200"
}

cmd_returns_get() {
  local return_order_id="$1"
  [[ -n "$return_order_id" ]] || die "Usage: walmart.sh returns get <returnOrderId>"
  api_get "/returns/${return_order_id}" ""
}

# ── Reports ───────────────────────────────────────────────────────────

cmd_reports_available() {
  api_get "/reports/reportRequests" ""
}

cmd_reports_request() {
  local report_type="$1"
  [[ -n "$report_type" ]] || die "Usage: walmart.sh reports request <reportType>"
  local report_version="${2:-v1}"
  api_post "/reports/reportRequests" "{\"reportType\":\"${report_type}\",\"reportVersion\":\"${report_version}\"}"
}

cmd_reports_status() {
  local request_id="$1"
  [[ -n "$request_id" ]] || die "Usage: walmart.sh reports status <requestId>"
  api_get "/reports/reportRequests/${request_id}" ""
}

cmd_reports_download() {
  local request_id="$1"
  [[ -n "$request_id" ]] || die "Usage: walmart.sh reports download <requestId>"
  local outfile="${2:-walmart_report_${request_id}.csv}"

  local status_resp
  status_resp=$(api_get "/reports/reportRequests/${request_id}" "")
  local download_url
  download_url=$(echo "$status_resp" | jq -r '.downloadURL // .downloadUrl // empty')

  if [[ -n "$download_url" ]]; then
    curl -s -o "$outfile" "$download_url"
    echo "Downloaded report to: ${outfile}" >&2
    echo "$outfile"
  else
    echo "Report not ready or no download URL. Status:" >&2
    echo "$status_resp" | jq .
  fi
}

# ── Shipping / Tracking ──────────────────────────────────────────────

cmd_shipping_labels() {
  local purchase_order_id="$1"
  [[ -n "$purchase_order_id" ]] || die "Usage: walmart.sh shipping labels <purchaseOrderId>"
  api_get "/orders/${purchase_order_id}/shipping/labels" ""
}

# ─── Router ───────────────────────────────────────────────────────────
usage() {
  cat <<EOF
Usage: walmart.sh <command> <subcommand> [args]

Commands:
  auth test                                   Test authentication

  orders list [days-back|YYYY-MM-DD]          List recent orders (default: 7 days)
  orders released [days-back|YYYY-MM-DD]      Released/created orders
  orders get <purchaseOrderId>                Get order details
  orders status <status> [days-back|date]     Filter by status (Created|Acknowledged|Shipped|Delivered|Cancelled)
  orders all-2025                             Fetch all 2025 orders (JSON)
  orders csv [year] [output-file]             Export all orders for year to CSV

  items list [limit] [offset]                 List catalog items
  items get <sku>                             Get item by SKU

  inventory get <sku>                         Get inventory for SKU
  inventory list [limit] [offset]             List all inventory

  returns list [days-back|YYYY-MM-DD]         List returns
  returns get <returnOrderId>                 Get return details

  reports available                           List available reports
  reports request <reportType> [version]      Request a report
  reports status <requestId>                  Check report status
  reports download <requestId> [output-file]  Download completed report

  shipping labels <purchaseOrderId>           Get shipping labels
EOF
  exit 1
}

main() {
  check_deps
  get_credentials

  local cmd="${1:-}"
  local sub="${2:-}"
  shift 2 2>/dev/null || true

  # Handle --since flag
  local since_val=""
  local args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since) since_val="$2"; shift 2 ;;
      --since=*) since_val="${1#*=}"; shift ;;
      *) args+=("$1"); shift ;;
    esac
  done
  set -- "${args[@]+"${args[@]}"}"

  case "${cmd}:${sub}" in
    auth:test)            cmd_auth_test ;;
    orders:list)          cmd_orders_list "${since_val:-${1:-7}}" ;;
    orders:released)      cmd_orders_released "${since_val:-${1:-7}}" ;;
    orders:get)           cmd_orders_get "${1:-}" ;;
    orders:status)        cmd_orders_by_status "${1:-}" "${since_val:-${2:-30}}" ;;
    orders:all-2025)      cmd_orders_all_2025 ;;
    orders:csv)           cmd_orders_csv "${1:-2025}" "${2:-}" ;;
    items:list)           cmd_items_list "${1:-20}" "${2:-0}" ;;
    items:get)            cmd_items_get "${1:-}" ;;
    inventory:get)        cmd_inventory_get "${1:-}" ;;
    inventory:list)       cmd_inventory_list "${1:-50}" "${2:-0}" ;;
    returns:list)         cmd_returns_list "${since_val:-${1:-7}}" ;;
    returns:get)          cmd_returns_get "${1:-}" ;;
    reports:available)    cmd_reports_available ;;
    reports:request)      cmd_reports_request "${1:-}" "${2:-v1}" ;;
    reports:status)       cmd_reports_status "${1:-}" ;;
    reports:download)     cmd_reports_download "${1:-}" "${2:-}" ;;
    shipping:labels)      cmd_shipping_labels "${1:-}" ;;
    *)                    usage ;;
  esac
}

main "$@"
