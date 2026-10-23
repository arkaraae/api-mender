// A low-friction contact list for anyone interested in API Mender.
// Unlike the sales form, only name and email are required.

export const INTERESTS = ['use', 'collaborate', 'invest', 'feedback', 'other'];

const EMAIL = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;
const shortText = (value, max) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '');

export function readInterestRequest(input) {
  const value = input && typeof input === 'object' ? input : {};
  const interest = shortText(value.interest, 30);
  const request = {
    name: shortText(value.name, 100),
    email: shortText(value.email, 200).toLowerCase(),
    interest: INTERESTS.includes(interest) ? interest : '',
    message: typeof value.message === 'string' ? value.message.trim().slice(0, 1000) : '',
  };
  const problems = [];
  if (!request.name) problems.push({ field: 'name', message: 'Enter your name.' });
  if (!EMAIL.test(request.email)) problems.push({ field: 'email', message: 'Enter a valid email address.' });
  if (interest && !INTERESTS.includes(interest)) problems.push({ field: 'interest', message: 'Choose one of the listed interests.' });
  return problems.length ? { problems } : { request, robot: Boolean(shortText(value.website, 200)) };
}

export async function saveInterestRequest(db, request, { now = Date.now() } = {}) {
  const date = new Date(now).toISOString();
  await db.prepare(`INSERT INTO interest_contacts (created_at, updated_at, name, email, interest, message)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET updated_at = excluded.updated_at,
      name = excluded.name,
      interest = CASE WHEN excluded.interest != '' THEN excluded.interest ELSE interest_contacts.interest END,
      message = CASE WHEN excluded.message != '' THEN excluded.message ELSE interest_contacts.message END`)
    .bind(date, date, request.name, request.email, request.interest, request.message)
    .run();
}
