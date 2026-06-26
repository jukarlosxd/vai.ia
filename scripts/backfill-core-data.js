#!/usr/bin/env node
// scripts/backfill-core-data.js
//
// Reads ./tenants/*.json and ./appointments/*.json from the local filesystem
// and upserts every record into Supabase.
//
// SAFETY RULES:
//   - Never deletes anything (local files or Supabase rows)
//   - Never modifies local JSON files
//   - Fully idempotent: safe to run multiple times
//   - Uses UPSERT (ON CONFLICT DO UPDATE) — existing rows are updated, not duplicated
//   - Failures are logged and counted, not thrown — the script always completes
//
// USAGE:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_KEY=eyJ... \
//   node scripts/backfill-core-data.js
//
// Or via package.json:
//   npm run db:backfill

import { createClient } from '@supabase/supabase-js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const ROOT_DIR   = path.join(__dirname, '..');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('\n[FATAL] Missing required environment variables:');
  if (!SUPABASE_URL)  console.error('  ✗ SUPABASE_URL is not set');
  if (!SUPABASE_KEY)  console.error('  ✗ SUPABASE_SERVICE_KEY is not set');
  console.error('\nSet them in .env or export them before running this script.\n');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TENANTS_DIR      = path.join(ROOT_DIR, 'tenants');
const APPOINTMENTS_DIR = path.join(ROOT_DIR, 'appointments');

// Batch size for Supabase upserts — keeps individual payloads manageable.
const BATCH_SIZE = 50;

// ─── SLUG VALIDATION (identical to index.js:84) ──────────────────────────────
// Must match exactly — do not change the regex.
function validateSlug(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  if (!/^[a-z0-9-]{1,60}$/.test(s)) return null;
  return s;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function log(msg)  { console.log(`  ${msg}`); }
function warn(msg) { console.warn(`  ⚠  ${msg}`); }
function fail(msg) { console.error(`  ✗  ${msg}`); }
function ok(msg)   { console.log(`  ✓  ${msg}`); }

/**
 * Parse a date string into a UTC ISO string suitable for TIMESTAMPTZ.
 * Returns null if the string is not a valid date.
 */
function toUTCISO(raw) {
  if (!raw) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString(); // always UTC
}

/**
 * Read all *.json files from a directory.
 * Returns array of { filename, slug, data } objects.
 * Skips non-.json files and files with invalid slugs.
 * Logs all parse errors.
 */
async function readJsonDir(dirPath, label) {
  const results = [];
  let files;

  try {
    files = await fs.readdir(dirPath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      warn(`${label} directory not found: ${dirPath} — skipping`);
      return results;
    }
    throw e;
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));
  log(`${label}: found ${jsonFiles.length} .json file(s) in ${dirPath}`);

  for (const filename of jsonFiles) {
    const rawSlug = filename.replace(/\.json$/, '');
    const slug    = validateSlug(rawSlug);
    const filePath = path.join(dirPath, filename);

    if (!slug) {
      warn(`${label}: skipping "${filename}" — filename "${rawSlug}" is not a valid slug`);
      continue;
    }

    let raw, data;
    try {
      raw  = await fs.readFile(filePath, 'utf8');
      data = JSON.parse(raw);
    } catch (e) {
      fail(`${label}: could not parse "${filename}" — ${e.message}`);
      continue;
    }

    results.push({ filename, slug, data });
  }

  return results;
}

/**
 * Upsert an array of rows into a Supabase table in batches.
 * Returns { inserted: number, failed: number }.
 * Never throws — all errors are logged.
 */
async function batchUpsert(tableName, rows, conflictColumn) {
  let inserted = 0;
  let failed   = 0;

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const { error } = await supabase
      .from(tableName)
      .upsert(batch, { onConflict: conflictColumn, ignoreDuplicates: false });

    if (error) {
      fail(`${tableName} upsert batch [${i}..${i + batch.length - 1}] failed: ${error.message}`);
      failed += batch.length;
    } else {
      inserted += batch.length;
    }
  }

  return { inserted, failed };
}

// ─── STEP 1: BACKFILL TENANTS ────────────────────────────────────────────────

