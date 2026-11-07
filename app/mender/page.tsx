'use client';

import { useCallback, useEffect, useState } from 'react';

type Probe = { status: number; ms: number; body: unknown };
type Step = { from: string; to: string; inWords: string[]; notes: string[]; proof: { ok: boolean; samples: number; failures: string[] }; changelog: string };
type Api = {
  name: string; title: string; error?: string; endpoint?: string; versions?: string[]; latest?: string; proven?: boolean; steps?: Step[];
  check?: { request: { method: string; path: string; body: unknown }; direct: Probe; throughMender: Probe; keptWorking: boolean };
};
type Caller = { api: string; caller: string; version: string; endpoint: string; outcome: string; calls: number; lastAt: string };
type Status = { upstream: string; apis: Api[]; oldVersionCalls: Caller[] };

const css = `
.mender-page{max-width:1040px;margin:0 auto;padding:40px 20px 72px;color:var(--text,#13283b);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.mender-page h1{font-size:clamp(30px,4.6vw,46px);line-height:1.08;margin:10px 0 12px;letter-spacing:-.02em;max-width:18ch}
.mender-page h2{font-size:22px;margin:0}
.mender-page p{margin:0}
.mender-page .kicker{font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--teal,#087e82)}
.mender-page .lede{color:var(--muted,#647586);font-size:18px;max-width:62ch}
.mender-page .actions{display:flex;flex-wrap:wrap;gap:10px;margin:22px 0 32px}
.mender-page .action{border:1px solid var(--navy,#10283b);border-radius:8px;padding:9px 15px;font:600 15px/1.2 inherit;cursor:pointer;background:var(--navy,#10283b);color:#fff;text-decoration:none}
.mender-page .action.quiet{background:transparent;color:var(--navy,#10283b);border-color:var(--line,#e2e8ed)}
.mender-page .action:disabled{opacity:.55;cursor:default}
.mender-page .card{background:var(--paper,#fff);border:1px solid var(--line,#e2e8ed);border-radius:12px;padding:20px;margin-bottom:18px;display:grid;gap:14px}
.mender-page .head{display:flex;flex-wrap:wrap;gap:10px;align-items:center;justify-content:space-between}
.mender-page .tag{font:600 12px/1 ui-monospace,Menlo,monospace;padding:6px 9px;border-radius:999px;background:#e8f4f1;color:var(--teal,#087e82);white-space:nowrap}
.mender-page .tag.warn{background:#fdf1dc;color:var(--amber,#a86b08)}
.mender-page .tag.bad{background:#fbe9e7;color:#b0261e}
.mender-page code,.mender-page pre{font:13px/1.55 ui-monospace,Menlo,monospace}
.mender-page pre{margin:0;padding:12px 14px;background:var(--bg,#f6f8fa);border-radius:8px;overflow-x:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.mender-page ul{margin:0;padding-left:20px}
.mender-page .muted{color:var(--muted,#647586);font-size:14px}
.mender-page .pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.mender-page .label{font:600 11px/1.3 ui-monospace,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted,#647586);margin-bottom:6px}
.mender-page table{width:100%;border-collapse:collapse;font-size:14px}
.mender-page th,.mender-page td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line,#e2e8ed)}
.mender-page .scroll{overflow-x:auto}
@media (max-width:720px){.mender-page .pair{grid-template-columns:minmax(0,1fr)}}
`;

function Answer({ title, probe }: { title: string; probe: Probe }) {
  const ok = probe.status >= 200 && probe.status < 300;
  return (
    <div>
      <p className="label">{title}</p>
      <pre style={{ borderLeft: `3px solid ${ok ? '#087e82' : '#b0261e'}` }}>{`${probe.status || 'no answer'} · ${probe.ms} ms\n${JSON.stringify(probe.body, null, 2)}`}</pre>
    </div>
  );
}

