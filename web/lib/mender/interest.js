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

export async function saveInterestRequest(supabase, request) {
  const { error } = await supabase.rpc('save_interest_contact', {
    p_name: request.name,
    p_email: request.email,
    p_interest: request.interest,
    p_message: request.message,
  });
  if (error) throw error;
}