async function backfillTenants() {
  console.log('\n══════════════════════════════════════════');
  console.log('STEP 1 — Backfill tenants');
  console.log('══════════════════════════════════════════');

  const tenantFiles = await readJsonDir(TENANTS_DIR, 'Tenants');

  if (tenantFiles.length === 0) {
    warn('No valid tenant files found. Skipping tenant backfill.');
    return { found: 0, upserted: 0, failed: 0 };
  }

  const rows      = [];
  let   skipped   = 0;
  const now       = new Date().toISOString();

  for (const { filename, slug, data } of tenantFiles) {
    if (typeof data !== 'object' || Array.isArray(data) || data === null) {
      fail(`Tenant "${filename}": root value must be a JSON object, got ${typeof data} — skipping`);
      skipped++;
      continue;
    }

    // Map tenant JSON fields to Supabase columns.
    // name: prefer cfg.vars.business, cfg.vars.name, cfg.name, fallback to slug
    const name = (
      data?.vars?.business ||
      data?.vars?.name     ||
      data?.name           ||
      slug
    );

    const row = {
      slug,
      name:          String(name).slice(0, 255),
      system_prompt: data.system  ?? null,
      vars:          data.vars    ?? {},
      faq:           Array.isArray(data.faq) ? data.faq : [],
      fallback:      data.fallback ?? null,
      twilio_number: data.twilio_number ?? data.vars?.twilio_number ?? null,
      is_active:     true,
      updated_at:    now,
      // created_at is omitted — Supabase default (now()) is used on INSERT,
      // and ON CONFLICT DO UPDATE does not overwrite it.
    };

    rows.push(row);
    log(`Tenant prepared: ${slug} (name: "${row.name}")`);
  }

  if (rows.length === 0) {
    warn('No valid tenant rows to upsert after validation.');
    return { found: tenantFiles.length, upserted: 0, failed: skipped };
  }

  log(`\nUpserting ${rows.length} tenant(s) into Supabase...`);
  const { inserted, failed } = await batchUpsert('tenants', rows, 'slug');

  ok(`Tenants: ${inserted} upserted, ${failed + skipped} failed/skipped`);

  return {
    found:    tenantFiles.length,
    upserted: inserted,
    failed:   failed + skipped,
  };
}

// ─── STEP 2: BACKFILL APPOINTMENTS ───────────────────────────────────────────

async function backfillAppointments(validTenantSlugs) {
  console.log('\n══════════════════════════════════════════');
  console.log('STEP 2 — Backfill appointments');
  console.log('══════════════════════════════════════════');

  const apptFiles = await readJsonDir(APPOINTMENTS_DIR, 'Appointments');

  if (apptFiles.length === 0) {
    warn('No valid appointment files found. Skipping appointment backfill.');
    return { filesFound: 0, totalFound: 0, upserted: 0, failed: 0 };
  }

  let totalFound   = 0;
  let totalUpserted = 0;
  let totalFailed   = 0;
  const now = new Date().toISOString();

  for (const { filename, slug, data } of apptFiles) {
    // The appointment file for a tenant must be an array.
    if (!Array.isArray(data)) {
      fail(`Appointments "${filename}": expected JSON array at root, got ${typeof data} — skipping file`);
      continue;
    }

    // Warn if the tenant does not exist in Supabase yet.
    if (!validTenantSlugs.has(slug)) {
      warn(`Appointments "${filename}": tenant "${slug}" not found in Supabase. Attempting upsert anyway — it may fail FK constraint.`);
    }

    log(`Processing ${data.length} appointment(s) from ${filename}...`);
    totalFound += data.length;

    const rows    = [];
    let   skipped = 0;

    for (let i = 0; i < data.length; i++) {
      const appt = data[i];

      // id is required — it is the primary key.
      if (!appt.id || typeof appt.id !== 'string') {
        fail(`  appointments/${filename}[${i}]: missing or invalid "id" — skipping record`);
        skipped++;
        continue;
      }

      // start and end are required and must be valid dates.
      const startAt = toUTCISO(appt.start);
      const endAt   = toUTCISO(appt.end);

      if (!startAt) {
        fail(`  appointments/${filename}[${i}] id="${appt.id}": invalid "start" value "${appt.start}" — skipping`);
        skipped++;
        continue;
      }
      if (!endAt) {
        fail(`  appointments/${filename}[${i}] id="${appt.id}": invalid "end" value "${appt.end}" — skipping`);
        skipped++;
        continue;
      }
      if (new Date(endAt) <= new Date(startAt)) {
        fail(`  appointments/${filename}[${i}] id="${appt.id}": end_at <= start_at — skipping`);
        skipped++;
        continue;
      }

      // cancel_token: use existing value or generate a placeholder.
      // The placeholder prevents the NOT NULL constraint from firing on backfill.
      // It is overwritten by the real token when the appointment is next updated by the app.
      const cancelToken = appt.cancel_token || `backfill-${appt.id}`;

      const row = {
        id:            appt.id,
        tenant_slug:   slug,
        title:         appt.title         ?? appt.service ?? 'Appointment',
        service:       appt.service       ?? '',
        customer_name: appt.customer_name ?? appt.client_name ?? '',
        client_name:   appt.client_name   ?? appt.customer_name ?? '',
        start_at:      startAt,
        end_at:        endAt,
        email:         appt.email  ?? null,
        phone:         appt.phone  ?? null,
        notes:         appt.notes  ?? '',
        confirmed:     appt.confirmed !== false, // default true
        cancel_token:  cancelToken,
        created_at:    toUTCISO(appt.created_at) ?? now,
        updated_at:    toUTCISO(appt.updated_at) ?? now,
      };

      rows.push(row);
    }

    if (rows.length === 0) {
      warn(`  No valid rows from ${filename} (${skipped} skipped).`);
      totalFailed += skipped;
      continue;
    }

    log(`  Upserting ${rows.length} rows (${skipped} skipped)...`);
    const { inserted, failed } = await batchUpsert('appointments', rows, 'id');

    ok(`  ${filename}: ${inserted} upserted, ${failed + skipped} failed/skipped`);
    totalUpserted += inserted;
    totalFailed   += failed + skipped;
  }

  return {
    filesFound: apptFiles.length,
    totalFound,
    upserted:   totalUpserted,
    failed:     totalFailed,
  };
}

