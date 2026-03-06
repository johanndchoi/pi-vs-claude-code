# n8n Workflow Builder — Agent Instructions

You are building an n8n workflow to replace a local Node.js sync script. Your job is to create a **proper n8n-native workflow** using HTTP Request nodes, Supabase nodes, Code nodes (for data transformation ONLY), and Loop nodes.

## Architecture Rules

1. **HTTP Request nodes** for ALL external API calls — with n8n credential injection
2. **Code nodes** ONLY for data transformation/mapping between nodes — never for API calls
3. **SplitInBatches / Loop** for pagination
4. **Supabase nodes** for database operations where possible (fallback to HTTP Request with Supabase credential)
5. **IF nodes** for conditional logic (matched/unmatched, error handling)
6. **Error Trigger** nodes for failure notifications
7. **Schedule Trigger** for the cron schedule

## Credential IDs in n8n (reference these by ID)

| Service | n8n Credential ID | Type |
|---------|-------------------|------|
| Supabase | `gHruXnC2qqFwxMPZ` | supabaseApi |
| Veeqo | `3HIHmn9LaxU03JrD` | httpHeaderAuth |
| ShipStation | `HMaOhjiiZTgoiHb5` | httpBasicAuth |
| Walmart | `cvTnlRf6bR41gyKH` | httpBasicAuth |
| Amazon SP-API | `Ok0qiTbXLIzVMHjV` | httpCustomAuth |
| SellerSnap | `b4jgA0UcxjCCJuq0` | httpBasicAuth |

## n8n API

Deploy workflow:
```bash
curl -X POST "https://n8n.snatched-it.com/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @workflow.json
```

The API key is at: `op item get 'n8nAPICredential' --vault 'Agents Service Accounts' --reveal --format json | jq -r '.fields[] | select(.label == "credential") | .value'`

## Workflow JSON Structure

```json
{
  "name": "Sync: <Name>",
  "nodes": [
    {
      "parameters": { "rule": { "interval": [{"field": "hours", "hoursInterval": 1}] } },
      "type": "n8n-nodes-base.scheduleTrigger",
      "typeVersion": 1.2,
      "position": [240, 300],
      "id": "<uuid>",
      "name": "Schedule Trigger"
    },
    {
      "parameters": {
        "url": "https://api.veeqo.com/orders?page=1&page_size=100",
        "authentication": "predefinedCredentialType",
        "nodeCredentialType": "httpHeaderAuth",
        "options": { "response": { "response": { "responseFormat": "json" } } }
      },
      "type": "n8n-nodes-base.httpRequest",
      "typeVersion": 4.3,
      "position": [480, 300],
      "id": "<uuid>",
      "name": "Fetch Orders Page",
      "credentials": {
        "httpHeaderAuth": { "id": "3HIHmn9LaxU03JrD", "name": "Veeqo Header Auth account" }
      }
    }
  ],
  "connections": {
    "Schedule Trigger": { "main": [[{"node": "Fetch Orders Page", "type": "main", "index": 0}]] }
  },
  "settings": { "executionOrder": "v1" }
}
```

## Supabase Node Pattern

```json
{
  "parameters": {
    "operation": "upsert",
    "tableId": "orders",
    "fieldsToSend": {
      "values": [
        {"fieldName": "order_number", "fieldValue": "={{ $json.number }}"},
        {"fieldName": "status", "fieldValue": "={{ $json.status }}"}
      ]
    }
  },
  "type": "n8n-nodes-base.supabase",
  "typeVersion": 1,
  "credentials": {
    "supabaseApi": { "id": "gHruXnC2qqFwxMPZ", "name": "Supabase account" }
  }
}
```

## HTTP Request with Basic Auth (ShipStation)

```json
{
  "parameters": {
    "url": "https://ssapi.shipstation.com/shipments",
    "authentication": "predefinedCredentialType",
    "nodeCredentialType": "httpBasicAuth"
  },
  "credentials": {
    "httpBasicAuth": { "id": "HMaOhjiiZTgoiHb5", "name": "ShipStation API" }
  }
}
```

## Pagination Pattern (SplitInBatches + Loop)

For paginated API calls, use this pattern:
1. **Set node**: Initialize page=1
2. **HTTP Request**: Fetch page with `={{ $json.page }}`  
3. **Code node**: Check if more pages, increment page counter
4. **IF node**: If more pages → loop back to HTTP Request
5. **Merge**: Collect all results
6. **SplitInBatches**: Process records in batches for upsert

## Output

Save your workflow JSON to: `supabase/n8n/workflows/<job-name>.json`
Deploy it via the n8n API.
The workflow should be created INACTIVE (default).

## Reference Script

Read the original sync script at `supabase/sync/<script>.mjs` to understand:
- What API endpoints are called
- What data transformations are needed  
- What tables are written to
- What the pagination/cursor logic is
- What rate limiting is needed

DO NOT just copy the script into a Code node. Build it as proper n8n nodes.
