// auth/ambassadors.js
// Ambassador CRUD functions using Supabase PostgreSQL.
// All three tables (ambassadors, ambassador_clients, ambassador_applications)
// are expected to exist in the Supabase project. Schema is defined below as a comment.
//
// Required Supabase tables:
//
// CREATE TABLE ambassadors (
//   id               BIGSERIAL PRIMARY KEY,
//   ambassador_id    TEXT UNIQUE NOT NULL,   -- e.g. "AMB-0001"
//   name             TEXT NOT NULL,
//   email            TEXT UNIQUE NOT NULL,
//   password_hash    TEXT NOT NULL,
//   phone            TEXT,
//   city             TEXT,
//   state            TEXT,
//   country          TEXT DEFAULT 'USA',
//   username         TEXT,
//   referral_code    TEXT UNIQUE,
//   setup_commission_pct   NUMERIC DEFAULT 10,
//   monthly_commission_pct NUMERIC DEFAULT 10,
//   bonus_commission_pct   NUMERIC DEFAULT 0,
//   status           TEXT DEFAULT 'active',  -- 'active' | 'inactive' | 'suspended'
//   created_at       TIMESTAMPTZ DEFAULT now()
// );
//
// CREATE TABLE ambassador_clients (
//   id               BIGSERIAL PRIMARY KEY,
//   ambassador_id    BIGINT REFERENCES ambassadors(id) ON DELETE CASCADE,
//   business_name    TEXT NOT NULL,
//   contact_name     TEXT,
//   phone            TEXT,
//   email            TEXT,
//   business_type    TEXT,
//   notes            TEXT,
//   requested_plan   TEXT,
//   estimated_monthly NUMERIC DEFAULT 0,
//   status           TEXT DEFAULT 'Lead',
//   setup_fee        NUMERIC DEFAULT 0,
//   setup_fee_paid   BOOLEAN DEFAULT false,
//   monthly_price    NUMERIC DEFAULT 0,
//   monthly_paid     BOOLEAN DEFAULT false,
//   setup_commission_paid   BOOLEAN DEFAULT false,
//   monthly_commission_paid BOOLEAN DEFAULT false,
//   slug             TEXT,
//   twilio_number    TEXT,
//   created_at       TIMESTAMPTZ DEFAULT now()
// );
//
// CREATE TABLE ambassador_applications (
//   id               BIGSERIAL PRIMARY KEY,
//   name             TEXT NOT NULL,
//   email            TEXT NOT NULL,
//   phone            TEXT,
//   age              TEXT,
//   city_state       TEXT,
//   has_sales_exp    BOOLEAN DEFAULT false,
//   reason           TEXT,
//   strategy         TEXT,
//   knows_owners     BOOLEAN DEFAULT false,
//   social_link      TEXT,
//   notes            TEXT,
//   status           TEXT DEFAULT 'pending',  -- 'pending' | 'approved' | 'rejected'
//   admin_notes      TEXT,
//   created_at       TIMESTAMPTZ DEFAULT now()
// );

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── AMBASSADORS ─────────────────────────────────────────────────────────────

export async function findAmbassadorByEmail(email) {
  const { data, error } = await supabase
    .from('ambassadors')
    .select('*')
    .eq('email', String(email).toLowerCase().trim())
    .single();
  if (error && error.code !== 'PGRST116') console.error('[AMB] findByEmail:', error.message);
  return data || null;
}

export async function findAmbassadorById(id) {
  const { data, error } = await supabase
    .from('ambassadors')
    .select('*')
    .eq('id', id)
    .single();
  if (error && error.code !== 'PGRST116') console.error('[AMB] findById:', error.message);
  return data || null;
}

export async function getAllAmbassadors() {
  const { data, error } = await supabase
    .from('ambassadors')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[AMB] getAllAmbassadors:', error.message);
    return [];
  }
  return data || [];
}

export async function createAmbassador(fields) {
  const { data, error } = await supabase
    .from('ambassadors')
    .insert([fields])
    .select()
    .single();
  if (error) {
    console.error('[AMB] createAmbassador:', error.message);
    throw new Error(error.message);
  }
  return data;
}

export async function updateAmbassador(id, fields) {
  // Remove undefined values to avoid overwriting with null
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const { data, error } = await supabase
    .from('ambassadors')
    .update(clean)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    console.error('[AMB] updateAmbassador:', error.message);
    throw new Error(error.message);
  }
  return data;
}

export async function deleteAmbassador(id) {
  const { error } = await supabase
    .from('ambassadors')
    .delete()
    .eq('id', id);
  if (error) {
    console.error('[AMB] deleteAmbassador:', error.message);
    throw new Error(error.message);
  }
  return true;
}

// ─── AMBASSADOR CLIENTS ───────────────────────────────────────────────────────

export async function getAmbassadorClients(ambassadorId) {
  let query = supabase.from('ambassador_clients').select('*');
  // If ambassadorId is null, return ALL clients (admin view).
  // If ambassadorId is provided, filter to that ambassador only.
  if (ambassadorId !== null && ambassadorId !== undefined) {
    query = query.eq('ambassador_id', ambassadorId);
  }
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) {
    console.error('[AMB] getAmbassadorClients:', error.message);
    return [];
  }
  return data || [];
}

export async function createAmbassadorClient(fields) {
  const { data, error } = await supabase
    .from('ambassador_clients')
    .insert([fields])
    .select()
    .single();
  if (error) {
    console.error('[AMB] createAmbassadorClient:', error.message);
    throw new Error(error.message);
  }
  return data;
}

export async function updateAmbassadorClient(id, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const { data, error } = await supabase
    .from('ambassador_clients')
    .update(clean)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    console.error('[AMB] updateAmbassadorClient:', error.message);
    throw new Error(error.message);
  }
  return data;
}

// ─── AMBASSADOR APPLICATIONS ──────────────────────────────────────────────────

export async function getAllAmbassadorApplications() {
  const { data, error } = await supabase
    .from('ambassador_applications')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) {
    console.error('[AMB] getAllAmbassadorApplications:', error.message);
    return [];
  }
  return data || [];
}

export async function createAmbassadorApplication(fields) {
  const { data, error } = await supabase
    .from('ambassador_applications')
    .insert([fields])
    .select()
    .single();
  if (error) {
    console.error('[AMB] createAmbassadorApplication:', error.message);
    throw new Error(error.message);
  }
  return data;
}

export async function updateAmbassadorApplication(id, fields) {
  const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
  const { data, error } = await supabase
    .from('ambassador_applications')
    .update(clean)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    console.error('[AMB] updateAmbassadorApplication:', error.message);
    throw new Error(error.message);
  }
  return data;
}
