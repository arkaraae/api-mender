'use client';

// Everything known about one finding, in the Mend detail panel: the upstream
// change, the code that uses it, any customer-declared database mapping, and
// the repair flow that applies (provider change → self-hosted model repair;
// connected-contract request mismatch → field-mapping repair).
import type { SupabaseClient } from '@supabase/supabase-js';
import ProviderRepair from '@/components/provider-repair';
import RepairPreview from '@/components/repair-preview';
import type { Finding as EngineFinding } from '@/lib/engine/types';

type DatabaseImpact = { schemaLabel: string; table: string; column: string;
  status: 'column-present' | 'column-absent' | 'snapshot-missing' | 'snapshot-stale'; notNull?: boolean; capturedAt?: string };
type DatabaseWrite = { responseField: string; table: string; column: string; writeLine: number; sourceUrl: string };
type ConsumerCandidate = { repository: string; file: string; line: number; endpoint: string; sourceUrl: string; databaseWrites?: DatabaseWrite[] };

export type LiveFinding = {
  id: string; title: string; description: string; severity: string; confidence: string; status: string; created_at: string;
  evidence: {
    kind?: string; finding?: EngineFinding; sourceUrl?: string; contractUrl?: string; codeUrl?: string; runUrl?: string;
    pullRequestUrl?: string; previousVersion?: string; currentVersion?: string; note?: string;
    databaseImpact?: DatabaseImpact[]; consumerCandidates?: ConsumerCandidate[]; missing?: string[];
    report?: { changes?: { title: string; fields: string[] }[] };
  } | null;
};

const external = { target: '_blank', rel: 'noopener noreferrer' } as const;

export default function FindingDetail({ database, workspaceId, finding, onDismiss, busy }: {
  database: SupabaseClient; workspaceId: string; finding: LiveFinding;
  onDismiss: (dismissed: boolean) => void; busy: boolean;
}) {
  const evidence = finding.evidence ?? {};
  const dismissed = finding.status === 'Dismissed';
  const candidates = evidence.consumerCandidates ?? [];
  const writes = candidates.flatMap(candidate => (candidate.databaseWrites ?? []).map(write => ({ ...write, repository: candidate.repository })));
  return <div className="mend-finding">
    <div className="mend-finding-meta">
      <span>{finding.severity}</span><span>{finding.confidence}</span><span>{finding.status}</span>
      <span>{new Date(finding.created_at).toLocaleString()}</span>
    </div>

    {evidence.kind === 'provider-change' && evidence.finding
      ? <ProviderRepair key={finding.id} database={database} workspaceId={workspaceId} findingId={finding.id}
          finding={evidence.finding} codeUrl={evidence.codeUrl} />
      : <>
        <p>{finding.description}</p>
        {(evidence.report?.changes?.length || evidence.missing?.length) ? <section>
          <h3>Upstream change</h3>
          <ul>
            {evidence.report?.changes?.map((change, index) => <li key={index}><strong>{change.title}</strong>{change.fields.length > 0 && <> · <code>{change.fields.join(', ')}</code></>}</li>)}
            {evidence.missing?.length ? <li><strong>Required field missing</strong> · <code>{evidence.missing.join(', ')}</code></li> : null}
          </ul>
        </section> : null}
        {(evidence.previousVersion || evidence.currentVersion) && <p>Version {evidence.previousVersion ?? '?'} → {evidence.currentVersion ?? '?'}</p>}
        {evidence.note && <p>{evidence.note}</p>}
        {candidates.length > 0 && <section>
          <h3>Code that uses it</h3>
          <ul>{candidates.slice(0, 10).map((candidate, index) => <li key={`${candidate.file}:${candidate.line}:${index}`}>
            {candidate.repository} · <a href={candidate.sourceUrl} {...external}>{candidate.file}:{candidate.line} ↗</a> · <code>{candidate.endpoint}</code>
          </li>)}</ul>
        </section>}
        {writes.length > 0 && <section>
          <h3>Database writes</h3>
          <ul>{writes.slice(0, 10).map((write, index) => <li key={index}>
            {write.repository}: <code>{write.responseField}</code> → <code>{write.table}.{write.column}</code> · <a href={write.sourceUrl} {...external}>line {write.writeLine} ↗</a>
          </li>)}</ul>
        </section>}
        {evidence.databaseImpact?.length ? <section>
          <h3>Customer-declared database mapping</h3>
          <ul>{evidence.databaseImpact.map((impact, index) => <li key={index}>
            {impact.schemaLabel}: <code>public.{impact.table}.{impact.column}</code> · {impact.status === 'column-present'
              ? `present${impact.notNull ? ', NOT NULL' : ', nullable'}` : impact.status.replace('-', ' ')}
          </li>)}</ul>
          <p>A schema match is a possible impact, not a verified production failure.</p>
        </section> : null}
        <p className="mend-finding-links">
          {(evidence.contractUrl || evidence.sourceUrl) && <a href={evidence.contractUrl || evidence.sourceUrl} {...external}>API source ↗</a>}
          {evidence.codeUrl && <a href={evidence.codeUrl} {...external}>Affected code ↗</a>}
          {evidence.runUrl && <a href={evidence.runUrl} {...external}>Check run ↗</a>}
          {evidence.pullRequestUrl && <a href={evidence.pullRequestUrl} {...external}>Pull request ↗</a>}
        </p>
        {evidence.kind === 'request-schema-mismatch' && <RepairPreview database={database} workspaceId={workspaceId} findingId={finding.id} />}
      </>}

    <button className="mend-finding-dismiss" disabled={busy} onClick={() => onDismiss(!dismissed)}>
      {busy ? 'Saving…' : dismissed ? 'Restore finding' : 'Dismiss finding'}
    </button>
  </div>;
}
