#!/usr/bin/env node

/**
 * Shipment Photo OCR Workflow
 * Watches a Google Drive folder for new photos, OCRs tracking numbers via Tesseract,
 * matches to shipments in Supabase, and stores photos in Supabase Storage.
 *
 * Usage:
 *   node photo-ocr.mjs --watch                  # Poll Drive folder continuously
 *   node photo-ocr.mjs --file /path/to/photo.jpg  # Process a single local file
 *   node photo-ocr.mjs --dir /path/to/photos/     # Process all images in a directory
 *   node photo-ocr.mjs --test /path/to/photo.jpg  # OCR only, no DB writes
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join, basename, extname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const TEST_MODE = args.includes('--test');
const WATCH_MODE = args.includes('--watch');
const singleFile = args.find((_, i) => args[i - 1] === '--file');
const dirPath = args.find((_, i) => args[i - 1] === '--dir');

// ─── Credentials ─────────────────────────────────────────────────────
function loadEnv() {
    try {
        const paths = [join(__dirname, '..', '.env.local'), join(__dirname, '..', '..', '.env')];
        for (const p of paths) {
            try {
                const content = readFileSync(p, 'utf8');
                for (const line of content.split('\n')) {
                    const m = line.match(/^([A-Z_]+)=(.+)$/);
                    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
                }
            } catch {}
        }
    } catch {}
}
loadEnv();

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

// ─── Tracking Number Patterns ────────────────────────────────────────
// These patterns match common carrier tracking number formats
const TRACKING_PATTERNS = [
    // UPS: 1Z + 6 alphanumeric + 2 digits + 8 digits (18 chars)
    { carrier: 'UPS', regex: /\b1Z[0-9A-Z]{6}[0-9]{10}\b/gi, normalize: s => s.toUpperCase() },
    // UPS: Common OCR errors — I→1, Z→2, l→1
    { carrier: 'UPS', regex: /\b[1Il][Z2][0-9A-Z]{6}[0-9]{10}\b/gi, normalize: s => s.toUpperCase().replace(/^.{2}/, '1Z') },

    // USPS: 20-34 digit numbers starting with 9
    { carrier: 'USPS', regex: /\b9[0-9]{19,33}\b/g, normalize: s => s },

    // FedEx: 12 or 15 digits
    { carrier: 'FedEx', regex: /\b[0-9]{12}\b/g, normalize: s => s },
    { carrier: 'FedEx', regex: /\b[0-9]{15}\b/g, normalize: s => s },

    // OnTrac: C + 16-19 digits
    { carrier: 'OnTrac', regex: /\bC[0-9]{16,19}\b/gi, normalize: s => s.toUpperCase() },
    // OnTrac: D + 16-19 digits
    { carrier: 'OnTrac', regex: /\bD[0-9]{16,19}\b/gi, normalize: s => s.toUpperCase() },

    // Amazon Logistics: TBA + digits
    { carrier: 'Amazon', regex: /\bTBA[0-9]{10,15}\b/gi, normalize: s => s.toUpperCase() },
];

// ─── Tesseract OCR ───────────────────────────────────────────────────
function ocrImage(filePath) {
    // Resolve symlinks (macOS /tmp -> /private/tmp can confuse tesseract)
    const resolvedPath = execSync(`realpath "${filePath}"`, { encoding: 'utf8' }).trim();

    const attempts = [
        `tesseract "${resolvedPath}" stdout --psm 6 -c tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`,
        `tesseract "${resolvedPath}" stdout --psm 6`,
        `tesseract "${resolvedPath}" stdout`
    ];

    for (const cmd of attempts) {
        try {
            const text = execSync(cmd, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] });
            if (text.trim()) return text.trim();
        } catch {}
    }
    return '';
}

function extractTrackingNumbers(ocrText) {
    const found = [];
    const seen = new Set();

    for (const pattern of TRACKING_PATTERNS) {
        const matches = ocrText.match(pattern.regex) || [];
        for (const match of matches) {
            const normalized = pattern.normalize(match);
            if (!seen.has(normalized)) {
                seen.add(normalized);
                found.push({ tracking_number: normalized, carrier: pattern.carrier });
            }
        }
    }

    return found;
}

// ─── Supabase helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

async function supaInsert(table, data) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
        },
        body: JSON.stringify(data)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${table} ${res.status}: ${JSON.stringify(body).slice(0, 200)}`);
    return Array.isArray(body) ? body[0] : body;
}

async function findShipmentByTracking(trackingNumber) {
    // Exact match first
    let rows = await supaGet(`shipments?tracking_number=eq.${encodeURIComponent(trackingNumber)}&select=id,tracking_number,order_id,carrier_name&limit=1`);
    if (rows?.length) return rows[0];

    // Try case-insensitive
    rows = await supaGet(`shipments?tracking_number=ilike.${encodeURIComponent(trackingNumber)}&select=id,tracking_number,order_id,carrier_name&limit=1`);
    if (rows?.length) return rows[0];

    return null;
}

async function uploadToStorage(filePath, storagePath) {
    const fileData = readFileSync(filePath);
    const ext = extname(filePath).toLowerCase();
    const mimeType = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.heic': 'image/heic', '.webp': 'image/webp' }[ext] || 'image/jpeg';

    const res = await fetch(`${SUPA_URL}/storage/v1/object/shipment-photos/${storagePath}`, {
        method: 'POST',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': mimeType,
            'x-upsert': 'true'
        },
        body: fileData
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Storage upload ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
}

// ─── Process one image ───────────────────────────────────────────────
async function processImage(filePath, driveFileId = null) {
    const fileName = basename(filePath);
    log(`Processing: ${fileName}`);

    // 1. OCR
    const ocrText = ocrImage(filePath);
    if (!ocrText) {
        log(`  ⚠ No text detected`);
        return { matched: false, tracking: null };
    }

    const trackingNumbers = extractTrackingNumbers(ocrText);
    log(`  OCR: ${ocrText.split('\n').slice(0, 3).join(' | ').slice(0, 100)}`);
    log(`  Tracking numbers found: ${trackingNumbers.length ? trackingNumbers.map(t => `${t.carrier}:${t.tracking_number}`).join(', ') : 'none'}`);

    if (TEST_MODE) {
        return { matched: false, tracking: trackingNumbers, ocr: ocrText };
    }

    if (!SUPA_URL || !SUPA_KEY) {
        log('  ⚠ No Supabase credentials — test mode only');
        return { matched: false, tracking: trackingNumbers };
    }

    // 2. Try to match each tracking number to a shipment
    let matchedShipment = null;
    let matchedTracking = null;

    for (const tn of trackingNumbers) {
        const shipment = await findShipmentByTracking(tn.tracking_number);
        if (shipment) {
            matchedShipment = shipment;
            matchedTracking = tn;
            log(`  ✅ Matched: ${tn.tracking_number} → shipment ${shipment.id.slice(0, 8)}... (${shipment.carrier_name})`);
            break;
        }
    }

    // 3. Upload photo to Supabase Storage
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = extname(filePath).toLowerCase() || '.jpg';
    const storagePath = matchedShipment
        ? `matched/${matchedTracking.tracking_number}/${timestamp}${ext}`
        : `unmatched/${timestamp}-${fileName}`;

    try {
        await uploadToStorage(filePath, storagePath);
        log(`  📷 Uploaded to: ${storagePath}`);
    } catch (e) {
        log(`  ⚠ Upload failed: ${e.message}`);
    }

    // 4. Create shipment_photos record
    const fileStats = statSync(filePath);
    const photoRecord = {
        shipment_id: matchedShipment?.id || null,
        tracking_number: matchedTracking?.tracking_number || trackingNumbers[0]?.tracking_number || null,
        storage_path: storagePath,
        ocr_raw: ocrText.slice(0, 5000),
        photo_taken_at: fileStats.mtime.toISOString(),
        drive_file_id: driveFileId,
        file_size_bytes: fileStats.size,
        mime_type: extname(filePath) === '.png' ? 'image/png' : 'image/jpeg',
        matched: !!matchedShipment,
        match_method: matchedShipment ? 'exact' : null
    };

    try {
        await supaInsert('shipment_photos', photoRecord);
        log(`  📝 Record created`);
    } catch (e) {
        log(`  ⚠ DB record failed: ${e.message}`);
    }

    if (!matchedShipment && trackingNumbers.length > 0) {
        log(`  ⚠ No shipment match for: ${trackingNumbers.map(t => t.tracking_number).join(', ')}`);
    }

    return {
        matched: !!matchedShipment,
        tracking: matchedTracking || trackingNumbers[0],
        shipment: matchedShipment
    };
}

// ─── Process directory ───────────────────────────────────────────────
async function processDirectory(dir) {
    const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.heic', '.webp', '.tiff', '.tif'];
    const files = readdirSync(dir)
        .filter(f => IMAGE_EXTS.includes(extname(f).toLowerCase()))
        .map(f => join(dir, f));

    log(`Found ${files.length} images in ${dir}`);

    let matched = 0, unmatched = 0, noText = 0;
    for (const file of files) {
        const result = await processImage(file);
        if (result.matched) matched++;
        else if (result.tracking) unmatched++;
        else noText++;
    }

    log('────────────────────────────────────');
    log(`Done! Matched: ${matched}, Unmatched: ${unmatched}, No text: ${noText}`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    if (singleFile || (TEST_MODE && args[args.indexOf('--test') + 1])) {
        const file = singleFile || args[args.indexOf('--test') + 1];
        if (!existsSync(file)) { log(`File not found: ${file}`); process.exit(1); }
        const result = await processImage(file);
        if (TEST_MODE) {
            console.log(JSON.stringify(result, null, 2));
        }
        return;
    }

    if (dirPath) {
        if (!existsSync(dirPath)) { log(`Directory not found: ${dirPath}`); process.exit(1); }
        await processDirectory(dirPath);
        return;
    }

    if (WATCH_MODE) {
        log('Watch mode requires Google Drive credentials (not yet configured)');
        log('For now, use --file or --dir to process local images');
        process.exit(1);
    }

    console.log(`
Shipment Photo OCR

Usage:
  node photo-ocr.mjs --test /path/to/photo.jpg     # Test OCR only
  node photo-ocr.mjs --file /path/to/photo.jpg      # Process + store
  node photo-ocr.mjs --dir /path/to/photos/          # Batch process
  node photo-ocr.mjs --watch                          # Watch Google Drive (needs setup)
`);
}

main().catch(e => { console.error(e); process.exit(1); });
