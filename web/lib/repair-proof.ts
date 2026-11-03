const shaPattern = /^[a-f0-9]{40}$/;

export type RepairCheckRun = {
  id?: unknown;
  name?: unknown;
  head_sha?: unknown;
  status?: unknown;
  conclusion?: unknown;
  app?: { slug?: unknown } | null;
  html_url?: unknown;
};

/** Customer CI attestation for the exact PR commit, never a server-run test. */
export function evaluateRepairProof(checkRuns: unknown, patchSha: string) {
  if (!shaPattern.test(patchSha) || !Array.isArray(checkRuns) || checkRuns.length > 100)
    throw new Error('Invalid GitHub check response');
  const matching = checkRuns.filter((run): run is RepairCheckRun => run !== null
    && typeof run === 'object'
    && run.name === 'mender-repair-proof'
    && run.head_sha === patchSha
    && run.app?.slug === 'github-actions'
    && Number.isSafeInteger(run.id) && Number(run.id) > 0);
  const latest = matching.sort((a, b) => Number(b.id) - Number(a.id))[0];
  if (!latest) return { status: 'proof_pending' as const, proof: null };
  if (typeof latest.html_url !== 'string' || !latest.html_url.startsWith('https://github.com/'))
    throw new Error('Invalid GitHub check URL');
  const proof = { provider: 'github-actions', checkName: 'mender-repair-proof',
    checkRunId: latest.id as number, headSha: patchSha, url: latest.html_url,
    conclusion: latest.conclusion === null ? null : latest.conclusion };
  if (latest.status !== 'completed') return { status: 'proof_pending' as const, proof };
  if (latest.conclusion === 'success') return { status: 'validated' as const, proof };
  return { status: 'proof_failed' as const, proof };
}
