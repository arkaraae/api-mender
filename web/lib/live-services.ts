export type ServiceRepository = {
  id: string; full_name: string; head_sha: string | null; target_sha: string | null;
  scanned_at: string | null; paused: boolean; github_installation_id: number | null;
};
export type ContractSource = { id: string; repository_id: string; path: string; paused: boolean };
export type ContractVersion = { source_id: string; head_sha: string; created_at: string };
export type ContractConsumer = { source_id: string; repository_id: string; paused: boolean };
export type ContractSnapshot = { id: string; provider: string; metadata: { sourceId?: string; head?: string } };
export type ServiceFinding = { id: string; source_id: string | null; title: string; status: string; created_at: string };

export type WatchedService = {
  id: string; name: string; repositoryId: string; repositoryName: string; path: string;
  status: 'Paused' | 'Waiting for scan' | 'Scan pending' | 'Needs review' | 'Watching';
  tone: 'idle' | 'alert' | 'good';
  lastCheckedAt: string | null; consumerNames: string[]; findings: ServiceFinding[];
};

const actionable = new Set(['Detected', 'Analyzing', 'Action required', 'Patching', 'Validating', 'PR opened', 'Failed']);

export function deriveWatchedServices(input: {
  repositories: ServiceRepository[]; sources: ContractSource[]; versions: ContractVersion[];
  consumers: ContractConsumer[]; snapshots: ContractSnapshot[]; findings: ServiceFinding[];
}): WatchedService[] {
  const repositories = new Map(input.repositories.map(repository => [repository.id, repository]));
  const latestVersions = new Map<string, ContractVersion>();
  for (const version of input.versions) {
    const current = latestVersions.get(version.source_id);
    if (!current || Date.parse(version.created_at) > Date.parse(current.created_at)) latestVersions.set(version.source_id, version);
  }
  const snapshots = new Map<string, { id: string; head?: string }[]>();
  for (const snapshot of input.snapshots) {
    if (snapshot.provider !== 'github-openapi' || !snapshot.metadata?.sourceId) continue;
    const matching = snapshots.get(snapshot.metadata.sourceId) || [];
    matching.push({ id: snapshot.id, head: snapshot.metadata.head });
    snapshots.set(snapshot.metadata.sourceId, matching);
  }
  return input.sources.map(source => {
    const repository = repositories.get(source.repository_id);
    const latest = latestVersions.get(source.id);
    const sourceSnapshots = new Set((snapshots.get(source.id) || [])
      .filter(snapshot => latest && snapshot.head === latest.head_sha).map(snapshot => snapshot.id));
    const activeFindings = input.findings.filter(finding => finding.source_id && sourceSnapshots.has(finding.source_id) && actionable.has(finding.status));
    const consumerNames = input.consumers.filter(consumer => consumer.source_id === source.id && !consumer.paused)
      .map(consumer => repositories.get(consumer.repository_id)?.full_name).filter((name): name is string => !!name);
    const pending = !!repository?.target_sha && repository.target_sha !== repository.head_sha;
    const status: WatchedService['status'] = source.paused || repository?.paused ? 'Paused'
      : activeFindings.length ? 'Needs review'
        : pending ? 'Scan pending'
          : !latest || !repository?.scanned_at || latest.head_sha !== repository.head_sha ? 'Waiting for scan' : 'Watching';
    const tone: WatchedService['tone'] = status === 'Needs review' ? 'alert' : status === 'Watching' ? 'good' : 'idle';
    const fileLabel = source.path.split('/').at(-1)?.replace(/\.json$/i, '') || source.path;
    const repositoryLabel = repository?.full_name.split('/').at(-1) || 'OpenAPI';
    return { id: source.id, name: fileLabel.toLowerCase() === 'openapi' ? `${repositoryLabel} API` : fileLabel,
      repositoryId: source.repository_id, repositoryName: repository?.full_name || 'Disconnected repository',
      path: source.path, status, tone, lastCheckedAt: latest?.created_at || null,
      consumerNames, findings: activeFindings };
  });
}
