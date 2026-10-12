'use client';

// One watched API: when it was checked, every version kept, and what changed between them.
import { useCallback, useEffect, useState } from 'react';

type Version = { n: number; at: string; size: number; title: string | null; version: string | null };
type Watch = { id: string; url: string; createdAt: string; lastCheckedAt: number; lastChangedAt: string | null; status: string; error: string | null; versions: Version[]; notifies: string | null };

const when = (value: string | number) => new Date(value).toLocaleString();
const size = (bytes: number) => (bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);

export default function WatchView({ id }: { id: string }) {
  const [watch, setWatch] = useState<Watch | null>(null);
  const [problem, setProblem] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch(`/api/mender/watch/${id}`, { cache: 'no-store' });
    const body = (await response.json()) as Watch & { error?: string };
    if (!response.ok) { setProblem(body.error || 'This watch could not be loaded.'); return; }
    setWatch(body);
  }, [id]);

  useEffect(() => { void load(); }, [load]);

  async function checkNow() {
    setBusy(true);
    setMessage('');
    const response = await fetch(`/api/mender/watch/${id}/check`, { method: 'POST' });
    const body = (await response.json()) as { changed?: boolean; watch?: Watch; error?: string };
    if (!response.ok) setMessage(body.error || 'The check did not run.');
    else {
      if (body.watch) setWatch(body.watch);
      setMessage(body.watch?.status === 'error' ? `The check failed: ${body.watch.error}` : body.changed ? 'It changed. The new version is at the top.' : 'No change since the last check.');
    }
    setBusy(false);
  }

  function copyLink(button: HTMLButtonElement) {
    void navigator.clipboard.writeText(window.location.href).then(() => {
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = 'Copy link'; }, 1600);
    });
  }

  if (problem) return <section className="check-card"><p className="check-problem" role="alert">{problem}</p><p className="check-hint"><a href="/watch">Watch an API</a></p></section>;
  if (!watch) return <section className="check-card"><p className="check-hint">Loading…</p></section>;

  const latest = watch.versions.at(-1);
  const newestFirst = [...watch.versions].reverse();
  const snapshot = (n: number) => `/api/mender/watch/${id}/snapshot/${n}`;

  return (
    <>
      <section className={`check-verdict ${watch.status === 'error' ? 'verdict-breaks' : watch.versions.length > 1 ? 'verdict-bridged' : 'verdict-safe'}`}>
        <span className="check-verdict-mark" aria-hidden="true">{watch.status === 'error' ? '!' : watch.versions.length > 1 ? '↻' : '✓'}</span>
        <div>
          <h2>{latest?.title ?? new URL(watch.url).hostname}{latest?.version ? ` · ${latest.version}` : ''}</h2>
          <p>{watch.status === 'error'
            ? `The last check failed: ${watch.error}`
            : watch.versions.length > 1
              ? `Changed ${watch.versions.length - 1} time${watch.versions.length === 2 ? '' : 's'} since you started watching. Last change ${when(watch.lastChangedAt ?? latest?.at ?? watch.createdAt)}.`
              : 'No changes yet. Mender checks once a day.'}</p>
        </div>
      </section>

      <section className="check-card">
        <div className="check-card-head">
          <h2>Watching</h2>
          <button type="button" className="check-link" onClick={(event) => copyLink(event.currentTarget)}>Copy link</button>
        </div>
        <p className="check-hint watch-url">{watch.url}</p>
        <p className="check-hint">Last checked {when(watch.lastCheckedAt)}{watch.notifies ? `. Messages go to ${watch.notifies}.` : '.'}</p>
        <div className="check-actions">
          <button type="button" className="pill-button pill-outline" disabled={busy} onClick={() => void checkNow()}>{busy ? 'Checking…' : 'Check now'}</button>
          {message && <span className="check-phase" aria-live="polite">{message}</span>}
        </div>
      </section>

      <section className="check-card">
        <h2>Versions</h2>
        <ul className="watch-versions">
          {newestFirst.map((version) => (
            <li key={version.n}>
              <div>
                <strong>{version.n === 0 ? 'First copy' : `Change ${version.n}`}</strong>
                <span>{when(version.at)} · {version.title ?? 'untitled'}{version.version ? ` ${version.version}` : ''} · {size(version.size)}</span>
              </div>
              {version.n > 0 && <a className="pill-button pill-dark" href={`/check?before=${encodeURIComponent(snapshot(version.n - 1))}&after=${encodeURIComponent(snapshot(version.n))}`}>See what changed</a>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
