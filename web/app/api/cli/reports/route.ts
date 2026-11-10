import { env } from 'cloudflare:workers';
import { backendAdmin } from '@/lib/backend-admin';
import { readBoundedBody } from '@/lib/github-app';
import { sha256 } from '@/lib/github-onboarding';
import { isReportRejection, validateMetadataReport } from '@/lib/engine/boundary';

const noStore = { 'Cache-Control': 'no-store' };
const reply = (status: number, body: object) => Response.json(body, { status, headers: noStore });

/**
 * Customer-managed mode: the ONLY route that receives data from the Mender
 * CLI. It accepts the metadata report defined in lib/engine/boundary.ts and
 * nothing else: unknown fields, source text, diffs or check output fail
 * validation and are not stored. A token may only send the field groups it
 * was created with.
 */
export async function POST(request: Request) {
  const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  if (!token) return reply(401, { error: 'CLI token required' });
  if (!/^application\/json(;|$)/.test(request.headers.get('content-type') ?? '')) return reply(415, { error: 'JSON required' });
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readBoundedBody(request, 128 * 1024))); }
  catch { return reply(400, { error: 'Invalid or oversized report' }); }
  const database = backendAdmin(env);
  const { data: cliToken, error } = await database.from('cli_tokens')
    .select('id,workspace_id,allowed_fields,revoked_at').eq('token_sha256', await sha256(token)).maybeSingle();
  if (error) return reply(502, { error: 'Could not check the token' });
  if (!cliToken || cliToken.revoked_at) return reply(401, { error: 'CLI token required' });
  let report;
  try { report = validateMetadataReport(raw); }
  catch (cause) {
    // The validator names the offending path, never the offending value.
    return reply(422, { error: isReportRejection(cause) ? cause.message : 'Report rejected' });
  }
  const extra = report.fields.filter(field => !cliToken.allowed_fields.includes(field));
  if (extra.length) return reply(403, { error: `This token is not allowed to send: ${extra.join(', ')}` });
  const { data: saved, error: insertError } = await database.from('cli_reports').insert({
    workspace_id: cliToken.workspace_id, token_id: cliToken.id, repository_label: report.repositoryLabel,
    commit_sha: report.commitSha, cli_version: report.cliVersion, report,
  }).select('id').single();
  if (insertError || !saved) return reply(502, { error: 'Could not save the report' });
  await database.from('cli_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', cliToken.id);
  await database.from('audit_events').insert({ workspace_id: cliToken.workspace_id, actor_type: 'cli_token',
    actor_id: cliToken.id, action: 'cli_report.received', target: saved.id,
    detail: { fields: report.fields, findings: report.findings?.length ?? 0 } });
  return reply(201, { id: saved.id });
}
