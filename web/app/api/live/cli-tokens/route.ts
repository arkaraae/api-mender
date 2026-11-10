import { authenticatedEditor, onboardingDatabase, sha256, uuid } from '@/lib/github-onboarding';
import { readBoundedBody } from '@/lib/github-app';
import { REPORT_FIELD_GROUPS } from '@/lib/engine/boundary';

const noStore = { 'Cache-Control': 'no-store' };
const reply = (status: number, body: object) => Response.json(body, { status, headers: noStore });

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `mdr_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

/**
 * Create (`action: 'create'`) or revoke (`action: 'revoke'`) a CLI report
 * token. The token is returned once and only its SHA-256 is stored. Each
 * token lists the metadata field groups it may send.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown> | null;
  try { body = JSON.parse(new TextDecoder().decode(await readBoundedBody(request, 2048))); }
  catch { return reply(400, { error: 'Invalid request' }); }
  if (!body || typeof body.workspaceId !== 'string' || !uuid.test(body.workspaceId)) return reply(400, { error: 'Invalid request' });
  const identity = await authenticatedEditor(request, body.workspaceId);
  if (!identity) return reply(403, { error: 'Workspace editor sign-in required' });
  const database = onboardingDatabase();
  if (body.action === 'revoke') {
    if (typeof body.id !== 'string' || !uuid.test(body.id)) return reply(400, { error: 'Invalid token id' });
    const { data, error } = await database.from('cli_tokens').update({ revoked_at: new Date().toISOString() })
      .eq('id', body.id).eq('workspace_id', body.workspaceId).is('revoked_at', null).select('id').maybeSingle();
    if (error) return reply(502, { error: 'Could not revoke the token' });
    if (data) await database.from('audit_events').insert({ workspace_id: body.workspaceId, actor_type: 'user',
      actor_id: identity.user.id, action: 'cli_token.revoked', target: body.id });
    return reply(200, { revoked: !!data });
  }
  if (body.action !== 'create' || typeof body.name !== 'string' || !/^[\w .-]{1,80}$/.test(body.name)
    || !Array.isArray(body.allowedFields) || body.allowedFields.length > REPORT_FIELD_GROUPS.length
    || body.allowedFields.some(field => !(REPORT_FIELD_GROUPS as readonly unknown[]).includes(field)))
    return reply(400, { error: 'Give a name and a subset of: ' + REPORT_FIELD_GROUPS.join(', ') });
  const token = newToken();
  const { data, error } = await database.from('cli_tokens').insert({ workspace_id: body.workspaceId, name: body.name,
    token_sha256: await sha256(token), allowed_fields: [...new Set(body.allowedFields as string[])], created_by: identity.user.id })
    .select('id').single();
  if (error || !data) return reply(502, { error: 'Could not create the token' });
  await database.from('audit_events').insert({ workspace_id: body.workspaceId, actor_type: 'user', actor_id: identity.user.id,
    action: 'cli_token.created', target: data.id, detail: { allowedFields: body.allowedFields } });
  return reply(201, { id: data.id, token, note: 'Shown once. Set it as MENDER_REPORT_TOKEN where the CLI runs.' });
}