export default function MenderPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (check: boolean) => {
    setBusy(true);
    setProblem('');
    try {
      const response = await fetch(`/api/mender/status${check ? '?check=1' : ''}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`The status check answered ${response.status}.`);
      setStatus(await response.json());
    } catch (error) {
      setProblem(error instanceof Error ? error.message : 'The status could not be loaded.');
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  return (
    <main className="mender-page">
      <style>{css}</style>
      <p className="kicker">Mender gateway</p>
      <h1>Publish a new API version. Nobody breaks.</h1>
      <p className="lede">When a published version stops accepting what older callers send, Mender reads the two contracts, works out the rules between them, proves them, and translates old-style calls on the way through. Callers keep working while their fix is reviewed.</p>
      <div className="actions">
        <button className="action" type="button" disabled={busy} onClick={() => void load(true)}>{busy ? 'Checking…' : 'Send a real old-style request'}</button>
        <a className="action quiet" href="/studio/index.html">Open Mender Studio</a>
        <a className="action quiet" href="/api/mender/status">Status as JSON</a>
      </div>
      {problem && <p className="card" role="alert">{problem}</p>}
      {!status && !problem && <p className="muted">Reading the published contracts…</p>}

      {status?.apis.map((api) => (
        <section className="card" key={api.name}>
          <div className="head">
            <h2>{api.title}</h2>
            {api.error
              ? <span className="tag warn">contract not readable</span>
              : <span className={`tag ${api.proven ? '' : 'bad'}`}>{api.steps?.length ? (api.proven ? 'rules proven' : 'rules not proven: Mender steps aside') : 'one version: nothing to translate'}</span>}
          </div>
          {api.error && <p className="muted">{api.error}</p>}
          {api.versions && (
            <p className="muted">Published versions: {api.versions.join(', ')}. A caller written for version 1 uses <code>/mender/v1{api.endpoint}</code> instead of <code>{api.endpoint}</code>.</p>
          )}
          {api.steps?.map((step) => (
            <div key={`${step.from}-${step.to}`} style={{ display: 'grid', gap: 10 }}>
              <p className="label">Version {step.from} → {step.to}</p>
              {step.inWords.length ? <ul>{step.inWords.map((line) => <li key={line}>{line}</li>)}</ul> : <p className="muted">Nothing that affects older callers.</p>}
              <p className="muted">{step.proof.ok
                ? `Proven: ${step.proof.samples} sample${step.proof.samples === 1 ? '' : 's'} generated from the contracts fit the other version after translation.`
                : `Not proven: ${step.proof.failures.join('; ')}`}</p>
              {step.notes.slice(0, 8).map((note) => <p className="muted" key={note}>Check: {note}</p>)}
              {step.notes.length > 8 && <p className="muted">And {step.notes.length - 8} more to check, listed in the status JSON.</p>}
            </div>
          ))}
          {api.check && (
            <div style={{ display: 'grid', gap: 10 }}>
              <div>
                <p className="label">Real request, as a version 1 caller sends it</p>
                <pre>{`${api.check.request.method} ${api.check.request.path}\n${JSON.stringify(api.check.request.body)}`}</pre>
              </div>
              <div className="pair">
                <Answer title="Sent as it is" probe={api.check.direct} />
                <Answer title="Sent through Mender" probe={api.check.throughMender} />
              </div>
            </div>
          )}
        </section>
      ))}

      {status && (
        <section className="card">
          <div className="head"><h2>Who still calls an old version</h2><span className="tag">{status.oldVersionCalls.length} caller{status.oldVersionCalls.length === 1 ? '' : 's'}</span></div>
          {status.oldVersionCalls.length === 0
            ? <p className="muted">No old-version calls have come through the gateway since this server started.</p>
            : (
              <div className="scroll">
                <table>
                  <thead><tr><th>Caller</th><th>Version</th><th>Endpoint</th><th>Result</th><th>Calls</th></tr></thead>
                  <tbody>{status.oldVersionCalls.map((row) => (
                    <tr key={`${row.api}-${row.caller}-${row.version}-${row.endpoint}-${row.outcome}`}><td>{row.caller}</td><td>{row.version}</td><td><code>{row.endpoint}</code></td><td>{row.outcome}</td><td>{row.calls}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          <p className="muted">Counts are kept in memory on this server. Callers name themselves with an <code>x-consumer</code> header.</p>
        </section>
      )}
    </main>
  );
}
