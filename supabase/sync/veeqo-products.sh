#!/usr/bin/env bash
set -euo pipefail

# ─── Veeqo → Supabase Product Sync ───────────────────────────────────
# Syncs all products, variants, kit components, and inventory levels
# from Veeqo into the Supabase source-of-truth database.
#
# Usage: ./veeqo-products.sh [--dry-run]
# ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

# ─── Credentials ─────────────────────────────────────────────────────
VEEQO_KEY="${VEEQO_API_KEY:-$(op item get "Veeqo API Credentials" --vault="Agents Service Accounts" --reveal --fields label=credential 2>/dev/null)}"
[[ -z "$VEEQO_KEY" ]] && { echo "Error: No Veeqo API key" >&2; exit 1; }

# Load Supabase creds from .env.local or env
if [[ -f "$SCRIPT_DIR/../.env.local" ]]; then
    source "$SCRIPT_DIR/../.env.local"
fi
SUPA_URL="${SUPABASE_API_URL:?Missing SUPABASE_API_URL}"
SUPA_KEY="${SUPABASE_SERVICE_ROLE_KEY:?Missing SUPABASE_SERVICE_ROLE_KEY}"

# ─── Helpers ─────────────────────────────────────────────────────────
STATS_PRODUCTS_CREATED=0
STATS_PRODUCTS_UPDATED=0
STATS_VARIANTS_CREATED=0
STATS_VARIANTS_UPDATED=0
STATS_KITS_CREATED=0
STATS_INVENTORY_UPSERTED=0
STATS_ERRORS=0

log() { echo "[$(date +%H:%M:%S)] $*"; }
err() { echo "[$(date +%H:%M:%S)] ERROR: $*" >&2; ((STATS_ERRORS++)); }

supa_get() {
    local path="$1"
    curl -s "${SUPA_URL}/rest/v1/${path}" \
        -H "apikey: ${SUPA_KEY}" \
        -H "Authorization: Bearer ${SUPA_KEY}"
}

supa_upsert() {
    local table="$1" data="$2" on_conflict="${3:-}"
    local extra_headers="-H 'Prefer: return=representation,resolution=merge-duplicates'"
    
    if $DRY_RUN; then
        log "[DRY RUN] Would upsert into ${table}: $(echo "$data" | jq -c '.' | head -c 200)"
        return 0
    fi
    
    local result
    result=$(curl -s -w "\n%{http_code}" "${SUPA_URL}/rest/v1/${table}" \
        -H "apikey: ${SUPA_KEY}" \
        -H "Authorization: Bearer ${SUPA_KEY}" \
        -H "Content-Type: application/json" \
        -H "Prefer: return=representation,resolution=merge-duplicates" \
        -d "$data")
    
    local http_code body
    http_code=$(echo "$result" | tail -1)
    body=$(echo "$result" | sed '$d')
    
    if [[ "$http_code" -ge 400 ]]; then
        err "HTTP ${http_code} upserting to ${table}: $(echo "$body" | jq -c '.' 2>/dev/null || echo "$body")"
        return 1
    fi
    echo "$body"
}

# Get warehouse ID from Supabase (we need it for inventory)
get_warehouse_id() {
    local veeqo_wh_id="$1"
    supa_get "warehouses?external_id=eq.${veeqo_wh_id}&select=id&limit=1" | jq -r '.[0].id // empty'
}

# ─── Fetch all Veeqo products ────────────────────────────────────────
fetch_all_veeqo_products() {
    local page=1 all_products="[]"
    while true; do
        log "Fetching Veeqo products page ${page}..."
        local batch
        batch=$(curl -s "https://api.veeqo.com/products?page_size=100&page=${page}" \
            -H "x-api-key: ${VEEQO_KEY}")
        
        local count
        count=$(echo "$batch" | jq 'length')
        all_products=$(echo "$all_products" "$batch" | jq -s '.[0] + .[1]')
        
        log "  Got ${count} products (total so far: $(echo "$all_products" | jq 'length'))"
        [[ "$count" -lt 100 ]] && break
        ((page++))
    done
    echo "$all_products"
}

