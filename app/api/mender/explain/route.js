// Finds adapter rules on request. Send either two API descriptions or example records:
//   POST { "oldSpec": {...}, "newSpec": {...} }      → rules, notes and a proof from generated samples
//   POST { "pairs": [{ "old": {...}, "new": {...} }] } → rules and notes from real records
import { explain } from '@/lib/mender-gateway.js';

export const dynamic = 'force-dynamic';
const LIMIT = 2_000_000;

export async function POST(request) {
  const text = await request.text();
  if (text.length > LIMIT) return Response.json({ error: 'Send at most 2 MB.' }, { status: 413 });
  let input;
  try { input = JSON.parse(text); } catch { return Response.json({ error: 'The body must be JSON.' }, { status: 400 }); }
  let result;
  try { result = explain(input); } catch (error) { return Response.json({ error: `Mender could not read that: ${error.message}` }, { status: 422 }); }
  if (!result) return Response.json({ error: 'Send { "oldSpec", "newSpec" } or { "pairs": [{ "old", "new" }] }.' }, { status: 400 });
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
}
