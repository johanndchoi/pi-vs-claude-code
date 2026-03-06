#!/usr/bin/env node
/**
 * Build and deploy n8n sync workflows from existing .mjs scripts.
 * 
 * Reads each sync script, strips Node.js-specific code (fs, op, argv),
 * injects credentials from 1Password via Set nodes, wraps in
 * Schedule Trigger → Set Credentials → Code node, and deploys via n8n API.
 *
 * Usage:
 *   node build-n8n-workflows.mjs                    # Build all
 *   node build-n8n-workflows.mjs --job veeqo-orders # Build one
 *   node build-n8n-workflows.mjs --dry-run           # Preview JSON, don't deploy
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SYNC_DIR = join(__dirname, '..', 'sync');
const OUTPUT_DIR = join(__dirname, 'workflows');
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const specificJob = args.find((_, i) => args[i - 1] === '--job');

mkdirSync(OUTPUT_DIR, { recursive: true });

// ─── Load credentials ────────────────────────────────────────────────
function op(ref) {
  return execSync(`op read "${ref}"`, { encoding: 'utf8' }).trim();
}

console.log('Loading credentials from 1Password...');
const CREDS = {
  n8n_api_key: execSync(
    "op item get 'n8nAPICredential' --vault 'Agents Service Accounts' --reveal --format json | jq -r '.fields[] | select(.label == \"credential\") | .value'",
    { encoding: 'utf8' }
  ).trim(),
  supabase_url: 'https://skgzcllomhsmpbkdnqqc.supabase.co',
  supabase_key: readFileSync(join(__dirname, '..', '.env.local'), 'utf8').match(/SUPABASE_SERVICE_ROLE_KEY=(.+)/)?.[1]?.trim() || '',
  veeqo_key: op('op://Agents Service Accounts/Veeqo API Credentials/credential'),
  ss_key: op('op://Agents Service Accounts/Shipstation v1 API Credential/API Key'),
  ss_secret: op('op://Agents Service Accounts/Shipstation v1 API Credential/API Secret'),
  wm_client_id: op('op://Agents Service Accounts/Walmart API Credentials/username'),
  wm_client_secret: op('op://Agents Service Accounts/Walmart API Credentials/credential'),
  amz_client_id: op('op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials'),
  amz_client_secret: op('op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret'),
  amz_refresh_token: op('op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken'),
  amz_marketplace_id: op('op://Agents Service Accounts/Amazon SP-API Credentials/MarketplaceId'),
  snap_user: op('op://Agents Service Accounts/SellerSnapAPI/username'),
  snap_pass: op('op://Agents Service Accounts/SellerSnapAPI/password'),
};
console.log('Credentials loaded.');

const N8N_URL = 'https://n8n.snatched-it.com';

// ─── Job definitions ─────────────────────────────────────────────────
const JOBS = {
  'veeqo-orders': {
    script: 'veeqo-orders.mjs',
    name: 'Sync: Veeqo Orders',
    intervalMinutes: 60,
    credVars: {
      VEEQO_KEY: CREDS.veeqo_key,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
    extras: ['lib/tracking-url.mjs'],
  },
  'veeqo-tracking': {
    script: 'veeqo-tracking.mjs',
    name: 'Sync: Veeqo Tracking',
    intervalMinutes: 120,
    credVars: {
      VEEQO_KEY: CREDS.veeqo_key,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
    extraConsts: 'const RECENT_LIMIT = 2000;',
  },
  'veeqo-products': {
    script: 'veeqo-products.mjs',
    name: 'Sync: Veeqo Products',
    intervalMinutes: 360,
    credVars: {
      VEEQO_KEY: CREDS.veeqo_key,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
  },
  'shipstation-shipments': {
    script: 'shipstation-shipments.mjs',
    name: 'Sync: ShipStation Shipments',
    intervalMinutes: 360,
    credVars: {
      SS_KEY: CREDS.ss_key,
      SS_SECRET: CREDS.ss_secret,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
    extraConsts: "const SS_AUTH = 'Basic ' + btoa(SS_KEY + ':' + SS_SECRET);",
  },
  'walmart-enrich': {
    script: 'walmart-enrich.mjs',
    name: 'Sync: Walmart Enrich',
    intervalMinutes: 360,
    credVars: {
      WM_CLIENT_ID: CREDS.wm_client_id,
      WM_CLIENT_SECRET: CREDS.wm_client_secret,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
  },
  'amazon-enrich': {
    script: 'amazon-enrich.mjs',
    name: 'Sync: Amazon Enrich',
    intervalMinutes: 360,
    credVars: {
      AMZ_CLIENT_ID: CREDS.amz_client_id,
      AMZ_CLIENT_SECRET: CREDS.amz_client_secret,
      AMZ_REFRESH_TOKEN: CREDS.amz_refresh_token,
      AMZ_MARKETPLACE: CREDS.amz_marketplace_id,
      SS_KEY: CREDS.ss_key,
      SS_SECRET: CREDS.ss_secret,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
    extraConsts: `const SS_AUTH = 'Basic ' + btoa(SS_KEY + ':' + SS_SECRET);
const AMAZON_CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';`,
  },
  'returns-sync': {
    script: 'returns-sync.mjs',
    name: 'Sync: Returns',
    intervalMinutes: 720,
    credVars: {
      AMZ_LWA: CREDS.amz_client_id,
      AMZ_SECRET: CREDS.amz_client_secret,
      AMZ_REFRESH: CREDS.amz_refresh_token,
      WM_CLIENT_ID: CREDS.wm_client_id,
      WM_CLIENT_SECRET: CREDS.wm_client_secret,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
  },
  'walmart-fees': {
    script: 'walmart-fees.mjs',
    name: 'Sync: Walmart Fees',
    intervalMinutes: 720,
    credVars: {
      WM_CLIENT_ID: CREDS.wm_client_id,
      WM_CLIENT_SECRET: CREDS.wm_client_secret,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
  },
  'amazon-settlements': {
    script: 'amazon-settlements.mjs',
    name: 'Sync: Amazon Settlements',
    intervalMinutes: 720,
    credVars: {
      AMZ_CLIENT_ID: CREDS.amz_client_id,
      AMZ_CLIENT_SECRET: CREDS.amz_client_secret,
      AMZ_REFRESH_TOKEN: CREDS.amz_refresh_token,
      AMZ_MARKETPLACE_ID: CREDS.amz_marketplace_id,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
    extraConsts: "const CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';",
  },
  'sellersnap-costs': {
    script: 'sellersnap-costs.mjs',
    name: 'Sync: SellerSnap Costs',
    intervalMinutes: 1440,
    credVars: {
      SS_USER: CREDS.snap_user,
      SS_PASS: CREDS.snap_pass,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
  },
  'inventory-snapshot': {
    script: 'inventory-snapshot.mjs',
    name: 'Sync: Inventory Snapshot',
    intervalMinutes: 1440,
    credVars: {
      VEEQO_KEY: CREDS.veeqo_key,
      SS_KEY: CREDS.ss_key,
      SS_SECRET: CREDS.ss_secret,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
    extraConsts: "const SS_AUTH = 'Basic ' + btoa(SS_KEY + ':' + SS_SECRET);",
  },
  'amazon-ads': {
    script: 'amazon-ads.mjs',
    name: 'Sync: Amazon Ads',
    intervalMinutes: 1440,
    credVars: {
      AMZ_CLIENT_ID: CREDS.amz_client_id,
      AMZ_CLIENT_SECRET: CREDS.amz_client_secret,
      AMZ_REFRESH_TOKEN: CREDS.amz_refresh_token,
      AMZ_MARKETPLACE_ID: CREDS.amz_marketplace_id,
      SUPA_URL: CREDS.supabase_url,
      SUPA_KEY: CREDS.supabase_key,
    },
    extraConsts: "const AMAZON_CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';",
  },
};

// ─── Transform script for n8n Code node ──────────────────────────────
function transformScript(source, job) {
  let code = source;

  // Remove shebang
  code = code.replace(/^#!.*\n/, '');

  // Remove JSDoc block at top
  code = code.replace(/^\/\*\*[\s\S]*?\*\/\s*\n/m, '');

  // Remove Node.js imports
  code = code.replace(/^import\s+\{[^}]*\}\s+from\s+['"](?:fs|path|child_process|url|zlib)['"]\s*;?\s*$/gm, '');
  code = code.replace(/^import\s+.*from\s+['"]\.\/lib\/.*['"]\s*;?\s*$/gm, '');

  // Remove __dirname
  code = code.replace(/^const __dirname.*$/gm, '');

  // Remove CLI arg parsing
  const argPatterns = [
    /^const args = process\.argv.*$/gm,
    /^const DRY_RUN = args.*$/gm,
    /^const FULL_SYNC = args.*$/gm,
    /^const FULL = args.*$/gm,
    /^const sinceArg = args.*$/gm,
    /^const recentArg = args.*$/gm,
    /^const RECENT_LIMIT = recentArg.*$/gm,
    /^const RESET = args.*$/gm,
    /^const batchArg = args.*$/gm,
    /^const BATCH_SIZE = batchArg.*$/gm,
    /^const ALL = args.*$/gm,
    /^const AMAZON_ONLY = args.*$/gm,
    /^const WALMART_ONLY = args.*$/gm,
    /^const CHECK_SETTLEMENTS = args.*$/gm,
    /^const BACKFILL = args.*$/gm,
    /^const REMATCH = args.*$/gm,
    /^const ANALYZE = args.*$/gm,
    /^const FILL_GAPS = args.*$/gm,
    /^const SPECIFIC_REPORT = args.*$/gm,
    /^const FORCE = args.*$/gm,
    /^const reportArg = args.*$/gm,
  ];
  for (const p of argPatterns) code = code.replace(p, '');

  // Remove loadEnv function and call
  code = code.replace(/function loadEnv\(\)\s*\{[\s\S]*?\n\}\s*\n?/g, '');
  code = code.replace(/^loadEnv\(\);?\s*$/gm, '');

  // Remove credential loading (op/execSync/process.env patterns)
  // These are replaced by the credVars injected at the top
  const credPatterns = [
    /^const (?:VEEQO_KEY)\s*=\s*(?:process\.env\.[^;]*?\|\|[\s\S]*?;|execSync.*?;)/gm,
    /^const (?:SS_KEY|SS_SECRET)\s*=\s*(?:process\.env\.[^;]*?\|\|[\s\S]*?;|opExec.*?;|execSync.*?;)/gm,
    /^const SS_AUTH = 'Basic '.*$/gm,
    /^const (?:WM_CLIENT_ID|WM_CLIENT_SECRET)\s*=\s*execSync.*$/gm,
    /^const (?:AMZ_CLIENT_ID|AMZ_CLIENT_SECRET|AMZ_REFRESH_TOKEN|AMZ_REFRESH|AMZ_LWA|AMZ_SECRET|AMZ_MARKETPLACE|AMZ_MARKETPLACE_ID)\s*=\s*(?:execSync|opRead).*$/gm,
    /^const (?:SS_USER|SS_PASS)\s*=\s*execSync.*$/gm,
    /^const (?:LWA_CLIENT_ID|LWA_CLIENT_SECRET|REFRESH_TOKEN)\s*=\s*execSync.*$/gm,
    /^const SUPA_URL = process\.env.*$/gm,
    /^const SUPA_KEY = process\.env.*$/gm,
    /^if \(!SUPA_URL.*$/gm,
  ];
  for (const p of credPatterns) code = code.replace(p, '');

  // Remove opRead helper function
  code = code.replace(/function opRead\(ref\)\s*\{[\s\S]*?\n\}\s*\n?/gm, '');
  // Also handle single-line opRead
  code = code.replace(/^const \w+ = opRead\(.*$/gm, '');

  // Remove cursor file paths
  code = code.replace(/^const CURSOR_FILE = .*$/gm, '');
  code = code.replace(/^const CURSOR_DIR = .*$/gm, '');

  // Replace filesystem cursor operations with no-ops
  // readFileSync for cursors → empty string
  code = code.replace(/readFileSync\(CURSOR_FILE[^)]*\)/g, "''");
  code = code.replace(/readFileSync\(join\(CURSOR_DIR[^)]*\)[^)]*\)/g, "''");
  code = code.replace(/writeFileSync\(CURSOR_FILE[^)]*\);?/g, '/* cursor saved via Supabase sync_cursors */');
  code = code.replace(/writeFileSync\(join\(CURSOR_DIR[^)]*\)[^)]*\);?/g, '/* cursor saved via Supabase sync_cursors */');
  code = code.replace(/existsSync\(CURSOR_FILE\)/g, 'false');
  code = code.replace(/existsSync\(join\(CURSOR_DIR[^)]*\)\)/g, 'false');
  code = code.replace(/mkdirSync\(CURSOR_DIR[^)]*\);?/g, '');

  // Replace process.exit with return
  code = code.replace(/process\.exit\(\d+\)/g, 'return []');

  // Replace Buffer.from with btoa for basic auth
  code = code.replace(/Buffer\.from\(`?\$\{(\w+)\}:\$\{(\w+)\}`?\)\.toString\('base64'\)/g,
    'btoa($1 + ":" + $2)');
  code = code.replace(/Buffer\.from\(([^)]+)\)\.toString\('base64'\)/g, 'btoa($1)');

  // n8n Code node doesn't have createGunzip/createUnzip — use fetch response methods
  // These need manual fixes per script, flag them
  code = code.replace(/createGunzip\(\)/g, '/* TODO: createGunzip not available in n8n sandbox */');
  code = code.replace(/createUnzip\(\)/g, '/* TODO: createUnzip not available in n8n sandbox */');
  code = code.replace(/createWriteStream\(/g, '/* TODO: createWriteStream not available */ (');

  // Replace main() pattern: n8n Code node needs to return items
  // Wrap main() call to return results
  if (code.includes('main().catch')) {
    code = code.replace(
      /main\(\)\.catch\(e => \{[^}]*\}\);?\s*$/m,
      `// Run sync and return results
try {
  await main();
  return [{ json: { status: 'completed', timestamp: new Date().toISOString() } }];
} catch (e) {
  return [{ json: { status: 'error', error: e.message, timestamp: new Date().toISOString() } }];
}`
    );
  }

  // Strip excessive empty lines
  code = code.replace(/\n{3,}/g, '\n\n');

  // Inline tracking-url helper if needed
  if (job.extras?.includes('lib/tracking-url.mjs')) {
    const trackingUrl = readFileSync(join(SYNC_DIR, 'lib', 'tracking-url.mjs'), 'utf8');
    const fnBody = trackingUrl
      .replace(/^\/\*\*[\s\S]*?\*\/\s*\n/m, '')
      .replace(/^export /m, '');
    code = fnBody + '\n' + code;
  }

  return code;
}

