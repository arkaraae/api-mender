type LeadEnv = { LEADS_DB_URL?: string; LEADS_DB_SECRET_KEY?: string };
export async function handleLeadRequest(request: Request, env: LeadEnv = {}): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, {status, headers:{'Cache-Control':'no-store'}});
  if (request.method !== 'POST') return json({error:'Method not allowed'},405);
  if (request.headers.get('origin') && request.headers.get('origin') !== new URL(request.url).origin) return json({error:'Forbidden'},403);
  if (!request.headers.get('content-type')?.includes('application/json')) return json({error:'JSON required'},415);
  const text = await request.text();
  if (text.length > 6000) return json({error:'Request too large'},413);
  let body;
  try { body = JSON.parse(text); } catch { return json({error:'Invalid request'},400); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({error:'Invalid request'},400);
  if (body.website) return json({error:'Invalid request'},400);
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || body.consent !== true || !['early','partner'].includes(body.intent) || !['landing','demo'].includes(body.source)) return json({error:'Invalid request'},400);
  for (const [key, limit] of [['name',100],['company',120],['apis',500]] as const) if (body[key] != null && (typeof body[key] !== 'string' || body[key].length > limit)) return json({error:'Invalid request'},400);
  const url = env.LEADS_DB_URL || process.env['LEADS_DB_URL'];
  const key = env.LEADS_DB_SECRET_KEY || process.env['LEADS_DB_SECRET_KEY'];
  if (!url || !key) return json({error:'Signups are not configured'},503);
  try {
    const response = await fetch(`${url.replace(/\/$/,'')}/rest/v1/website_leads?on_conflict=email,intent`, {
      method:'POST', headers:{apikey:key,'Content-Type':'application/json',Prefer:'resolution=ignore-duplicates,return=minimal'},
      body:JSON.stringify({email,intent:body.intent,source:body.source,name:body.name?.trim() || null,company:body.company?.trim() || null,apis:body.apis?.trim() || null,consent_version:'product-follow-up-v1'}), signal:AbortSignal.timeout(10000),
    });
    if (!response.ok) return json({error:'Unable to save request'},502);
    return json({saved:true});
  } catch { return json({error:'Unable to save request'},502); }
}
