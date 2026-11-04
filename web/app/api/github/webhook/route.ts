import { env } from 'cloudflare:workers';
import { backendAdmin } from '@/lib/backend-admin';
import { parsePushEvent, readBoundedBody, verifyWebhookSignature } from '@/lib/github-app';

export async function POST(request: Request) {
  const secret = env.GITHUB_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: 'Webhook is not configured' }, { status: 503 });
  if (Number(request.headers.get('content-length') || 0) > 1_000_000) return Response.json({ error: 'Payload too large' }, { status: 413 });
  let body: Uint8Array;
  try { body = await readBoundedBody(request); }
  catch { return Response.json({ error: 'Payload too large' }, { status: 413 }); }
  if (!await verifyWebhookSignature(body, request.headers.get('x-hub-signature-256'), secret)) return Response.json({ error: 'Invalid signature' }, { status: 401 });
  const delivery = request.headers.get('x-github-delivery');
  if (!delivery || !/^[a-f0-9-]{36}$/i.test(delivery)) return Response.json({ error: 'Invalid delivery ID' }, { status: 400 });
  let payload: unknown;
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
  catch { return Response.json({ error: 'Invalid payload' }, { status: 400 }); }
  const event = request.headers.get('x-github-event');
  const push = parsePushEvent(event, payload);
  const data = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
  if (event === 'installation' && ['suspend', 'unsuspend', 'deleted'].includes(data.action)
    && Number.isSafeInteger(data.installation?.id)) {
    try {
      const database = backendAdmin(env);
      const { error } = await database.from('github_installations')
        .update({ suspended_at: data.action === 'unsuspend' ? null : new Date().toISOString() })
        .eq('installation_id', data.installation.id);
      if (error) throw error;
      return Response.json({ accepted: true });
    } catch { return Response.json({ error: 'Could not update installation' }, { status: 503 }); }
  }
  if (event === 'installation_repositories' && data.action === 'removed'
    && Number.isSafeInteger(data.installation?.id) && Array.isArray(data.repositories_removed)) {
    const ids = data.repositories_removed.map((repo: any) => repo?.id);
    if (ids.length > 100 || ids.some((id: unknown) => !Number.isSafeInteger(id))) return Response.json({ error: 'Invalid repositories' }, { status: 400 });
    try {
      const database = backendAdmin(env);
      if (ids.length) {
        const { error } = await database.from('monitored_repositories').update({ paused: true })
          .eq('github_installation_id', data.installation.id).in('github_repo_id', ids);
        if (error) throw error;
      }
      return Response.json({ accepted: true });
    } catch { return Response.json({ error: 'Could not update repositories' }, { status: 503 }); }
  }
  if (!push) return Response.json({ accepted: false, reason: 'Event is outside the connected default branch' });
  try {
    const database = backendAdmin(env);
    const { data, error } = await database.rpc('enqueue_github_scan', {
      p_delivery_id: delivery, p_installation_id: push.installationId,
      p_github_repo_id: push.repositoryId, p_head_sha: push.head, p_event: 'push',
    });
    if (error) throw error;
    return Response.json({ accepted: data === true });
  } catch {
    // GitHub retries non-2xx deliveries; do not expose database details.
    return Response.json({ error: 'Could not enqueue scan' }, { status: 503 });
  }
}
