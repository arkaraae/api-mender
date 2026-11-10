// Real numbers for the Home and Activity views ("Repository scans",
// "This month"). Pure aggregation over rows the signed-in member can already
// read, so it is unit tested and the route stays a thin RLS-scoped query.

export type ActivityDay = { date: string; scans: number; checks: number; flagged: number };
export type ActivitySummary = {
  days: ActivityDay[];
  totals: { scans: number; checks: number; flagged: number };
  thisMonth: { changesChecked: number; changesFlagged: number; repairsProposed: number; repairsValidated: number;
    previousMonthChangesChecked: number };
  repositories: { connected: number; lastScanAt: string | null };
};

type Row = { created_at: string };
const day = (iso: string) => iso.slice(0, 10);

export function summarizeActivity(input: {
  now: Date; days: number;
  scans: (Row & { status: string; finished_at: string | null })[];
  rechecks: (Row & { detail: { repositories?: number } | null })[];
  findings: (Row & { evidence: { kind?: string } | null })[];
  repairs: (Row & { status: string })[];
  repositories: { scanned_at: string | null }[];
}): ActivitySummary {
  const span = Math.min(Math.max(Math.trunc(input.days), 1), 366);
  const today = Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth(), input.now.getUTCDate());
  const days: ActivityDay[] = Array.from({ length: span }, (_, index) => ({
    date: new Date(today - (span - 1 - index) * 86_400_000).toISOString().slice(0, 10), scans: 0, checks: 0, flagged: 0 }));
  const byDate = new Map(days.map(entry => [entry.date, entry]));
  for (const scan of input.scans) if (scan.status === 'succeeded') { const entry = byDate.get(day(scan.finished_at ?? scan.created_at)); if (entry) entry.scans++; }
  // A recheck run covers several repositories; each counts as one check.
  for (const run of input.rechecks) { const entry = byDate.get(day(run.created_at)); if (entry) entry.checks += Math.max(1, run.detail?.repositories ?? 1); }
  for (const finding of input.findings) { const entry = byDate.get(day(finding.created_at)); if (entry) entry.flagged++; }

  const month = (offset: number) => {
    const start = Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth() + offset, 1);
    const end = Date.UTC(input.now.getUTCFullYear(), input.now.getUTCMonth() + offset + 1, 1);
    return (row: Row) => { const at = Date.parse(row.created_at); return at >= start && at < end; };
  };
  const inThis = month(0);
  const inLast = month(-1);
  const checked = (inMonth: (row: Row) => boolean) =>
    input.scans.filter(scan => scan.status === 'succeeded' && inMonth(scan)).length
    + input.rechecks.filter(inMonth).reduce((sum, run) => sum + Math.max(1, run.detail?.repositories ?? 1), 0);
  const scanTimes = input.repositories.map(repo => repo.scanned_at).filter((at): at is string => !!at).sort();
  return {
    days,
    totals: days.reduce((sum, entry) => ({ scans: sum.scans + entry.scans, checks: sum.checks + entry.checks,
      flagged: sum.flagged + entry.flagged }), { scans: 0, checks: 0, flagged: 0 }),
    thisMonth: {
      changesChecked: checked(inThis),
      changesFlagged: input.findings.filter(inThis).length,
      repairsProposed: input.repairs.filter(inThis).length,
      // 'validated' = customer CI passed on the draft PR. Not proof of correct behavior.
      repairsValidated: input.repairs.filter(repair => repair.status === 'validated' && inThis(repair)).length,
      previousMonthChangesChecked: checked(inLast),
    },
    repositories: { connected: input.repositories.length, lastScanAt: scanTimes.at(-1) ?? null },
  };
}
