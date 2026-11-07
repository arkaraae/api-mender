// POST { name, email, company, apis, message } from the pricing page's "Contact sales" form.
import { env, waitUntil } from 'cloudflare:workers';
import { spend } from '@/lib/mender/limits.js';
import { notifySales, readSalesRequest, saveSalesRequest } from '@/lib/mender/sales.js';
import { siteDatabase } from '@/lib/watch-store';

const reply = (status: number, body: object) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(request: Request) {
  const db = siteDatabase();
  if (!db) return reply(503, { error: 'Contact sales is not set up on this deployment.' });
  if (Number(request.headers.get('content-length') || 0) > 16_384) return reply(413, { error: 'That message is too long.' });
  let input: unknown;
  try { input = await request.json(); } catch { return reply(400, { error: 'Send the form as JSON.' }); }
  const read = readSalesRequest(input);
  if (read.problems) return reply(422, { error: read.problems[0].message, problems: read.problems });
  // A robot filled the hidden field: answer as if it worked, keep nothing.
  if (read.robot) return reply(201, { received: true });
  const refused = await spend(db, request, 'sales');
  if (refused) return refused;
  try {
    await saveSalesRequest(db, read.request);
  } catch (error) {
    console.error('A sales request could not be saved:', error);
    return reply(503, { error: 'Your message could not be saved. Please try again in a minute.' });
  }
  if (env.SALES_WEBHOOK) waitUntil(notifySales(env.SALES_WEBHOOK, read.request).catch((error) => console.error('Sales webhook failed:', error)));
  return reply(201, { received: true });
}
