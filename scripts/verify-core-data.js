#!/usr/bin/env node
// scripts/verify-core-data.js
//
// Compares local JSON files against Supabase row counts.
// Prints PASS/FAIL per tenant and a final overall result.
// Does NOT modify anything — read-only.
//
// USAGE:
//   SUPABASE_URL=https://xxx.supabase.co \
//   SUPABASE_SERVICE_KEY=eyJ... \
//   node scripts/verify-core-data.js
//
// Or via package.json:
//   npm run db:verify

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
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TENANTS_DIR      = path.join(ROOT_DIR, 'tenants');
const APPOINTMENTS_DIR = path.join(ROOT_DIR, 'appointments');

// ─── SLUG VALIDATION (identical to index.js:84) ──────────────────────────────
function validateSlug(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  if (!/^[a-z0-9-]{1,60}$/.test(s)) return null;
  return s;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Track overall pass/fail state
let anyFail = false;
function pass(label, detail = '') {
  console.log(`  PASS  ${label}${detail ? '  (' + detail + ')' : ''}`);
}
function fail(label, detail = '') {
  console.log(`  FAIL  ${label}${detail ? '  (' + detail + ')' : ''}`);
  anyFail = true;
}
function info(msg) {
  console.log(`        ${msg}`);
}

// ─── LOCAL DATA READERS ───────────────────────────────────────────────────────

async function readLocalTenants() {
  const map = new Map(); // slug → tenant data
  let files;
  try {
    files = await fs.readdir(TENANTS_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return map;
    throw e;
  }

  for (const f of files.filter(f => f.endsWith('.json'))) {
    const slug = validateSlug(f.replace(/\.json$/, ''));
    if (!slug) continue;
    try {
      const raw  = await fs.readFile(path.join(TENANTS_DIR, f), 'utf8');
      const data = JSON.parse(raw);
      map.set(slug, data);
    } catch {
      // Silently skip malformed files in verify — backfill would have logged them.
    }
  }
  return map;
}

async function readLocalAppointments() {
  const map = new Map(); // slug → appointment[]
  let files;
  try {
    files = await fs.readdir(APPOINTMENTS_DIR);
  } catch (e) {
    if (e.code === 'ENOENT') return map;
    throw e;
  }

  for (const f of files.filter(f => f.endsWith('.json'))) {
    const slug = validateSlug(f.replace(/\.json$/, ''));
    if (!slug) continue;
    try {
      const raw  = await fs.readFile(path.join(APPOINTMENTS_DIR, f), 'utf8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        map.set(slug, data);
      }
    } catch {
      // Skip silently.
    }
  }
  return map;
}

// ─── SUPABASE READERS ─────────────────────────────────────────────────────────

async function fetchSupabaseTenantSlugs() {
  // Paginate to avoid Supabase JS client's default 1000-row cap.
  const PAGE = 1000;
  const all  = [];
  let from   = 0;

  for (;;) {
    const { data, error } = await supabase
      .from('tenants')
      .select('slug')
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`Supabase tenants query failed: ${error.message}`);

    const rows = data ?? [];
    all.push(...rows);

    if (rows.length < PAGE) break;   // last page
    from += PAGE;
  }

  return new Set(all.map(r => r.slug));
}

async function fetchSupabaseAppointmentCounts() {
  // Fetch all appointment rows, paginating to avoid the 1000-row default cap.
  // We select only (id, tenant_slug) — minimal payload — and group in JS.
  // Supabase JS client doesn't support GROUP BY directly.
  // For datasets >100k rows, replace with a Supabase RPC that returns
  // pre-aggregated counts.
  const PAGE   = 1000;
  const counts = new Map(); // slug → count
  let from     = 0;

  for (;;) {
    const { data, error } = await supabase
      .from('appointments')
      .select('id, tenant_slug')
      .order('tenant_slug')
      .range(from, from + PAGE - 1);

    if (error) throw new Error(`Supabase appointments query failed: ${error.message}`);

    const rows = data ?? [];
    for (const row of rows) {
      counts.set(row.tenant_slug, (counts.get(row.tenant_slug) ?? 0) + 1);
    }

    if (rows.length < PAGE) break;   // last page
    from += PAGE;
  }

  return counts;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║  vai.ia — Core Data Verification Script   ║');
  console.log('╚═══════════════════════════════════════════╝');
  console.log(`\nSupabase URL: ${SUPABASE_URL}`);
  console.log(`Root dir:     ${ROOT_DIR}`);

  // ── Verify Supabase connectivity ──────────────────────────────────────────
  console.log('\n── Connectivity ────────────────────────────');
  try {
    const { error } = await supabase
      .from('tenants')
      .select('count', { count: 'exact', head: true });
    if (error) {
      if (error.code === '42P01') {
        fail('tenants table exists in Supabase', 'table not found — run migration first');
        process.exit(1);
      }
      throw new Error(error.message);
    }
    pass('Supabase connection OK');
  } catch (e) {
    fail('Supabase connection', e.message);
    process.exit(1);
  }

  // ── Load local data ───────────────────────────────────────────────────────
  console.log('\n── Reading local files ─────────────────────');
  const localTenants      = await readLocalTenants();
  const localAppointments = await readLocalAppointments();

  console.log(`  Local tenants found:      ${localTenants.size}`);
  console.log(`  Local appointment files:  ${localAppointments.size}`);

  let totalLocalAppts = 0;
  for (const [, appts] of localAppointments) totalLocalAppts += appts.length;
  console.log(`  Local appointments total: ${totalLocalAppts}`);

  // ── Load Supabase data ────────────────────────────────────────────────────
  console.log('\n── Reading Supabase ────────────────────────');
  let supabaseTenantSlugs, supabaseApptCounts;
  try {
    supabaseTenantSlugs = await fetchSupabaseTenantSlugs();
    supabaseApptCounts  = await fetchSupabaseAppointmentCounts();
  } catch (e) {
    fail('Supabase data fetch', e.message);
    process.exit(1);
  }

  let totalSupabaseAppts = 0;
  for (const [, count] of supabaseApptCounts) totalSupabaseAppts += count;

  console.log(`  Supabase tenants:         ${supabaseTenantSlugs.size}`);
  console.log(`  Supabase appointments:    ${totalSupabaseAppts}`);

  // ── CHECK 1: Tenant count ─────────────────────────────────────────────────
  console.log('\n── Check 1: Tenant counts ──────────────────');
  if (localTenants.size === 0) {
    info('No local tenant files found — skipping tenant count check');
  } else if (supabaseTenantSlugs.size >= localTenants.size) {
    pass(
      `Tenant count`,
      `local=${localTenants.size}, supabase=${supabaseTenantSlugs.size}`
    );
  } else {
    fail(
      `Tenant count mismatch`,
      `local=${localTenants.size}, supabase=${supabaseTenantSlugs.size} — missing ${localTenants.size - supabaseTenantSlugs.size} tenant(s)`
    );
  }

  // ── CHECK 2: Each local tenant exists in Supabase ─────────────────────────
  console.log('\n── Check 2: Per-tenant existence ───────────');
  let missingTenants = 0;
  for (const [slug] of localTenants) {
    if (supabaseTenantSlugs.has(slug)) {
      pass(`Tenant "${slug}" exists in Supabase`);
    } else {
      fail(`Tenant "${slug}" MISSING from Supabase`);
      missingTenants++;
    }
  }
  if (localTenants.size === 0) {
    info('No local tenants to check');
  }

  // ── CHECK 3: Appointment count (total) ────────────────────────────────────
  console.log('\n── Check 3: Appointment counts (total) ─────');
  if (totalLocalAppts === 0) {
    info('No local appointments found — skipping appointment count checks');
  } else if (totalSupabaseAppts >= totalLocalAppts) {
    pass(
      `Total appointment count`,
      `local=${totalLocalAppts}, supabase=${totalSupabaseAppts}`
    );
  } else {
    fail(
      `Total appointment count mismatch`,
      `local=${totalLocalAppts}, supabase=${totalSupabaseAppts} — ${totalLocalAppts - totalSupabaseAppts} missing`
    );
  }

  // ── CHECK 4: Per-tenant appointment counts ────────────────────────────────
  console.log('\n── Check 4: Per-tenant appointment counts ──');
  let mismatches = 0;
  const allAppointmentSlugs = new Set([
    ...localAppointments.keys(),
    ...supabaseApptCounts.keys(),
  ]);

  if (allAppointmentSlugs.size === 0) {
    info('No appointments to compare');
  } else {
    for (const slug of [...allAppointmentSlugs].sort()) {
      const localCount    = localAppointments.get(slug)?.length ?? 0;
      const supabaseCount = supabaseApptCounts.get(slug) ?? 0;
      const detail        = `local=${localCount}, supabase=${supabaseCount}`;

      if (supabaseCount >= localCount) {
        pass(`"${slug}" appointments`, detail);
      } else {
        fail(`"${slug}" appointments MISMATCH`, detail + ` — ${localCount - supabaseCount} missing`);
        mismatches++;
      }
    }
  }

  // ── CHECK 5: Supabase tenants with no local file (expected after new tenants created via app) ──
  console.log('\n── Check 5: Supabase-only tenants (informational) ──');
  const supabaseOnlyTenants = [...supabaseTenantSlugs].filter(s => !localTenants.has(s));
  if (supabaseOnlyTenants.length === 0) {
    info('None — all Supabase tenants have corresponding local files');
  } else {
    for (const slug of supabaseOnlyTenants) {
      info(`"${slug}" exists in Supabase but has no local JSON file (created via app after backfill — expected)`);
    }
  }

  // ── FINAL RESULT ──────────────────────────────────────────────────────────
  console.log('\n╔═══════════════════════════════════════════╗');
  if (!anyFail) {
    console.log('║  RESULT: PASS ✓                            ║');
  } else {
    console.log('║  RESULT: FAIL ✗                            ║');
  }
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');

  if (anyFail) {
    console.log('Action required:');
    if (missingTenants > 0) {
      console.log(`  - ${missingTenants} tenant(s) missing from Supabase → re-run: npm run db:backfill`);
    }
    if (mismatches > 0) {
      console.log(`  - ${mismatches} tenant(s) have fewer appointments in Supabase than local files`);
      console.log('    → re-run: npm run db:backfill');
    }
    console.log('');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('\n[FATAL] Unhandled error in verify script:', e.message);
  console.error(e.stack);
  process.exit(1);
});
