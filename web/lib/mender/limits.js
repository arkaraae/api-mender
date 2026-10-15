// Daily limits on everything a visitor can do that uses storage: starting a watch, checking one
// now, creating a test server, asking sales to get in touch. Each is counted per visitor and for
// the whole site, per day (UTC), in anything with the D1 methods.
//
// The site-wide numbers keep watches and test servers inside 1,000 storage saves a day, the
// Workers KV allowance on Cloudflare's free plan: 80 watches × 2 + 80 test servers × 2 + 100
// checks + at most 480 saves by the hourly check = 900. Test servers also share 60 MB of new
// descriptions a day; the same description used again costs nothing (see mock.js).
//
// A visitor is a hash of the day and the address the request came from, so the address itself
// is never stored and one day's counts can't be linked to the next.

export const LIMITS = {
  watch: { visitor: 10, site: 80 },
  check: { visitor: 30, site: 100 },
  mock: { visitor: 10, site: 80 },
  mockBytes: { site: 60 * 1024 * 1024 },
  sales: { visitor: 3, site: 50 },
};

const NAMES = { watch: 'watches started', check: 'checks', mock: 'test servers', mockBytes: 'new descriptions in test servers', sales: 'messages to sales' };

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

async function visitorOf(request, day) {
  const address = request.headers.get('cf-connecting-ip') ?? 'local';
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}|${address}`)));
  return [...digest.slice(0, 12)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const secondsToMidnight = (now) => Math.max(1, Math.ceil((Date.parse(`${dayOf(now)}T00:00:00Z`) + 86_400_000 - now) / 1000));

// spend(db, request, action, { amount }) → null when allowed, or a 429 Response when this visitor
// or the whole site is over today's limit. Refused attempts count too. Without a database (the
// team's deployment) nothing is limited; if the database fails, the request is allowed.
export async function spend(db, request, action, { amount = 1, now = Date.now(), limits = LIMITS } = {}) {
  const limit = limits[action];
  if (!db || !limit) return null;
  const day = dayOf(now);
  const add = db.prepare('INSERT INTO daily_counts (day, bucket, count) VALUES (?1, ?2, ?3) ON CONFLICT (day, bucket) DO UPDATE SET count = count + excluded.count RETURNING count');
  const buckets = [];
  if (limit.visitor) buckets.push([`${action}:${await visitorOf(request, day)}`, 1, limit.visitor]);
  if (limit.site) buckets.push([action, amount, limit.site]);
  let counts;
  try {
    counts = (await db.batch(buckets.map(([bucket, amount]) => add.bind(day, bucket, amount)))).map((result) => result.results[0].count);
  } catch (error) {
    console.error('Daily limits could not be counted:', error);
    return null;
  }
  const over = buckets.findIndex(([, , max], i) => counts[i] > max);
  if (over === -1) return null;
  const message = limit.visitor && over === 0
    ? `You have reached today's limit of ${limit.visitor} ${NAMES[action]}. It resets at midnight UTC.`
    : `API Mender has reached today's limit for ${NAMES[action]}. It resets at midnight UTC.`;
  return Response.json({ error: message }, { status: 429, headers: { 'retry-after': String(secondsToMidnight(now)), 'cache-control': 'no-store' } });
}

// Counts older than two days are no longer needed; the hourly run removes them.
export const forgetOldCounts = (db, now = Date.now()) => db.prepare('DELETE FROM daily_counts WHERE day < ?1').bind(dayOf(now - 2 * 86_400_000)).run();
