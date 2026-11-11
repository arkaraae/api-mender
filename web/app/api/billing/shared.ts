import { authenticatedEditor } from '@/lib/github-onboarding';

export const noStore = { 'Cache-Control': 'no-store' };
export const reply = (status: number, error: string) => Response.json({ error }, { status, headers: noStore });

/** Only a workspace owner changes billing. */
export async function authenticatedOwner(request: Request, workspaceId: string) {
  const identity = await authenticatedEditor(request, workspaceId);
  if (!identity) return null;
  const { data } = await identity.client.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', identity.user.id).maybeSingle();
  return data?.role === 'owner' ? identity : null;
}
