# Nexus Tax Analyzer

**FBA Physical Nexus & California Throwback Analysis Tool**

Analyzes your Amazon FBA inventory data and order data from multiple platforms (Amazon, eBay, Walmart/ShipStation) to calculate the correct California sales factor under R&TC §25135/§25122.

## What It Does

1. **Maps FBA inventory** to states using fulfillment center codes → proves physical nexus
2. **Ingests orders** from Amazon Order Reports, ShipStation (Walmart/FBM), and eBay
3. **Runs throwback analysis** — determines which out-of-state sales should be thrown back to CA vs. blocked by FBA nexus
4. **Calculates the correct CA sales factor** vs. your CPA's throwback-everything approach
5. **Generates a Markdown report** with full state-by-state breakdown and estimated tax impact

## Requirements

- Python 3.8+
- No external dependencies (stdlib only)

## Usage

```bash
# Full analysis — all platforms
python3 nexus_analyzer.py --year 2025 \
    --fba-inventory "~/Downloads/Fulfillment Report.csv" \
    --amazon-orders "~/Downloads/Order Report*.txt" \
    --shipstation "~/Downloads/ShipStation Data.csv" \
    --ebay "~/Downloads/eBay Orders Report.csv" \
    --output nexus-analysis-2025.md

# Just FBA + ShipStation (Amazon FBM + Walmart)
python3 nexus_analyzer.py --year 2024 \
    --fba-inventory "~/Downloads/Amazon Custom Tax Report.csv" \
    --shipstation "~/Downloads/ShipStation Data (4).csv"

# Save raw data as JSON too
python3 nexus_analyzer.py --year 2025 \
    --fba-inventory report.csv \
    --shipstation orders.csv \
    --json analysis-2025.json
```

## Input Files

| Flag | Source | Format |
|------|--------|--------|
| `--fba-inventory` | Amazon Seller Central → Reports → Fulfillment → Inventory Event Detail (or Custom Tax Report FC) | CSV with `Fulfillment Center` column |
| `--amazon-orders` | Amazon Seller Central → Reports → Order Reports | Tab-delimited .txt |
| `--shipstation` | ShipStation → Export Orders | CSV with `Order #`, `State`, `Order Total` |
| `--ebay` | eBay → Seller Hub → Orders → Download report | CSV with `Ship To State`, `Sold For` |

## How to Get the Reports

### Amazon FBA Inventory Report
1. Seller Central → Reports → Fulfillment → Inventory → Inventory Event Detail
2. Request report for the full tax year
3. Download CSV

### Amazon Order Reports  
1. Seller Central → Reports → Order Reports → Generate
2. Set date range per quarter (Amazon limits to ~3 months per report)
3. Download all .txt files

### ShipStation
1. ShipStation → Orders → Filter by date range
2. Export → CSV
3. This captures Amazon FBM + Walmart orders shipped from your warehouse

### eBay
1. Seller Hub → Orders → All orders → Filter by date
2. Download report

## The Legal Argument

Under **CA R&TC §25135(a)(2)(B)**, sales shipped from CA to another state are "thrown back" and assigned to CA **unless** you're "taxable" in the destination state.

Under **CA R&TC §25122**, "taxable" means subject to:
- (a) a net income tax, **a franchise tax for the privilege of doing business**, or a corporate stock tax
- (b) "regardless of whether, in fact, the state does or does not" impose the tax

**FBA inventory in a state = physical nexus = you are "taxable" there = throwback is BLOCKED.**

Texas alone (franchise tax under TX Tax Code §171.001) blocks throwback on your largest out-of-state market. Multiply that across 40+ FBA states and the CPA's approach of throwing back ALL out-of-state FBM sales to CA is massively wrong.

## Output

Generates a Markdown report with:
- FBA physical nexus map (states, FCs, date ranges)
- Platform-by-platform revenue breakdown
- Monthly revenue table
- State-by-state throwback analysis
- **The number**: CPA's CA sales factor vs. correct CA sales factor
- Estimated tax overpayment at various income levels
- Legal citations