// ─── STEP 3: FETCH EXISTING TENANT SLUGS FROM SUPABASE ───────────────────────

async function fetchExistingTenantSlugs() {
  const { data, error } = await supabase
    .from('tenants')
    .select('slug');

  if (error) {
    warn(`Could not fetch existing tenant slugs from Supabase: ${error.message}`);
    return new Set();
  }

  return new Set((data ?? []).map(r => r.slug));
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  vai.ia — Core Data Backfill Script       ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`\nSupabase URL: ${SUPABASE_URL}`);
  console.log(`Root dir:     ${ROOT_DIR}`);
  console.log(`Batch size:   ${BATCH_SIZE}`);

  // ── Verify Supabase connectivity ──────────────────────────────────────────
  console.log('\n── Connectivity check ──────────────────────');
  const { error: pingError } = await supabase
    .from('tenants')
    .select('count', { count: 'exact', head: true });

  if (pingError) {
    // If the table doesn't exist yet, the error code is 42P01.
    if (pingError.code === '42P01') {
      console.error('\n[FATAL] The "tenants" table does not exist in Supabase.');
      console.error('Run the migration first:');
      console.error('  supabase/migrations/001_core_saas_schema.sql');
      process.exit(1);
    }
    console.error(`\n[FATAL] Cannot connect to Supabase: ${pingError.message}`);
    process.exit(1);
  }
  ok('Supabase connection OK');

  // ── Backfill tenants ──────────────────────────────────────────────────────
  const tenantResult = await backfillTenants();

  // ── Fetch post-backfill tenant slugs for FK validation ───────────────────
  const existingSlugs = await fetchExistingTenantSlugs();
  log(`\nTenant slugs now in Supabase: ${existingSlugs.size}`);

  // ── Backfill appointments ─────────────────────────────────────────────────
  const apptResult = await backfillAppointments(existingSlugs);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  BACKFILL SUMMARY                         ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');
  console.log('TENANTS');
  console.log(`  Files found:       ${tenantResult.found}`);
  console.log(`  Upserted:          ${tenantResult.upserted}`);
  console.log(`  Failed / skipped:  ${tenantResult.failed}`);
  console.log('');
  console.log('APPOINTMENTS');
  console.log(`  Files found:       ${apptResult.filesFound}`);
  console.log(`  Records found:     ${apptResult.totalFound}`);
  console.log(`  Upserted:          ${apptResult.upserted}`);
  console.log(`  Failed / skipped:  ${apptResult.failed}`);
  console.log('');

  const overallFailed = tenantResult.failed + apptResult.failed;
  if (overallFailed > 0) {
    console.log(`⚠  ${overallFailed} record(s) failed or were skipped. Review the errors above.`);
    console.log('   The script is safe to re-run after fixing the source data.');
  } else {
    console.log('✓  All records processed successfully.');
  }
  console.log('');

  // Exit with non-zero code only if ALL tenant upserts failed (catastrophic).
  // Partial failures are logged but do not block further use.
  if (tenantResult.found > 0 && tenantResult.upserted === 0 && tenantResult.failed > 0) {
    console.error('[FATAL] Zero tenants were upserted. Check Supabase connectivity and table schema.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n[FATAL] Unhandled error in backfill script:', e.message);
  console.error(e.stack);
  process.exit(1);
});
