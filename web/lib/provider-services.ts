// Integrated Services: every external API the connected code calls, from real
// backend state (the call sites saved by repository scans, provider findings,
// and metadata reports from customer-managed CLI runs). APIs with a published
// contract in the provider catalog are watched for changes; any other host is
// listed as detected. Pure, so it is unit tested.
import { providerForOrigin } from './engine/providers/registry.ts';

type Call = { origin?: string; endpoint?: string; file?: string; headers?: Record<string, string> };
type Repository = { id: string; full_name: string; call_sites: Call[]; scanned_at: string | null };
type FindingRow = { id: string; status: string; title: string; evidence: { kind?: string; finding?: { provider?: { id?: string } } } | null };
type CliReport = { repository_label: string; received_at: string;
  report: { providers?: { providerId: string; providerName: string; operations: string[]; callCount: number }[] } };

export type ProviderService = {
  id: string; name: string; origin: string;
  /** True when Mend has this API's published contract and checks it for changes. */
  watched: boolean;
  status: 'Needs review' | 'Watching' | 'Detected'; tone: 'alert' | 'good' | 'idle';
  repositories: string[]; callCount: number; operations: string[]; pinnedVersions: string[];
  openFindings: { id: string; title: string }[]; source: string;
};

const open = new Set(['Detected', 'Analyzing', 'Action required', 'Patching', 'Validating', 'PR opened', 'Failed']);

function hostOf(origin: string) {
  try { return new URL(origin).host; } catch { return null; }
}

export function deriveProviderServices(repositories: Repository[], findings: FindingRow[], reports: CliReport[] = []): ProviderService[] {
  const services = new Map<string, ProviderService>();
  const entry = (id: string, name: string, origin: string, watched: boolean) => {
    const existing = services.get(id);
    if (existing) return existing;
    const created: ProviderService = { id, name, origin, watched, status: watched ? 'Watching' : 'Detected', tone: watched ? 'good' : 'idle',
      repositories: [], callCount: 0, operations: [], pinnedVersions: [], openFindings: [], source: '' };
    services.set(id, created);
    return created;
  };
  for (const repository of repositories) {
    for (const call of Array.isArray(repository.call_sites) ? repository.call_sites : []) {
      if (typeof call.origin !== 'string') continue;
      const host = hostOf(call.origin);
      if (!host) continue;
      const provider = providerForOrigin(call.origin);
      const service = provider ? entry(provider.id, provider.name, call.origin, true) : entry(`host:${host}`, host, call.origin, false);
      service.callCount++;
      if (!service.repositories.includes(repository.full_name)) service.repositories.push(repository.full_name);
      if (call.endpoint && !service.operations.includes(call.endpoint)) service.operations.push(call.endpoint);
      const pinned = provider?.versionHeader ? call.headers?.[provider.versionHeader] : undefined;
      if (pinned && !service.pinnedVersions.includes(pinned)) service.pinnedVersions.push(pinned);
    }
  }
  // CLI reports name only catalog providers (unrecognised hosts are counted, never named).
  for (const report of reports) {
    for (const provider of report.report.providers ?? []) {
      const service = entry(provider.providerId, provider.providerName, '', true);
      service.callCount += provider.callCount;
      const label = `${report.repository_label} (CLI)`;
      if (!service.repositories.includes(label)) service.repositories.push(label);
      for (const operation of provider.operations) if (!service.operations.includes(operation)) service.operations.push(operation);
    }
  }
  for (const finding of findings) {
    const providerId = finding.evidence?.kind === 'provider-change' ? finding.evidence.finding?.provider?.id : undefined;
    const service = providerId && services.get(providerId);
    if (service && open.has(finding.status)) service.openFindings.push({ id: finding.id, title: finding.title });
  }
  return [...services.values()].map(service => ({ ...service,
    status: service.openFindings.length ? 'Needs review' as const : service.status,
    tone: service.openFindings.length ? 'alert' as const : service.tone,
    source: `${service.callCount} call${service.callCount === 1 ? '' : 's'} in ${service.repositories.join(', ')}`,
  // Watched APIs first, then by name.
  })).sort((a, b) => Number(b.watched) - Number(a.watched) || a.name.localeCompare(b.name));
}
