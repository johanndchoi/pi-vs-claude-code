---
name: shipment-tracker
description: Track shipments by tracking number. Looks up the Veeqo ID from Airtable, then fetches tracking events from Veeqo.
metadata:
  clawdbot:
    emoji: "📦"
    requires:
      env: ["AIRTABLE_API_KEY", "VEEQO_API_KEY"]
---

# Shipment Tracker

Track shipment status by tracking number.

## Setup

Requires two environment variables:
```bash
export AIRTABLE_API_KEY="your-airtable-api-key"
export VEEQO_API_KEY="your-veeqo-api-key"
```

## Commands

```bash
# Look up tracking events by tracking number
{baseDir}/scripts/track.sh <TRACKING_NUMBER>

# Look up just the Veeqo ID from Airtable
{baseDir}/scripts/track.sh --lookup <TRACKING_NUMBER>
```

## Usage Examples

**User: "Track my shipment 1Z999AA10123456784"**
```bash
{baseDir}/scripts/track.sh 1Z999AA10123456784
```

**User: "Where is package 9400111899223456789012?"**
```bash
{baseDir}/scripts/track.sh 9400111899223456789012
```

**User: "What's the status of tracking number ABC123?"**
```bash
{baseDir}/scripts/track.sh ABC123
```

## How It Works

1. Queries Airtable to find the record matching the tracking number
2. Extracts the Veeqo ID from the Airtable record
3. Fetches tracking events from Veeqo using the Veeqo ID
4. Returns the full tracking history

## Notes

- Tracking numbers are looked up in Airtable field "Tracking Number"
- The Veeqo ID field is extracted from the Airtable response
- Returns tracking events in JSON format from Veeqo
