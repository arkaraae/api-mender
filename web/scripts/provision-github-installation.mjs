// Operator-only beta provisioning. Run with secrets in the shell environment;
// never paste a key into an issue, URL, repository file, or chat.
import { createClient } from '@supabase/supabase-js';
import { githubAppJwt, installationToken } from '../lib/github-app.ts';

const [workspaceId, fullName] = process.argv.slice(2);
const appId = process.env.GITHUB_APP_ID;
const privateKey = process.env.GITHUB_APP_PRIVATE_KEY;
const databaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const secret = process.env.SUPABASE_SECRET_KEY;
if (!/^[a-f0-9-]{36}$/.test(workspaceId || '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName || '')
  || !appId || !privateKey || !databaseUrl || !secret) {
  throw new Error('Usage: node scripts/provision-github-installation.mjs WORKSPACE_UUID owner/repo (with GitHub App and Supabase secrets in the environment)');
}
const config = { appId, privateKey };
const database = createClient(databaseUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: workspace, error: workspaceError } = await database.from('workspaces').select('id').eq('id', workspaceId).single();
if (workspaceError || !workspace) throw new Error('Workspace does not exist');

const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'api-mender-provision' };
const [owner, repoName] = fullName.split('/');
const installationResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/installation`, {
  headers: { ...headers, Authorization: `Bearer ${await githubAppJwt(config)}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
});
if (!installationResponse.ok) throw new Error(`The API Mender GitHub App is not installed on ${fullName} (${installationResponse.status})`);
const installation = await installationResponse.json();
if (!Number.isSafeInteger(installation.id) || typeof installation.account?.login !== 'string' || installation.suspended_at) throw new Error('Installation is unavailable');
const token = await installationToken(config, installation.id, repoName);
const repoResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`, {
  headers: { ...headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
});
if (!repoResponse.ok) throw new Error(`Repository is not accessible to the installation (${repoResponse.status})`);
const repository = await repoResponse.json();
if (repository.full_name?.toLowerCase() !== fullName.toLowerCase() || !Number.isSafeInteger(repository.id) || typeof repository.default_branch !== 'string' || repository.archived) throw new Error('Repository metadata is invalid');
const { data: existing, error: existingError } = await database.from('github_installations').select('workspace_id').eq('installation_id', installation.id).maybeSingle();
if (existingError) throw existingError;
if (existing && existing.workspace_id !== workspaceId) throw new Error('Installation is already bound to another workspace');
const { error: installError } = await database.from('github_installations').upsert({
  installation_id: installation.id, workspace_id: workspaceId, account_login: installation.account.login,
  suspended_at: null,
}, { onConflict: 'installation_id' });
if (installError) throw installError;
const { data: existingRepo, error: lookupError } = await database.from('monitored_repositories').select('id')
  .eq('workspace_id', workspaceId).eq('full_name', repository.full_name).eq('branch', repository.default_branch).maybeSingle();
if (lookupError) throw lookupError;
const changes = { visibility: repository.private ? 'private' : 'public', github_installation_id: installation.id,
  github_repo_id: repository.id, paused: false };
const write = existingRepo
  ? database.from('monitored_repositories').update(changes).eq('id', existingRepo.id)
  : database.from('monitored_repositories').insert({ workspace_id: workspaceId, full_name: repository.full_name,
    branch: repository.default_branch, ...changes });
const { error: repoError } = await write;
if (repoError) throw repoError;
const branchResponse = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/branches/${encodeURIComponent(repository.default_branch)}`, {
  headers: { ...headers, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(15_000),
});
if (!branchResponse.ok) throw new Error(`Could not read the default branch (${branchResponse.status})`);
const branch = await branchResponse.json();
if (typeof branch.commit?.sha !== 'string' || !/^[a-f0-9]{40}$/.test(branch.commit.sha)) throw new Error('Default branch SHA is invalid');
const { data: enqueued, error: enqueueError } = await database.rpc('enqueue_github_scan', {
  p_delivery_id: crypto.randomUUID(), p_installation_id: installation.id,
  p_github_repo_id: repository.id, p_head_sha: branch.commit.sha, p_event: 'push',
});
if (enqueueError || !enqueued) throw enqueueError || new Error('Initial scan was not queued');
console.log(`Connected ${repository.full_name} to workspace ${workspaceId}; queued ${branch.commit.sha.slice(0, 12)} for scanning.`);
