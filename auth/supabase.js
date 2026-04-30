import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export async function findAdminByEmail(email) {
  const { data, error } = await supabase
    .from('admin_users').select('*')
    .eq('email', email.toLowerCase().trim()).single();
  if (error && error.code !== 'PGRST116') console.error('[SUPABASE]', error.message);
  return data || null;
}

export async function findClientByEmail(email) {
  const { data, error } = await supabase
    .from('client_users').select('*')
    .eq('email', email.toLowerCase().trim()).single();
  if (error && error.code !== 'PGRST116') console.error('[SUPABASE]', error.message);
  return data || null;
}

export default supabase;
