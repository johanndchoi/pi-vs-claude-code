#!/usr/bin/env python3
"""
Nexus Tax Analyzer — FBA Physical Nexus & Throwback Analysis

Connects your Amazon FBA inventory data with order data from multiple
platforms (Amazon, eBay, Walmart/ShipStation) to calculate the correct
California sales factor under R&TC §25135/§25122.

Usage:
    python3 nexus_analyzer.py --year 2025 \
        --fba-inventory "path/to/Fulfillment Report.csv" \
        --amazon-orders "path/to/Order Report*.txt" \
        --shipstation "path/to/ShipStation Data.csv" \
        --ebay "path/to/eBay Orders Report.csv" \
        --output report.md

All flags except --year are optional. Supply what you have.
"""

import argparse
import csv
import glob
import json
import os
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

# ─── Fulfillment Center → State Mapping ──────────────────────────────────────

FC_TO_STATE = {
    'ABE': 'PA', 'ABQ': 'NM', 'ACY': 'NJ', 'AFW': 'TX', 'AGS': 'GA',
    'AKC': 'OH', 'AMA': 'TX', 'ATL': 'GA', 'AUS': 'TX', 'AVP': 'PA',
    'BDL': 'CT', 'BFI': 'WA', 'BFL': 'CA', 'BHM': 'AL', 'BNA': 'TN',
    'BOI': 'ID', 'BOS': 'MA', 'BTR': 'LA', 'BWI': 'MD',
    'CAE': 'SC', 'CHA': 'TN', 'CHO': 'VA', 'CLE': 'OH', 'CLT': 'NC',
    'CMH': 'OH', 'CSG': 'GA', 'CVG': 'KY',
    'DAB': 'FL', 'DAL': 'TX', 'DCA': 'DC', 'DEN': 'CO', 'DET': 'MI',
    'DFW': 'TX', 'DSM': 'IA', 'DTW': 'MI',
    'ELP': 'TX', 'EWR': 'NJ', 'EUG': 'OR',
    'FAT': 'CA', 'FSD': 'SD', 'FTW': 'TX', 'FWA': 'IN',
    'GEG': 'WA', 'GRR': 'MI', 'GSO': 'NC', 'GSP': 'SC', 'GYR': 'AZ',
    'HGR': 'MD', 'HOU': 'TX', 'HSV': 'AL',
    'IAH': 'TX', 'ICT': 'KS', 'IGQ': 'IL', 'ILG': 'DE', 'IND': 'IN',
    'JAX': 'FL', 'JAN': 'MS', 'JFK': 'NY', 'JVL': 'WI',
    'KRB': 'CA',
    'LAS': 'NV', 'LAX': 'CA', 'LBE': 'PA', 'LEX': 'KY', 'LFT': 'LA',
    'LGA': 'NY', 'LGB': 'CA', 'LIT': 'AR', 'LUK': 'OH',
    'MCI': 'MO', 'MCO': 'FL', 'MDT': 'PA', 'MDW': 'IL', 'MEM': 'TN',
    'MGE': 'GA', 'MIA': 'FL', 'MKC': 'MO', 'MKE': 'WI', 'MLI': 'IL',
    'MQJ': 'IN', 'MQY': 'TN', 'MSP': 'MN', 'MSN': 'WI', 'MTN': 'MD',
    'OAK': 'CA', 'OKC': 'OK', 'OMA': 'NE', 'ONT': 'CA', 'ORD': 'IL',
    'ORF': 'VA', 'ORH': 'MA', 'OXR': 'CA',
    'PAE': 'WA', 'PBI': 'FL', 'PCA': 'FL', 'PCW': 'OH', 'PDX': 'OR',
    'PHL': 'PA', 'PHX': 'AZ', 'PIT': 'PA', 'POC': 'CA', 'PSP': 'CA',
    'PVD': 'RI',
    'RDG': 'PA', 'RDU': 'NC', 'RFD': 'IL', 'RIC': 'VA', 'ROC': 'NY',
    'RNO': 'NV',
    'SAN': 'CA', 'SAT': 'TX', 'SAV': 'GA', 'SAX': 'PA', 'SBD': 'CA',
    'SBN': 'IN', 'SCK': 'CA', 'SDF': 'KY', 'SHV': 'LA', 'SLC': 'UT',
    'SMF': 'CA', 'SNA': 'CA', 'STL': 'MO', 'SWF': 'NY', 'SYR': 'NY',
    'TEB': 'NJ', 'TEN': 'TN', 'TLH': 'FL', 'TPA': 'FL', 'TUL': 'OK',
    'TUS': 'AZ', 'TYS': 'TN',
    'VGT': 'NV',
    # Additional codes found in reports
    'DPA': 'PA', 'MIT': 'MA', 'PGA': 'FL', 'RMN': 'MN',
    'SDM': 'CA', 'XMD': 'MD', 'XPH': 'PA',
}