# ─── Process a single Veeqo product ──────────────────────────────────
process_product() {
    local vp="$1"  # Veeqo product JSON
    
    local veeqo_id title description brand origin_country hs_code is_hazmat
    veeqo_id=$(echo "$vp" | jq -r '.id')
    title=$(echo "$vp" | jq -r '.title // empty')
    description=$(echo "$vp" | jq -r '.description // empty')
    brand=$(echo "$vp" | jq -r '.brand // empty')
    origin_country=$(echo "$vp" | jq -r '.origin_country // "US"')
    hs_code=$(echo "$vp" | jq -r '.hs_tariff_number // empty')
    main_image=$(echo "$vp" | jq -r '.main_image_src // empty')
    
    # Determine product type from sellables
    local has_kit
    has_kit=$(echo "$vp" | jq '[.sellables[]? | select(.type == "Kit")] | length')
    local product_type="standard"
    [[ "$has_kit" -gt 0 ]] && product_type="kit"
    
    # Check if product exists in Supabase
    local existing
    existing=$(supa_get "products?external_ids->>veeqo=eq.${veeqo_id}&select=id&limit=1" | jq -r '.[0].id // empty')
    
    # Build product JSON
    local product_data
    product_data=$(jq -n \
        --arg title "$title" \
        --arg desc "$description" \
        --arg brand "$brand" \
        --arg ptype "$product_type" \
        --arg origin "$origin_country" \
        --arg hs "$hs_code" \
        --arg img "$main_image" \
        --arg veeqo_id "$veeqo_id" \
        '{
            title: $title,
            description: (if $desc == "" then null else $desc end),
            brand: (if $brand == "" then null else $brand end),
            product_type: $ptype,
            origin_country: $origin,
            hs_tariff_code: (if $hs == "" then null else $hs end),
            main_image_url: (if $img == "" then null else $img end),
            external_ids: {veeqo: $veeqo_id}
        }')
    
    local product_id
    if [[ -n "$existing" ]]; then
        # Update existing
        product_data=$(echo "$product_data" | jq --arg id "$existing" '. + {id: $id}')
        product_id="$existing"
        ((STATS_PRODUCTS_UPDATED++))
    else
        ((STATS_PRODUCTS_CREATED++))
    fi
    
    local result
    result=$(supa_upsert "products" "$product_data") || return 1
    
    if [[ -z "$existing" ]]; then
        product_id=$(echo "$result" | jq -r '.[0].id // .[].id // empty' 2>/dev/null)
        [[ -z "$product_id" ]] && product_id=$(echo "$result" | jq -r '.id // empty' 2>/dev/null)
    fi
    
    [[ -z "$product_id" ]] && { err "No product ID for veeqo:${veeqo_id}"; return 1; }
    
    # Process each sellable (variant)
    echo "$vp" | jq -c '.sellables[]?' | while read -r vs; do
        process_variant "$product_id" "$vs" "$veeqo_id"
    done
}

