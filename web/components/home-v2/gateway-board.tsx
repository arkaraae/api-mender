'use client';

import { type ReactNode, useState } from 'react';

type Row = { badge: string; label: string; calls: number; code?: boolean };
type View = { key: string; tab: string; title: string; note: string; rows: Row[] };

// Example figures for the homepage illustration. The real per-caller list lives at /mender.
const VIEWS: View[] = [
  {
    key: 'callers', tab: 'Callers', title: 'Old-version calls, by caller',
    note: 'Calls sent to /mender/v1/… this week, translated to version 2 and answered in the shape each caller expects.',
    rows: [
      { badge: 'iOS', label: 'ios-app 3.2', calls: 18240 }, { badge: 'AN', label: 'android 3.1', calls: 15410 },
      { badge: 'PO', label: 'acme-pos (partner)', calls: 9120 }, { badge: 'WB', label: 'web 41', calls: 6880 },
      { badge: 'CR', label: 'billing-cron', calls: 4210 }, { badge: 'ZP', label: 'zapier hook', calls: 2930 },
      { badge: 'iOS', label: 'ios-app 3.0', calls: 1870 }, { badge: 'AD', label: 'internal-admin', calls: 960 },
      { badge: 'AN', label: 'android 2.9', calls: 410 }, { badge: 'SD', label: 'legacy-sdk 1.x', calls: 95 },
    ],
  },
  {
    key: 'rules', tab: 'Rules', title: 'Calls translated, by rule',
    note: 'Each rule was proved both ways before it ran. Counts are calls that needed that rule this week.',
    rows: [
      ['customerId → accountId', 31200], ['amount → amount_cents', 22900], ['zip → postalCode', 12400],
      ['phone → phoneNumber', 8800], ['created → createdAt', 6100], ['price → unitPrice', 3900], ['user.name → name', 2100],
    ].map(([label, calls]) => ({ badge: '→', label: label as string, calls: calls as number, code: true })),
  },
  {
    key: 'endpoints', tab: 'Endpoints', title: 'Old-version calls, by endpoint',
    note: 'Where version-1 traffic still lands. Retire the quiet ones first.',
    rows: [
      ['P', 'POST /quotes', 24100], ['G', 'GET /accounts/:id', 17800], ['P', 'POST /orders', 9600],
      ['PA', 'PATCH /profile', 5200], ['G', 'GET /prices', 3100], ['D', 'DELETE /carts/:id', 740],
    ].map(([badge, label, calls]) => ({ badge: badge as string, label: label as string, calls: calls as number, code: true })),
  },
];

const ICONS: Record<string, ReactNode> = {
  callers: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5" /><circle cx="17" cy="9" r="2.4" /><path d="M15.5 14.2c2.4-.3 4.3 1.2 5 4.3" /></>,
  rules: <path d="M4 7h12l-3-3M20 17H8l3 3" />,
  endpoints: <><path d="M4 20.5V10a8 8 0 0 1 16 0v10.5" /><path d="M8.2 20.5v-9.8a3.8 3.8 0 0 1 7.6 0v9.8" /><path d="M2.5 20.5h19" /></>,
};

const fmt = (n: number) => n.toLocaleString('en-US');

export default function GatewayBoard() {
  const [key, setKey] = useState('callers');
  const view = VIEWS.find((v) => v.key === key) ?? VIEWS[0];
  const max = view.rows[0].calls;

  return (
    <>
      <div className="mv2-tabs" role="tablist" aria-label="Gateway view">
        {VIEWS.map((v) => (
          <button key={v.key} className="mv2-tab" role="tab" type="button" aria-selected={v.key === key} onClick={() => setKey(v.key)}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">{ICONS[v.key]}</svg>
            {v.tab}
          </button>
        ))}
      </div>

      <div className="mv2-board">
        <div className="mv2-board-top">
          <span className="mv2-chip"><img src="/home/gear-icon.png" alt="" width={22} height={23} />Live gateway</span>
          <span className="mv2-chip"><img src="/home/payload-icon.png" alt="" width={22} height={16} />Quotes API v1 → v2</span>
          <a href="/mender">See the live list →</a>
          <span className="mv2-example">Example data</span>
        </div>
        <div className="mv2-board-body">
          <div className="mv2-board-title">
            <h3><img src="/home/gear-icon.png" alt="" width={26} height={27} />{view.title}</h3>
            <span className="mv2-byline">
              <img className="only-light" src="/home/gateway_emblem_olive.svg" alt="" width={28} height={26} />
              <img className="only-dark" src="/home/gateway_emblem_white.svg" alt="" width={28} height={26} />
              Mender Gateway <small>by API Mender</small>
            </span>
          </div>
          <p className="mv2-board-note">{view.note}</p>
          <div className="mv2-chart-scroll">
            <div className="mv2-chart" role="img" aria-label={`${view.title}: ${view.rows.map((r) => `${r.label} ${fmt(r.calls)}`).join(', ')}`}>
              {view.rows.map((r) => (
                <div className="mv2-bar-col" key={r.label}>
                  <span className="mv2-badge">{r.badge}</span>
                  <span className="mv2-bar" style={{ height: `${Math.max(34, Math.round((r.calls / max) * 270))}px` }}>{fmt(r.calls)}</span>
                </div>
              ))}
            </div>
            <div className="mv2-labels">
              {view.rows.map((r) => <span key={r.label}>{r.code ? <code>{r.label}</code> : r.label}</span>)}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
