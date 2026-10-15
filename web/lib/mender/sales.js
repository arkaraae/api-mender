// "Contact sales" from the pricing page: checked, saved in D1, and posted to the team's Slack or
// Discord when the site has a SALES_WEBHOOK secret. Read them with:
//
//   npx wrangler d1 execute apimender --remote --env apimender --command "SELECT * FROM sales_requests ORDER BY id DESC"

export const API_COUNTS = ['1', '2–5', '6–20', 'More than 20'];

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

const text = (value, max) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

// readSalesRequest(input) → { request } or { problems: [{ field, message }] }. `website` is a
// field people never see; a value there means a robot filled the form.
export function readSalesRequest(input) {
  const value = input && typeof input === 'object' ? input : {};
  const request = {
    name: text(value.name, 100),
    email: text(value.email, 200).toLowerCase(),
    company: text(value.company, 120),
    apis: API_COUNTS.includes(value.apis) ? value.apis : '',
    message: typeof value.message === 'string' ? value.message.trim().slice(0, 2000) : '',
  };
  const problems = [];
  if (!request.name) problems.push({ field: 'name', message: 'Enter your name.' });
  if (!EMAIL.test(request.email)) problems.push({ field: 'email', message: 'Enter a work email address.' });
  if (!request.company) problems.push({ field: 'company', message: 'Enter your company.' });
  if (!request.apis) problems.push({ field: 'apis', message: 'Choose how many APIs you run.' });
  return problems.length ? { problems } : { request, robot: Boolean(text(value.website, 200)) };
}

export async function saveSalesRequest(db, request, { now = Date.now() } = {}) {
  await db
    .prepare('INSERT INTO sales_requests (created_at, name, email, company, apis, message) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(new Date(now).toISOString(), request.name, request.email, request.company, request.apis, request.message)
    .run();
}

// Slack reads "text", Discord reads "content"; each ignores the other.
export async function notifySales(webhook, request, fetcher = fetch) {
  const text = `New sales request: ${request.name} <${request.email}> at ${request.company} (${request.apis} API${request.apis === '1' ? '' : 's'})${request.message ? `\n> ${request.message.slice(0, 500)}` : ''}`;
  await fetcher(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }), signal: AbortSignal.timeout(10_000) });
}
