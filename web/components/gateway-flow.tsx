'use client';

// Request labels pinned to the real coins in the gateway film. The coins were tracked frame by
// frame (lib/coin-tracks.json); on every animation frame the label for each coin is placed at
// that coin's position for the film's current time, so the labels ride the coins and stay with
// them even when the film stalls. When a coin reaches the machine: with Mender on the label
// turns green with what came out of it and a 200; with Mender off it stays exactly as it went
// in and gets a red 422. Every coin carries a different change, the kinds of rules Mender's
// engine handles: rename, scale, move.
import { useEffect, useRef } from 'react';
import tracks from '@/lib/coin-tracks.json';

const CHANGES = [
  { before: '{ customerId }', after: '{ accountId }' },
  { before: '{ amount: 12.5 }', after: '{ amount_cents: 1250 }' },
  { before: '{ zip }', after: '{ postalCode }' },
  { before: '{ user.name }', after: '{ name }' },
  { before: '{ created }', after: '{ createdAt }' },
  { before: '{ price }', after: '{ unitPrice }' },
  { before: '{ phone }', after: '{ phoneNumber }' },
];
const FILM_RATIO = 16 / 9;
const HOLD = 1.1; // seconds the answer stays at the machine after the coin goes in

export default function GatewayFlow({ mender }: { mender: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const latest = useRef(mender);
  latest.current = mender;

  useEffect(() => {
    const el = root.current;
    const wrap = el?.parentElement;
    const video = wrap?.querySelector('video');
    if (!el || !wrap || !video || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const chips = [...el.querySelectorAll<HTMLElement>('.coin-chip')];
    let frame = 0;
    const tick = () => {
      // Where the film's picture sits inside its box (object-fit: cover crops one side).
      const boxW = wrap.clientWidth, boxH = wrap.clientHeight;
      const scale = Math.max(boxW / FILM_RATIO, boxH);
      const filmW = scale * FILM_RATIO, filmH = scale;
      const offX = (boxW - filmW) / 2, offY = (boxH - filmH) / 2;
      const t = video.currentTime;
      const on = latest.current;
      tracks.tracks.forEach((track, i) => {
        const chip = chips[i];
        if (!chip) return;
        const k = t * tracks.fps - track.start;
        const last = track.points.length - 1;
        let state: 'hidden' | 'riding' | 'done' = 'hidden';
        let point = track.points[0];
        if (k >= 0 && k <= last) { state = 'riding'; point = track.points[Math.min(last, Math.round(k))]; }
        else if (k > last && k <= last + HOLD * tracks.fps) { state = 'done'; point = track.points[last]; }
        if (state === 'hidden') { chip.style.opacity = '0'; chip.dataset.state = 'hidden'; return; }
        chip.style.opacity = '1';
        chip.style.transform = `translate(${(offX + point[0] * filmW).toFixed(1)}px, ${(offY + point[1] * filmH - 54).toFixed(1)}px)`;
        chip.dataset.state = state === 'done' ? (on ? 'pass' : 'fail') : 'riding';
      });
      frame = requestAnimationFrame(tick);
    };
    const seen = new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(frame);
      if (entry.isIntersecting) frame = requestAnimationFrame(tick);
    });
    seen.observe(wrap);
    return () => { seen.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  return (
    <div className="flow" ref={root} aria-hidden="true">
      {tracks.tracks.map((track, i) => {
        const change = CHANGES[i % CHANGES.length];
        return (
          <div key={track.start} className="coin-chip" data-state="hidden">
            <span className="coin-chip-body"><b className="coin-before">{change.before}</b><b className="coin-after">{mender ? change.after : change.before}</b></span>
            <span className="coin-chip-answer">{mender ? '200' : '422 · unchanged'}</span>
          </div>
        );
      })}
    </div>
  );
}
