import { createClient } from '@supabase/supabase-js';

export function backendAdmin(config: { NEXT_PUBLIC_SUPABASE_URL?: string; SUPABASE_SECRET_KEY?: string }) {
  if (!config.NEXT_PUBLIC_SUPABASE_URL || !config.SUPABASE_SECRET_KEY) throw new Error('Backend database secret is not configured');
  return createClient(config.NEXT_PUBLIC_SUPABASE_URL, config.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
