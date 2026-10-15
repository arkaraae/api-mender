// Finds adapter rules on request. Send either two API descriptions or example records:
//   POST { "oldSpec": {...}, "newSpec": {...} }      → rules, notes and a proof from generated samples
//   POST { "pairs": [{ "old": {...}, "new": {...} }] } → rules and notes from real records
// Large descriptions are better checked in the browser at /check, which runs the same engine.
import { explain } from '@/lib/mender-site';

const LIMIT = 1_000_000;

export async function POST(request: Request) {
  const text = await request.text();
  if (text.length > LIMIT) return Response.json({ error: 'Send at most 1 MB here. Larger descriptions can be checked at /check.' }, { status: 413 });
  let input: unknown;
  try { input = JSON.parse(text); } catch { return Response.json({ error: 'The body must be JSON.' }, { status: 400 }); }
  let result;
  try { result = explain(input); } catch (error) { return Response.json({ error: `Mender could not read that: ${error instanceof Error ? error.message : error}` }, { status: 422 }); }
  if (!result) return Response.json({ error: 'Send { "oldSpec", "newSpec" } or { "pairs": [{ "old", "new" }] }.' }, { status: 400 });
  return Response.json(result, { headers: { 'cache-control': 'no-store' } });
}
