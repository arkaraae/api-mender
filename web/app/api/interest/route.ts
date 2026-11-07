import { createClient } from '@supabase/supabase-js';
import { env } from 'cloudflare:workers';
import { spend } from '@/lib/mender/limits.js';
import { readInterestRequest, saveInterestRequest } from '@/lib/mender/interest.js';
import { siteDatabase } from '@/lib/watch-store';

const reply = (status: number, body: object) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(request: Request) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SECRET_KEY;
  if (!url || !key) return reply(503, { error: 'The interest list is not available right now.' });
  if (Number(request.headers.get('content-length') || 0) > 8_192) return reply(413, { error: 'That message is too long.' });
  let input: unknown;
  try { input = await request.json(); } catch { return reply(400, { error: 'Send the form as JSON.' }); }
  const read = readInterestRequest(input);
  if (read.problems) return reply(422, { error: read.problems[0].message, problems: read.problems });
  // Accept spam-filled hidden fields without saving them.
  if (read.robot) return reply(201, { received: true });
  const refused = await spend(siteDatabase(), request, 'interest');
  if (refused) return refused;
  try {
    const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    await saveInterestRequest(supabase, read.request);
  } catch (error) {
    console.error('An interest signup could not be saved:', error);
    return reply(503, { error: 'We could not save your details. Please try again in a minute.' });
  }
  return reply(201, { received: true });
}
