// Snapshot providers (ProviderAdapter.versioning === 'snapshot') publish one
// live contract and edit it in place. Each commit of that file is a version,
// labelled by its commit date, and fetched by commit SHA so the document a
// finding cites never changes. Fetch is injected: Worker, CLI and tests.
import type { ContractSource, ProviderAdapter } from './types.ts';

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type SnapshotSource = ContractSource & { commit: string };

/** The newest published commit of the provider's contract file. */
export async function latestSnapshotSource(provider: ProviderAdapter, fetcher: typeof fetch = fetch, token?: string): Promise<SnapshotSource> {
  const snapshot = provider.snapshot;
  if (provider.versioning !== 'snapshot' || !snapshot || !repositoryPattern.test(snapshot.repository)) throw new Error(`${provider.id} is not a snapshot provider`);
  const query = new URLSearchParams({ path: snapshot.path, sha: snapshot.branch, per_page: '1' });
  const response = await fetcher(`https://api.github.com/repos/${snapshot.repository}/commits?${query}`, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'api-mender-catalog',
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    redirect: 'error', signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status} for ${snapshot.repository} commits`);
  const [commit] = await response.json() as { sha?: unknown; commit?: { committer?: { date?: unknown } } }[];
  const sha = commit?.sha;
  const date = commit?.commit?.committer?.date;
  if (typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(date))
    throw new Error(`GitHub returned no valid commit for ${snapshot.repository}/${snapshot.path}`);
  const baseline = provider.contractSources[0];
  return {
    version: date.slice(0, 10), commit: sha, format: 'openapi-json',
    url: `https://raw.githubusercontent.com/${snapshot.repository}/${sha}/${snapshot.path.split('/').map(encodeURIComponent).join('/')}`,
    ...(baseline?.changelogUrl ? { changelogUrl: baseline.changelogUrl } : {}),
  };
}

/** The adapter with the newest snapshot appended to its known versions. */
export async function withLatestSnapshot(provider: ProviderAdapter, fetcher: typeof fetch = fetch, token?: string): Promise<ProviderAdapter> {
  if (provider.versioning !== 'snapshot') return provider;
  const latest = await latestSnapshotSource(provider, fetcher, token);
  const known = provider.contractSources.filter(source => source.version !== latest.version && source.version < latest.version);
  return { ...provider, contractSources: [...known, latest] };
}