# US State codes (50 states + DC)
US_STATES = {
    'AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL',
    'IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE',
    'NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD',
    'TN','TX','UT','VT','VA','WA','WV','WI','WY'
}

STATE_NAMES = {
    'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas',
    'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut', 'DE': 'Delaware',
    'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii',
    'ID': 'Idaho', 'IL': 'Illinois', 'IN': 'Indiana', 'IA': 'Iowa',
    'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine',
    'MD': 'Maryland', 'MA': 'Massachusetts', 'MI': 'Michigan', 'MN': 'Minnesota',
    'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska',
    'NV': 'Nevada', 'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico',
    'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
    'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'RI': 'Rhode Island',
    'SC': 'South Carolina', 'SD': 'South Dakota', 'TN': 'Tennessee', 'TX': 'Texas',
    'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington',
    'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'
}


# ─── Data Structures ─────────────────────────────────────────────────────────

class NexusState:
    """Tracks FBA physical presence in a single state."""
    def __init__(self, state_code):
        self.state = state_code
        self.fcs = set()
        self.events = 0
        self.first_date = None
        self.last_date = None

    def add_event(self, fc_code, date_str):
        self.fcs.add(fc_code)
        self.events += 1
        if date_str:
            if self.first_date is None or date_str < self.first_date:
                self.first_date = date_str
            if self.last_date is None or date_str > self.last_date:
                self.last_date = date_str


class OrderData:
    """Aggregated order data by state and month."""
    def __init__(self):
        # state -> {platform -> {'orders': int, 'revenue': float}}
        self.by_state = defaultdict(lambda: defaultdict(lambda: {'orders': 0, 'revenue': 0.0}))
        # month -> {platform -> {'orders': int, 'revenue': float}}
        self.by_month = defaultdict(lambda: defaultdict(lambda: {'orders': 0, 'revenue': 0.0}))
        # Track order IDs for deduplication
        self.seen_orders = set()
        # platform -> total
        self.platform_totals = defaultdict(lambda: {'orders': 0, 'revenue': 0.0})

    def add_order(self, order_id, state, month, revenue, platform, is_fba=False):
        if order_id in self.seen_orders:
            return False
        self.seen_orders.add(order_id)

        key = f"{platform}_fba" if is_fba else platform
        self.by_state[state][key]['orders'] += 1
        self.by_state[state][key]['revenue'] += revenue
        self.by_month[month][key]['orders'] += 1
        self.by_month[month][key]['revenue'] += revenue
        self.platform_totals[key]['orders'] += 1
        self.platform_totals[key]['revenue'] += revenue
        return True

    def state_total(self, state):
        total = {'orders': 0, 'revenue': 0.0}
        for plat_data in self.by_state[state].values():
            total['orders'] += plat_data['orders']
            total['revenue'] += plat_data['revenue']
        return total

    def state_fbm_revenue(self, state):
        """Revenue from orders shipped FROM California (FBM/eBay/Walmart)."""
        rev = 0.0
        for key, data in self.by_state[state].items():
            if not key.endswith('_fba'):  # Everything except FBA
                rev += data['revenue']
        return rev

    def grand_total(self):
        total = {'orders': 0, 'revenue': 0.0}
        for state_data in self.by_state.values():
            for plat_data in state_data.values():
                total['orders'] += plat_data['orders']
                total['revenue'] += plat_data['revenue']
        return total


