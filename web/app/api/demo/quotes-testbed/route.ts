import { NextResponse } from 'next/server';
import { fetchQuotesContract } from '@/lib/quotes-testbed';

type MenderStatus = {
  contractCommit: string;
  findingId: string;
  findingStatus: string;
  validation: string;
  oldConsumer: string;
  patchedConsumer: string;
  runUrl: string;
  fixBranchUrl: string;
  pullRequestUrl?: string;
};

export async function GET() {
  try {
    const { contract, commit } = await fetchQuotesContract();
    const branch = `codex/quotes-fix-${commit.slice(0, 12)}`;
    const source = `https://raw.githubusercontent.com/arkaraae/api-mender/${branch}/testbed/quotes-api/mender-status.json`;
    const response = await fetch(source, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    let status: MenderStatus | null = null;
    if (response.ok) {
      const text = await response.text();
      if (text.length > 10_000) throw new Error('Mender status exceeded its size limit');
      const candidate = JSON.parse(text) as Partial<MenderStatus>;
      if (candidate.contractCommit === commit && typeof candidate.findingId === 'string' && /^f_[a-f0-9]+$/.test(candidate.findingId) && candidate.validation === 'passed' && candidate.oldConsumer === 'failed as expected' && candidate.patchedConsumer === 'passed' && candidate.fixBranchUrl === `https://github.com/arkaraae/api-mender/tree/${branch}` && typeof candidate.runUrl === 'string' && /^https:\/\/github\.com\/arkaraae\/api-mender\/actions\/runs\/\d+$/.test(candidate.runUrl)) {
        status = { ...candidate, pullRequestUrl: typeof candidate.pullRequestUrl === 'string' && /^https:\/\/github\.com\/arkaraae\/api-mender\/pull\/\d+$/.test(candidate.pullRequestUrl) ? candidate.pullRequestUrl : undefined } as MenderStatus;
      }
    } else if (response.status !== 404) throw new Error(`Mender status returned ${response.status}`);
    return NextResponse.json({ contractVersion: contract.version, contractCommit: commit, consumerUrl: 'https://github.com/arkaraae/api-mender/tree/main/testbed/quotes-consumer', status }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Quotes testbed unavailable' }, { status: 502, headers: { 'cache-control': 'no-store' } });
  }
}
