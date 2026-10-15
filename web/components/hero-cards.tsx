'use client';

// The two cards beside the headline, with real numbers from the gateway: one real old-style
// request sent to the live Quotes API both ways (the live check), and how many old-version
// calls Mender has translated so far.
import { useEffect, useState } from 'react';

type Status = {
  apis?: { name: string; check?: { direct?: { status: number }; throughMender?: { status: number } }; error?: string }[];
  oldVersionCalls?: { outcome: string; calls: number }[];
  callsSaved?: boolean;
};

type Live = { phase: 'checking' | 'ready' | 'failed'; direct?: number; through?: number; rescued?: number; saved?: boolean };

export default function HeroCards() {
  const [live, setLive] = useState<Live>({ phase: 'checking' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/mender/status?check=1', { cache: 'no-store' });
        const status = (await response.json()) as Status;
        if (cancelled) return;
        const testbed = status.apis?.find((api) => api.name === 'testbed');
        const rescued = (status.oldVersionCalls ?? []).filter((row) => row.outcome === 'translated').reduce((sum, row) => sum + Number(row.calls || 0), 0);
        setLive({ phase: testbed?.check ? 'ready' : 'failed', direct: testbed?.check?.direct?.status, through: testbed?.check?.throughMender?.status, rescued, saved: status.callsSaved });
      } catch {
        if (!cancelled) setLive({ phase: 'failed' });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const rescuedNow = live.phase === 'ready' && live.direct !== undefined && live.direct >= 400 && live.through !== undefined && live.through < 400;

  return (
    <div className="hero-cards">
      <div className="hero-card hero-card-small">
        <div className="hero-chevrons" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6" /></svg>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6" /></svg>
        </div>
        <div>
          <div>LIVE CHECK</div>
          <div className={rescuedNow ? 'is-pass' : live.phase === 'failed' ? 'is-fail' : ''}>
            {live.phase === 'checking' ? 'RUNNING…' : live.phase === 'failed' ? 'UNAVAILABLE' : rescuedNow ? `${live.direct} → ${live.through}` : `${live.direct} / ${live.through}`}
          </div>
        </div>
      </div>
      <div className="hero-card hero-card-large">
        <div className="hero-card-label">OLD-VERSION CALLS TRANSLATED:</div>
        <div className="hero-card-number">{live.phase === 'checking' ? '…' : live.rescued === undefined ? '—' : live.rescued.toLocaleString('en-US')}</div>
        <div className="hero-card-rule" />
        <div className="hero-card-foot">
          {live.phase === 'ready' ? (rescuedNow ? 'ONE OLD CALL SENT BOTH WAYS JUST NOW .' : 'LIVE QUOTES API, VERSION 2 .') : live.phase === 'failed' ? 'THE LIVE CHECK DID NOT RUN .' : 'SENDING ONE REAL CALL BOTH WAYS .'} <span>/</span>
        </div>
      </div>
    </div>
  );
}