# ─── Parsers ──────────────────────────────────────────────────────────────────

def parse_fba_inventory(filepath, year):
    """Parse Amazon FBA Inventory Event Detail or Custom Tax Report FC CSV."""
    nexus = {}  # state -> NexusState
    unknown_fcs = set()

    with open(filepath, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        for row in reader:
            fc = (row.get('Fulfillment Center') or row.get('fulfillment-center-id') or '').strip()
            date = (row.get('Date') or row.get('snapshot-date') or row.get('date') or '').strip()

            if not fc or len(fc) < 3:
                continue

            # Extract airport code prefix (strip trailing digits)
            code = fc.rstrip('0123456789')
            state = FC_TO_STATE.get(code)

            if state is None:
                unknown_fcs.add(fc)
                continue

            if year and date:
                if not date.startswith(str(year)):
                    # Try MM/DD/YYYY format
                    parts = date.split('/')
                    if len(parts) == 3:
                        yr = parts[2] if len(parts[2]) == 4 else f"20{parts[2]}"
                        if yr != str(year):
                            continue
                    else:
                        continue

            if state not in nexus:
                nexus[state] = NexusState(state)
            nexus[state].add_event(fc, date)

    if unknown_fcs:
        print(f"  ⚠️  Unknown FCs (couldn't map to state): {', '.join(sorted(unknown_fcs))}")
        print(f"     Add these to FC_TO_STATE mapping if needed.")

    return nexus


def parse_amazon_orders(file_patterns, year):
    """Parse Amazon Order Report .txt files (tab-delimited)."""
    orders = OrderData()
    files_found = []

    for pattern in file_patterns:
        files_found.extend(glob.glob(pattern))

    if not files_found:
        return orders

    raw_orders = {}
    for fpath in files_found:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            reader = csv.DictReader(f, delimiter='\t')
            for row in reader:
                oid = (row.get('amazon-order-id') or '').strip()
                status = (row.get('order-status') or '').strip()
                date = (row.get('purchase-date') or '')[:7]

                if not oid or status == 'Cancelled':
                    continue
                if year and not date.startswith(str(year)):
                    continue
                if oid not in raw_orders:
                    raw_orders[oid] = row

    for oid, row in raw_orders.items():
        state = (row.get('ship-state') or '').strip().upper()
        channel = (row.get('fulfillment-channel') or '').strip()
        date = (row.get('purchase-date') or '')[:7]
        is_fba = channel == 'Amazon'

        try:
            price = float((row.get('item-price') or '').strip() or 0)
        except ValueError:
            price = 0.0

        if not state or len(state) > 2:
            continue

        orders.add_order(oid, state, date, price, 'amazon', is_fba=is_fba)

    print(f"  📦 Amazon: {len(files_found)} files → {len(raw_orders)} unique orders")
    return orders


def parse_shipstation(filepath, year):
    """Parse ShipStation CSV export (Walmart + Amazon FBM)."""
    orders = OrderData()

    with open(filepath, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        raw = {}
        for row in reader:
            oid = (row.get('Order #') or '').strip()
            if oid and oid not in raw:
                raw[oid] = row

    for oid, row in raw.items():
        state = (row.get('State') or '').strip().upper()
        date_str = (row.get('Order Date') or '').strip()

        try:
            rev = float((row.get('Order Total') or '').strip() or 0)
        except ValueError:
            rev = 0.0

        if not state or not date_str:
            continue

        parts = date_str.split('/')
        if len(parts) == 3:
            yr = parts[2] if len(parts[2]) == 4 else f"20{parts[2]}"
            month = f"{yr}-{parts[0].zfill(2)}"
        else:
            continue

        if year and not month.startswith(str(year)):
            continue

        # Detect platform from order number format
        if '-' in oid and len(oid) > 15:
            platform = 'amazon'  # Amazon FBM
        elif oid.startswith('200') and len(oid) > 12:
            platform = 'walmart'
        else:
            platform = 'other'

        orders.add_order(oid, state, month, rev, platform)

    print(f"  🏪 ShipStation: {len(raw)} unique orders")
    return orders


def parse_ebay(filepath, year):
    """Parse eBay Orders Report CSV."""
    orders = OrderData()

    MONTH_MAP = {
        'Jan': '01', 'Feb': '02', 'Mar': '03', 'Apr': '04',
        'May': '05', 'Jun': '06', 'Jul': '07', 'Aug': '08',
        'Sep': '09', 'Oct': '10', 'Nov': '11', 'Dec': '12'
    }

    with open(filepath, 'r', encoding='utf-8-sig') as f:
        all_rows = list(csv.reader(f))

    # Find headers row (82 columns with 'Sales Record Number')
    headers = None
    header_idx = None
    for i, row in enumerate(all_rows):
        if len(row) >= 40 and any('Sales Record Number' in str(c) for c in row):
            headers = row
            header_idx = i
            break

    if headers is None:
        print(f"  ⚠️  Could not find eBay headers in {filepath}")
        return orders

    eh = {name.strip(): idx for idx, name in enumerate(headers)}

    order_col = eh.get('Order Number')
    state_col = eh.get('Ship To State')
    rev_col = eh.get('Sold For')
    date_col = eh.get('Sale Date')

    if any(c is None for c in [order_col, state_col, rev_col, date_col]):
        print(f"  ⚠️  Missing expected columns in eBay file")
        return orders

    count = 0
    for row in all_rows[header_idx + 1:]:
        if len(row) < max(order_col, state_col, rev_col, date_col) + 1:
            continue
        if not row[0].strip():
            continue

        oid = f"ebay-{row[order_col].strip()}"
        state = row[state_col].strip().upper()

        try:
            rev = float(row[rev_col].strip().replace('$', '').replace(',', '') or 0)
        except ValueError:
            rev = 0.0

        date_parts = row[date_col].strip().split('-')
        if len(date_parts) == 3:
            mm = MONTH_MAP.get(date_parts[0], '??')
            yr = date_parts[2] if len(date_parts[2]) == 4 else f"20{date_parts[2]}"
            month = f"{yr}-{mm}"
        else:
            month = f"{year}-??"

        if year and not month.startswith(str(year)):
            continue
        if not state:
            continue

        if orders.add_order(oid, state, month, rev, 'ebay'):
            count += 1

    print(f"  🛒 eBay: {count} orders")
    return orders


# ─── Throwback Analysis ──────────────────────────────────────────────────────

def run_throwback_analysis(nexus_states, order_data, year, home_state='CA'):
    """
    Calculate correct CA sales factor vs. CPA's throwback-everything approach.

    Under R&TC §25135(a)(2)(B), sales shipped from CA to another state are
    thrown back to CA UNLESS the taxpayer is "taxable" in the destination state.

    Under R&TC §25122, "taxable" means subject to a net income tax, a franchise
    tax for doing business, or a corporate stock tax — REGARDLESS of whether
    the state actually imposes the tax.

    FBA inventory = physical nexus = "taxable" = throwback BLOCKED.
    """
    fba_nexus_set = set(nexus_states.keys())
    results = {
        'year': year,
        'home_state': home_state,
        'fba_nexus_states': sorted(fba_nexus_set),
        'fba_nexus_count': len(fba_nexus_set),
        'states': {},
        'totals': {},
    }

    grand = order_data.grand_total()
    ca_rev = order_data.state_total(home_state)['revenue']

    cpa_throwback = 0.0
    correct_throwback = 0.0

    for state in sorted(order_data.by_state.keys()):
        total = order_data.state_total(state)
        fbm_rev = order_data.state_fbm_revenue(state)
        has_nexus = state in fba_nexus_set

        if state == home_state:
            throwback_status = 'home'
        elif has_nexus:
            throwback_status = 'blocked'
            cpa_throwback += fbm_rev
        else:
            throwback_status = 'throwback'
            cpa_throwback += fbm_rev
            correct_throwback += fbm_rev

        results['states'][state] = {
            'orders': total['orders'],
            'revenue': total['revenue'],
            'fbm_revenue': fbm_rev,
            'has_fba_nexus': has_nexus,
            'throwback_status': throwback_status,
            'fcs': sorted(nexus_states[state].fcs) if state in nexus_states else [],
        }

    cpa_ca_income = ca_rev + cpa_throwback
    correct_ca_income = ca_rev + correct_throwback
    overattributed = cpa_throwback - correct_throwback

    results['totals'] = {
        'grand_total_revenue': grand['revenue'],
        'grand_total_orders': grand['orders'],
        'ca_instate_revenue': ca_rev,
        'oos_fbm_revenue': cpa_throwback,
        'cpa_throwback': cpa_throwback,
        'correct_throwback': correct_throwback,
        'overattributed': overattributed,
        'cpa_ca_factor': cpa_ca_income / grand['revenue'] * 100 if grand['revenue'] else 0,
        'correct_ca_factor': correct_ca_income / grand['revenue'] * 100 if grand['revenue'] else 0,
    }

    return results


# ─── Report Generation ────────────────────────────────────────────────────────

def generate_report(nexus_states, order_data, analysis, year):
    """Generate a Markdown report."""
    t = analysis['totals']
    lines = []
    a = lines.append

    a(f"# Nexus Tax Analysis — {year}")
    a(f"")
    a(f"> Generated {datetime.now().strftime('%Y-%m-%d %H:%M')} by nexus_analyzer.py")
    a(f"> California R&TC §25135(a)(2) / §25122 throwback analysis")
    a(f"")

    # ── FBA Inventory Summary ──
    a(f"## FBA Physical Nexus — {len(nexus_states)} States")
    a(f"")
    a(f"Your FBA inventory was stored in **{len(nexus_states)} states** during {year}.")
    a(f"Each state with inventory = physical nexus = \"taxable\" under R&TC §25122 = throwback BLOCKED.")
    a(f"")
    a(f"| State | Name | FCs | Events | First Date | Last Date |")
    a(f"|-------|------|-----|--------|------------|-----------|")
    for state in sorted(nexus_states.keys()):
        ns = nexus_states[state]
        name = STATE_NAMES.get(state, state)
        a(f"| {state} | {name} | {len(ns.fcs)} | {ns.events:,} | {ns.first_date or 'N/A'} | {ns.last_date or 'N/A'} |")
    a(f"")

    # ── Platform Summary ──
    a(f"## Order Summary by Platform")
    a(f"")
    plat_labels = {
        'amazon_fba': 'Amazon FBA',
        'amazon': 'Amazon FBM',
        'walmart': 'Walmart',
        'ebay': 'eBay',
        'other': 'Other',
    }
    a(f"| Platform | Orders | Revenue | % of Total |")
    a(f"|----------|--------|---------|-----------|")
    gt = order_data.grand_total()
    for key in ['amazon_fba', 'amazon', 'walmart', 'ebay', 'other']:
        pd = order_data.platform_totals.get(key, {'orders': 0, 'revenue': 0.0})
        if pd['orders'] == 0:
            continue
        pct = pd['revenue'] / gt['revenue'] * 100 if gt['revenue'] else 0
        a(f"| {plat_labels.get(key, key)} | {pd['orders']:,} | ${pd['revenue']:,.2f} | {pct:.1f}% |")
    a(f"| **TOTAL** | **{gt['orders']:,}** | **${gt['revenue']:,.2f}** | **100%** |")
    a(f"")

    # ── Monthly Breakdown ──
    a(f"## Monthly Revenue")
    a(f"")
    months = sorted(m for m in order_data.by_month.keys() if m.startswith(str(year)))
    plat_keys = [k for k in ['amazon_fba', 'amazon', 'walmart', 'ebay', 'other']
                 if order_data.platform_totals.get(k, {}).get('orders', 0) > 0]
    header_parts = ['Month'] + [plat_labels.get(k, k) for k in plat_keys] + ['Total Orders', 'Total Revenue']
    a(f"| {' | '.join(header_parts)} |")
    a(f"| {' | '.join(['---'] * len(header_parts))} |")

    for month in months:
        parts = [month]
        month_total_orders = 0
        month_total_rev = 0.0
        for key in plat_keys:
            md = order_data.by_month[month].get(key, {'orders': 0, 'revenue': 0.0})
            parts.append(f"{md['orders']:,}")
            month_total_orders += md['orders']
            month_total_rev += md['revenue']
        parts.append(f"{month_total_orders:,}")
        parts.append(f"${month_total_rev:,.2f}")
        a(f"| {' | '.join(parts)} |")
    a(f"")

    # ── State-by-State Throwback ──
    a(f"## Throwback Analysis by State")
    a(f"")
    a(f"| State | Orders | Revenue | From CA | FBA Nexus | Throwback |")
    a(f"|-------|--------|---------|---------|-----------|-----------|")

    for state, sd in sorted(analysis['states'].items(), key=lambda x: -x[1]['revenue']):
        nexus_icon = '✅' if sd['has_fba_nexus'] else '❌'
        if sd['throwback_status'] == 'home':
            tb = 'home'
        elif sd['throwback_status'] == 'blocked':
            tb = '❌ BLOCKED'
        else:
            tb = '⚠️ YES'
        a(f"| {state} | {sd['orders']:,} | ${sd['revenue']:,.2f} | ${sd['fbm_revenue']:,.2f} | {nexus_icon} | {tb} |")
    a(f"")

    # ── THE NUMBER ──
    a(f"## 🔴 THROWBACK SUMMARY — {year}")
    a(f"")
    a(f"| Metric | Amount |")
    a(f"|--------|--------|")
    a(f"| **Total {year} revenue (all platforms)** | **${t['grand_total_revenue']:,.2f}** |")
    a(f"| California in-state sales | ${t['ca_instate_revenue']:,.2f} |")
    a(f"| Out-of-state shipped from CA | ${t['oos_fbm_revenue']:,.2f} |")
    a(f"| | |")
    a(f"| **CPA throws back ALL of it** | **${t['cpa_throwback']:,.2f}** |")
    a(f"| **Correct throwback (no nexus only)** | **${t['correct_throwback']:,.2f}** |")
    a(f"| **OVERATTRIBUTED TO CALIFORNIA** | **${t['overattributed']:,.2f}** |")
    a(f"| | |")
    a(f"| **CPA's CA sales factor** | **{t['cpa_ca_factor']:.1f}%** |")
    a(f"| **Correct CA sales factor** | **{t['correct_ca_factor']:.1f}%** |")
    a(f"")

    # ── Tax Impact ──
    a(f"## Estimated Tax Impact")
    a(f"")
    a(f"| Net Income | CPA → CA | CA Tax (CPA) | Correct → CA | CA Tax (Correct) | **Overpayment** |")
    a(f"|-----------|----------|-------------|-------------|-----------------|----------------|")
    for net in [100000, 150000, 200000]:
        cpa_ca = net * t['cpa_ca_factor'] / 100
        cor_ca = net * t['correct_ca_factor'] / 100
        # Simplified CA tax estimate (married filing jointly brackets, approximate)
        cpa_tax = estimate_ca_tax(cpa_ca)
        cor_tax = estimate_ca_tax(cor_ca)
        overpay = cpa_tax - cor_tax
        a(f"| ${net:,} | ${cpa_ca:,.0f} | ${cpa_tax:,.0f} | ${cor_ca:,.0f} | ${cor_tax:,.0f} | **${overpay:,.0f}** |")
    a(f"")

    # ── Legal Citations ──
    a(f"## Legal Basis")
    a(f"")
    a(f"- **CA R&TC §25135(a)(2)(B)** — Throwback rule: sales from CA shipped to another state are assigned to CA if the taxpayer is not \"taxable\" in the destination state")
    a(f"- **CA R&TC §25122** — \"Taxable\" means subject to a net income tax, a franchise tax for the privilege of doing business, or a corporate stock tax")
    a(f"- **CA R&TC §25122(b)** — \"Regardless of whether, in fact, the state does or does not\" impose the tax")
    a(f"- **TX Tax Code §171.001** — Texas franchise tax is a \"franchise tax for the privilege of doing business\" — satisfies §25122(a)")
    a(f"- Physical presence of inventory (FBA) = nexus = \"taxable\" in that state = throwback BLOCKED")
    a(f"")

    return '\n'.join(lines)


def estimate_ca_tax(taxable_income):
    """Rough CA income tax estimate (single filer 2024 brackets, simplified)."""
    brackets = [
        (10412, 0.01), (24684, 0.02), (38959, 0.04), (54081, 0.06),
        (68350, 0.08), (349137, 0.093), (418961, 0.103), (698271, 0.113),
        (float('inf'), 0.123)
    ]
    tax = 0.0
    prev = 0
    for ceiling, rate in brackets:
        if taxable_income <= prev:
            break
        taxable_in_bracket = min(taxable_income, ceiling) - prev
        tax += taxable_in_bracket * rate
        prev = ceiling
    return tax


# ─── CLI ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='Nexus Tax Analyzer — FBA Physical Nexus & CA Throwback Analysis',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Full analysis with all data sources
  python3 nexus_analyzer.py --year 2025 \\
    --fba-inventory "~/Downloads/Fulfillment Report.csv" \\
    --amazon-orders "~/Downloads/Order Report*.txt" \\
    --shipstation "~/Downloads/ShipStation Data.csv" \\
    --ebay "~/Downloads/eBay Orders Report.csv"

  # Just FBA inventory + ShipStation
  python3 nexus_analyzer.py --year 2024 \\
    --fba-inventory "~/Downloads/Amazon Custom Tax Report.csv" \\
    --shipstation "~/Downloads/ShipStation Data (4).csv"
        """
    )
    parser.add_argument('--year', type=int, required=True, help='Tax year to analyze')
    parser.add_argument('--fba-inventory', type=str, help='Amazon FBA inventory/FC report CSV')
    parser.add_argument('--amazon-orders', type=str, nargs='+', help='Amazon Order Report .txt files (glob patterns OK)')
    parser.add_argument('--shipstation', type=str, help='ShipStation export CSV')
    parser.add_argument('--ebay', type=str, help='eBay Orders Report CSV')
    parser.add_argument('--output', type=str, help='Output file path (default: stdout + .md file)')
    parser.add_argument('--json', type=str, help='Also save raw analysis data as JSON')
    parser.add_argument('--home-state', type=str, default='CA', help='Home state (default: CA)')

    args = parser.parse_args()
    year = args.year

    print(f"\n{'='*70}")
    print(f"  NEXUS TAX ANALYZER — {year}")
    print(f"  CA R&TC §25135/§25122 Throwback Analysis")
    print(f"{'='*70}\n")

    # ── Parse FBA Inventory ──
    nexus_states = {}
    if args.fba_inventory:
        path = os.path.expanduser(args.fba_inventory)
        print(f"📋 Parsing FBA inventory: {path}")
        nexus_states = parse_fba_inventory(path, year)
        print(f"  ✅ Found inventory in {len(nexus_states)} states\n")
    else:
        print("⚠️  No FBA inventory file provided — throwback analysis will assume NO physical nexus")
        print("   (All out-of-state FBM sales will be thrown back to CA)\n")

    # ── Parse Orders ──
    order_data = OrderData()

    if args.amazon_orders:
        patterns = []
        for p in args.amazon_orders:
            patterns.append(os.path.expanduser(p))
        print(f"📋 Parsing Amazon orders...")
        amazon_data = parse_amazon_orders(patterns, year)
        # Merge into main order_data
        for oid in amazon_data.seen_orders:
            pass  # We need to re-parse to merge... let's restructure
        # Actually, let's just re-parse directly into the main order_data
        order_data = amazon_data

    if args.shipstation:
        path = os.path.expanduser(args.shipstation)
        print(f"📋 Parsing ShipStation: {path}")
        ss_data = parse_shipstation(path, year)

        # Merge, skipping duplicates
        merged = 0
        for state, platforms in ss_data.by_state.items():
            for plat, data in platforms.items():
                # We can't perfectly deduplicate line-by-line after aggregation,
                # but ShipStation order IDs were already deduped, and we checked
                # for zero overlap between platforms
                order_data.by_state[state][plat]['orders'] += data['orders']
                order_data.by_state[state][plat]['revenue'] += data['revenue']
                merged += data['orders']
        for month, platforms in ss_data.by_month.items():
            for plat, data in platforms.items():
                order_data.by_month[month][plat]['orders'] += data['orders']
                order_data.by_month[month][plat]['revenue'] += data['revenue']
        for plat, data in ss_data.platform_totals.items():
            order_data.platform_totals[plat]['orders'] += data['orders']
            order_data.platform_totals[plat]['revenue'] += data['revenue']
        order_data.seen_orders.update(ss_data.seen_orders)
        print(f"  ✅ Merged {merged} orders\n")

    if args.ebay:
        path = os.path.expanduser(args.ebay)
        print(f"📋 Parsing eBay: {path}")
        ebay_data = parse_ebay(path, year)

        # Merge
        merged = 0
        for state, platforms in ebay_data.by_state.items():
            for plat, data in platforms.items():
                order_data.by_state[state][plat]['orders'] += data['orders']
                order_data.by_state[state][plat]['revenue'] += data['revenue']
                merged += data['orders']
        for month, platforms in ebay_data.by_month.items():
            for plat, data in platforms.items():
                order_data.by_month[month][plat]['orders'] += data['orders']
                order_data.by_month[month][plat]['revenue'] += data['revenue']
        for plat, data in ebay_data.platform_totals.items():
            order_data.platform_totals[plat]['orders'] += data['orders']
            order_data.platform_totals[plat]['revenue'] += data['revenue']
        order_data.seen_orders.update(ebay_data.seen_orders)
        print(f"  ✅ Merged {merged} orders\n")

    # ── Run Analysis ──
    gt = order_data.grand_total()
    if gt['orders'] == 0:
        print("❌ No order data found. Check your file paths and year filter.")
        sys.exit(1)

    print(f"{'='*70}")
    print(f"  RUNNING THROWBACK ANALYSIS")
    print(f"  {gt['orders']:,} orders | ${gt['revenue']:,.2f} revenue | {len(nexus_states)} FBA nexus states")
    print(f"{'='*70}\n")

    analysis = run_throwback_analysis(nexus_states, order_data, year, args.home_state)
    t = analysis['totals']

    # ── Print Summary ──
    print(f"  ┌─────────────────────────────────────────────────────┐")
    print(f"  │  CPA throws back:           ${t['cpa_throwback']:>12,.2f}          │")
    print(f"  │  Correct throwback:          ${t['correct_throwback']:>12,.2f}          │")
    print(f"  │  OVERATTRIBUTED TO CA:       ${t['overattributed']:>12,.2f}          │")
    print(f"  │                                                     │")
    print(f"  │  CPA's CA sales factor:      {t['cpa_ca_factor']:>6.1f}%                │")
    print(f"  │  Correct CA sales factor:    {t['correct_ca_factor']:>6.1f}%                │")
    print(f"  └─────────────────────────────────────────────────────┘")
    print()

    # ── Generate Report ──
    report = generate_report(nexus_states, order_data, analysis, year)

    output_path = args.output or f"nexus-analysis-{year}.md"
    with open(output_path, 'w') as f:
        f.write(report)
    print(f"📄 Report saved to: {output_path}")

    if args.json:
        # Make JSON-serializable
        json_data = {
            'year': year,
            'fba_nexus_states': {
                state: {
                    'fcs': sorted(ns.fcs),
                    'events': ns.events,
                    'first_date': ns.first_date,
                    'last_date': ns.last_date,
                }
                for state, ns in nexus_states.items()
            },
            'analysis': analysis,
            'platform_totals': dict(order_data.platform_totals),
        }
        with open(args.json, 'w') as f:
            json.dump(json_data, f, indent=2, default=str)
        print(f"📊 JSON data saved to: {args.json}")

    print(f"\n✅ Done.\n")


if __name__ == '__main__':
    main()