// ─── Build workflow JSON ─────────────────────────────────────────────
function buildWorkflow(jobName, job) {
  const source = readFileSync(join(SYNC_DIR, job.script), 'utf8');
  const syncCode = transformScript(source, job);

  // Build credential const declarations
  const credLines = Object.entries(job.credVars)
    .map(([k, v]) => `const ${k} = ${JSON.stringify(v)};`)
    .join('\n');

  const fullCode = `// ─── Credentials (injected at build time from 1Password) ─────
${credLines}
${job.extraConsts || ''}

const DRY_RUN = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(msg) { console.log('[' + new Date().toLocaleTimeString() + '] ' + msg); }

// ─── Sync Logic (from ${job.script}) ─────────────────────────
${syncCode}`;

  // Build schedule
  let scheduleRule;
  const mins = job.intervalMinutes;
  if (mins >= 1440) {
    scheduleRule = { interval: [{ field: 'hours', hoursInterval: 24 }] };
  } else if (mins >= 60) {
    scheduleRule = { interval: [{ field: 'hours', hoursInterval: mins / 60 }] };
  } else {
    scheduleRule = { interval: [{ field: 'minutes', minutesInterval: mins }] };
  }

  const triggerNodeName = 'Schedule Trigger';
  const codeNodeName = `${jobName} sync`;

  return {
    name: job.name,
    nodes: [
      {
        parameters: { rule: scheduleRule },
        type: 'n8n-nodes-base.scheduleTrigger',
        typeVersion: 1.2,
        position: [240, 300],
        id: crypto.randomUUID(),
        name: triggerNodeName,
      },
      {
        parameters: {
          jsCode: fullCode,
        },
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        position: [480, 300],
        id: crypto.randomUUID(),
        name: codeNodeName,
      },
    ],
    connections: {
      [triggerNodeName]: {
        main: [[{ node: codeNodeName, type: 'main', index: 0 }]],
      },
    },
    settings: {
      executionOrder: 'v1',
    },
  };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  const jobsToProcess = specificJob
    ? { [specificJob]: JOBS[specificJob] }
    : JOBS;

  if (specificJob && !JOBS[specificJob]) {
    console.error(`Unknown job: ${specificJob}`);
    console.error(`Available: ${Object.keys(JOBS).join(', ')}`);
    process.exit(1);
  }

  console.log(`\nBuilding ${Object.keys(jobsToProcess).length} n8n workflows...\n`);
  const results = [];

  for (const [name, job] of Object.entries(jobsToProcess)) {
    process.stdout.write(`${name}...`);

    try {
      const workflow = buildWorkflow(name, job);

      // Save JSON locally (without credentials for git safety)
      const safeWorkflow = JSON.parse(JSON.stringify(workflow));
      // Redact credentials from saved JSON
      safeWorkflow.nodes.forEach(n => {
        if (n.parameters?.jsCode) {
          n.parameters.jsCode = n.parameters.jsCode.replace(
            /^const \w+ = "(?:eyJ|ops_|[a-f0-9]{32})[^"]*";$/gm,
            'const $& = "REDACTED";'
          );
        }
      });
      writeFileSync(
        join(OUTPUT_DIR, `${name}.json`),
        JSON.stringify(safeWorkflow, null, 2)
      );

      if (!DRY_RUN) {
        const res = await fetch(`${N8N_URL}/api/v1/workflows`, {
          method: 'POST',
          headers: {
            'X-N8N-API-KEY': CREDS.n8n_api_key,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(workflow),
        });

        const result = await res.json();
        if (result.id) {
          console.log(` ✅ ${result.id}`);
          results.push({ name, id: result.id, status: 'deployed' });
        } else {
          console.log(` ❌ ${JSON.stringify(result).slice(0, 150)}`);
          results.push({ name, status: 'failed', error: result.message || JSON.stringify(result).slice(0, 100) });
        }
      } else {
        console.log(' (dry-run)');
        results.push({ name, status: 'dry-run' });
      }
    } catch (e) {
      console.log(` ❌ ${e.message}`);
      results.push({ name, status: 'error', error: e.message });
    }
  }

  console.log('\n── Summary ──');
  const deployed = results.filter(r => r.status === 'deployed');
  const failed = results.filter(r => r.status !== 'deployed' && r.status !== 'dry-run');
  console.log(`Deployed: ${deployed.length}/${results.length}`);
  if (failed.length) {
    console.log('Failed:');
    failed.forEach(f => console.log(`  ${f.name}: ${f.error}`));
  }
  if (deployed.length) {
    console.log('\nWorkflow IDs:');
    deployed.forEach(d => console.log(`  ${d.name}: ${d.id}`));
    console.log('\n⚠️  Workflows are created INACTIVE. Activate after testing.');
  }
}

main();
