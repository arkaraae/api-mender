// Integrated Services cards for third-party APIs, derived from real backend
// state: the call sites saved by repository scans, the provider findings, and
// metadata reports from customer-managed CLI runs. Pure, so it is unit tested.
import { providerForOrigin } from './engine/providers/registry.ts';

type Call = { origin?: string; endpoint?: string; file?: string; headers?: Record<string, string> };
type Repository = { id: string; full_name: string; call_sites: Call[]; scanned_at: string | null };
type FindingRow = { id: string; status: string; title: string; evidence: { kind?: string; finding?: { provider?: { id?: string } } } };
type CliReport = { repository_label: string; received_at: string;
  report: { providers?: { providerId: string; providerName: string; operations: string[]; callCount: number }[] } };

export type ProviderService = {
  id: string; name: string; origin: string; status: 'Needs review' | 'Watching'; tone: 'alert' | 'good';
  repositories: string[]; callCount: number; operations: string[]; pinnedVersions: string[];
  openFindings: { id: string; title: string }[]; source: string;
};

const open = new Set(['Detected', 'Analyzing', 'Action required', 'Patching', 'Validating', 'PR opened', 'Failed']);

export function deriveProviderServices(repositories: Repository[], findings: FindingRow[], reports: CliReport[] = []): ProviderService[] {
  const services = new Map<string, ProviderService>();
  const entry = (id: string, name: string, origin: string) => {
    const existing = services.get(id);
    if (existing) return existing;
    const created: ProviderService = { id, name, origin, status: 'Watching', tone: 'good', repositories: [], callCount: 0,
      operations: [], pinnedVersions: [], openFindings: [], source: '' };
    services.set(id, created);
    return created;
  };
  for (const repository of repositories) {
    for (const call of Array.isArray(repository.call_sites) ? repository.call_sites : []) {
      const provider = call.origin ? providerForOrigin(call.origin) : null;
      if (!provider) continue;
      const service = entry(provider.id, provider.name, call.origin!);
      service.callCount++;
      if (!service.repositories.includes(repository.full_name)) service.repositories.push(repository.full_name);
      if (call.endpoint && !service.operations.includes(call.endpoint)) service.operations.push(call.endpoint);
      const pinned = provider.versionHeader ? call.headers?.[provider.versionHeader] : undefined;
      if (pinned && !service.pinnedVersions.includes(pinned)) service.pinnedVersions.push(pinned);
    }
  }
  for (const report of reports) {
    for (const provider of report.report.providers ?? []) {
      const service = entry(provider.providerId, provider.providerName, '');
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
    status: service.openFindings.length ? 'Needs review' as const : 'Watching' as const,
    tone: service.openFindings.length ? 'alert' as const : 'good' as const,
    source: `${service.callCount} call${service.callCount === 1 ? '' : 's'} in ${service.repositories.join(', ')}`,
  })).sort((a, b) => a.name.localeCompare(b.name));
}