# ─── Process a single variant/sellable ────────────────────────────────
process_variant() {
    local product_id="$1" vs="$2" product_veeqo_id="$3"
    
    local sku veeqo_variant_id vtype title price cost weight_g
    sku=$(echo "$vs" | jq -r '.sku_code // empty')
    [[ -z "$sku" ]] && return 0  # Skip variants with no SKU
    
    veeqo_variant_id=$(echo "$vs" | jq -r '.id')
    vtype=$(echo "$vs" | jq -r '.type // "ProductVariant"')
    title=$(echo "$vs" | jq -r '.sellable_title // empty')
    price=$(echo "$vs" | jq -r '.price // 0')
    cost=$(echo "$vs" | jq -r '.cost_price // 0')
    weight_g=$(echo "$vs" | jq -r '.weight_grams // 0')
    local upc=$(echo "$vs" | jq -r '.upc_code // empty')
    local customs_desc=$(echo "$vs" | jq -r '.customs_description // empty')
    local image_url=$(echo "$vs" | jq -r '.image_url // empty')
    local hs_code=$(echo "$vs" | jq -r '.hs_tariff_number // empty')
    local hazmat=$(echo "$vs" | jq -r '.hazmat // false')
    
    # Convert weight from grams to oz
    local weight_oz
    weight_oz=$(echo "$weight_g" | awk '{printf "%.2f", $1 / 28.3495}')
    
    # Get dimensions
    local length width height
    length=$(echo "$vs" | jq -r '.measurement_attributes.depth // empty')
    width=$(echo "$vs" | jq -r '.measurement_attributes.width // empty')
    height=$(echo "$vs" | jq -r '.measurement_attributes.height // empty')
    
    # Build variant JSON
    local variant_data
    variant_data=$(jq -n \
        --arg pid "$product_id" \
        --arg sku "$sku" \
        --arg title "$title" \
        --arg upc "$upc" \
        --arg price "$price" \
        --arg cost "$cost" \
        --arg weight "$weight_oz" \
        --arg length "${length:-}" \
        --arg width "${width:-}" \
        --arg height "${height:-}" \
        --arg customs "$customs_desc" \
        --arg img "$image_url" \
        --arg vid "$veeqo_variant_id" \
        '{
            product_id: $pid,
            sku: $sku,
            title: (if $title == "" then null else $title end),
            upc: (if $upc == "" then null else $upc end),
            price: ($price | tonumber),
            cost_price: ($cost | tonumber),
            weight_oz: ($weight | tonumber),
            length_in: (if $length == "" then null else ($length | tonumber) end),
            width_in: (if $width == "" then null else ($width | tonumber) end),
            height_in: (if $height == "" then null else ($height | tonumber) end),
            customs_description: (if $customs == "" then null else $customs end),
            external_ids: {veeqo: $vid}
        }')
    
    # Check if variant exists
    local existing_variant
    existing_variant=$(supa_get "product_variants?sku=eq.${sku}&select=id&limit=1" | jq -r '.[0].id // empty')
    
    if [[ -n "$existing_variant" ]]; then
        variant_data=$(echo "$variant_data" | jq --arg id "$existing_variant" '. + {id: $id}')
        ((STATS_VARIANTS_UPDATED++))
    else
        ((STATS_VARIANTS_CREATED++))
    fi
    
    local result
    result=$(supa_upsert "product_variants" "$variant_data") || return 1
    
    local variant_id
    if [[ -n "$existing_variant" ]]; then
        variant_id="$existing_variant"
    else
        variant_id=$(echo "$result" | jq -r '.[0].id // .[].id // empty' 2>/dev/null)
        [[ -z "$variant_id" ]] && variant_id=$(echo "$result" | jq -r '.id // empty' 2>/dev/null)
    fi
    
    [[ -z "$variant_id" ]] && { err "No variant ID for SKU ${sku}"; return 1; }
    
    # Process kit components if this is a Kit
    if [[ "$vtype" == "Kit" ]]; then
        echo "$vs" | jq -c '.contents[]?' | while read -r comp; do
            process_kit_component "$variant_id" "$comp"
        done
    fi
    
    # Process stock entries (inventory levels)
    echo "$vs" | jq -c '.stock_entries[]?' | while read -r se; do
        process_inventory "$variant_id" "$se"
    done
}

# ─── Process kit component ────────────────────────────────────────────
process_kit_component() {
    local kit_variant_id="$1" comp="$2"
    
    local comp_sku qty
    comp_sku=$(echo "$comp" | jq -r '.sku_code // empty')
    qty=$(echo "$comp" | jq -r '.quantity // 1')
    
    [[ -z "$comp_sku" ]] && return 0
    
    # Look up the component variant by SKU
    local comp_variant_id
    comp_variant_id=$(supa_get "product_variants?sku=eq.${comp_sku}&select=id&limit=1" | jq -r '.[0].id // empty')
    
    if [[ -z "$comp_variant_id" ]]; then
        # Component hasn't been synced yet — skip, will be linked on next run
        return 0
    fi
    
    local kit_data
    kit_data=$(jq -n \
        --arg kid "$kit_variant_id" \
        --arg cid "$comp_variant_id" \
        --argjson qty "$qty" \
        '{kit_variant_id: $kid, component_variant_id: $cid, quantity: $qty}')
    
    supa_upsert "kit_components" "$kit_data" >/dev/null 2>&1 && ((STATS_KITS_CREATED++)) || true
}

# ─── Process inventory stock entry ────────────────────────────────────
process_inventory() {
    local variant_id="$1" se="$2"
    
    local wh_veeqo_id physical allocated incoming
    wh_veeqo_id=$(echo "$se" | jq -r '.warehouse_id')
    physical=$(echo "$se" | jq -r '.physical_stock_level // 0')
    allocated=$(echo "$se" | jq -r '.allocated_stock_level // 0')
    incoming=$(echo "$se" | jq -r '.incoming_stock_level // 0')
    
    # Look up warehouse in Supabase
    local warehouse_id
    warehouse_id=$(get_warehouse_id "$wh_veeqo_id")
    [[ -z "$warehouse_id" ]] && { err "Unknown warehouse veeqo:${wh_veeqo_id}"; return 1; }
    
    # Check existing
    local existing
    existing=$(supa_get "inventory_levels?variant_id=eq.${variant_id}&warehouse_id=eq.${warehouse_id}&select=id&limit=1" | jq -r '.[0].id // empty')
    
    local inv_data
    inv_data=$(jq -n \
        --arg vid "$variant_id" \
        --arg wid "$warehouse_id" \
        --argjson phys "$physical" \
        --argjson alloc "$allocated" \
        --argjson inc "$incoming" \
        '{variant_id: $vid, warehouse_id: $wid, physical_qty: $phys, allocated_qty: $alloc, incoming_qty: $inc}')
    
    if [[ -n "$existing" ]]; then
        inv_data=$(echo "$inv_data" | jq --arg id "$existing" '. + {id: $id}')
    fi
    
    supa_upsert "inventory_levels" "$inv_data" >/dev/null 2>&1 && ((STATS_INVENTORY_UPSERTED++)) || true
}

# ─── Main ─────────────────────────────────────────────────────────────
main() {
    log "Starting Veeqo → Supabase product sync"
    $DRY_RUN && log "*** DRY RUN MODE — no writes ***"
    
    # Record import run
    local run_id=""
    if ! $DRY_RUN; then
        run_id=$(supa_upsert "import_runs" "$(jq -n '{source: "veeqo", job_name: "veeqo_products_sync", status: "running"}')" | jq -r '.[0].id // empty' 2>/dev/null)
    fi
    
    # Fetch all products
    local all_products
    all_products=$(fetch_all_veeqo_products)
    local total
    total=$(echo "$all_products" | jq 'length')
    log "Fetched ${total} products from Veeqo"
    
    # Process each product
    local i=0
    echo "$all_products" | jq -c '.[]' | while read -r vp; do
        ((i++)) || true
        local ptitle
        ptitle=$(echo "$vp" | jq -r '.title' | head -c 60)
        log "Processing [${i}/${total}] ${ptitle}"
        process_product "$vp" || true
    done
    
    # Print stats
    log "────────────────────────────────────"
    log "Sync complete!"
    log "  Products created: ${STATS_PRODUCTS_CREATED}"
    log "  Products updated: ${STATS_PRODUCTS_UPDATED}"
    log "  Variants created: ${STATS_VARIANTS_CREATED}"
    log "  Variants updated: ${STATS_VARIANTS_UPDATED}"
    log "  Kit links:        ${STATS_KITS_CREATED}"
    log "  Inventory rows:   ${STATS_INVENTORY_UPSERTED}"
    log "  Errors:           ${STATS_ERRORS}"
    
    # Update import run
    if [[ -n "$run_id" ]] && ! $DRY_RUN; then
        curl -s "${SUPA_URL}/rest/v1/import_runs?id=eq.${run_id}" \
            -X PATCH \
            -H "apikey: ${SUPA_KEY}" \
            -H "Authorization: Bearer ${SUPA_KEY}" \
            -H "Content-Type: application/json" \
            -d "$(jq -n \
                --argjson fetched "$total" \
                --argjson created "$STATS_PRODUCTS_CREATED" \
                --argjson updated "$STATS_PRODUCTS_UPDATED" \
                --argjson errors "$STATS_ERRORS" \
                '{status: "completed", completed_at: (now | todate), records_fetched: $fetched, records_created: $created, records_updated: $updated}')" \
            >/dev/null 2>&1
    fi
}

main "$@"
