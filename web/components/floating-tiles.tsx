'use client';

// Decoration only: the kinds of third-party API a codebase depends on, floating either side of the
// headline. Not partners or customers. Icons: public/integrations/ (Simple Icons, CC0).
// The pointer nudges each tile by its depth and moves the brighter patch of the hero's grid.
import { type CSSProperties, useEffect, useRef } from 'react';

const TILES = [
  { icon: 'stripe', x: '6%', y: '300px', size: '76px', depth: 1.1, path: 'a', time: '13s' },
  { icon: 'shopify', x: '13.5%', y: '480px', size: '58px', depth: 0.6, path: 'b', time: '11s' },
  { icon: 'slack', x: '15%', y: '140px', size: '66px', depth: 0.8, path: 'c', time: '15s' },
  { icon: 'github', x: '78%', y: '135px', size: '80px', depth: 1.3, path: 'b', time: '14s' },
  { icon: 'googlecalendar', x: '81%', y: '500px', size: '58px', depth: 0.7, path: 'a', time: '12s' },
  { icon: 'salesforce', x: '87%', y: '325px', size: '68px', depth: 1, path: 'c', time: '16s' },
  { icon: 'twilio', x: '92%', y: '165px', size: '58px', depth: 0.5, path: 'a', time: '10s' },
];

export default function FloatingTiles() {
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const el = list.current;
    const hero = el?.closest<HTMLElement>('.hero');
    if (!el || !hero || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let x = 0;
    let y = 0;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const box = hero.getBoundingClientRect();
      el.style.setProperty('--px', ((x - box.left) / box.width - 0.5).toFixed(3));
      el.style.setProperty('--py', ((y - box.top) / box.height - 0.5).toFixed(3));
      hero.style.setProperty('--mx', `${Math.round(x - box.left)}px`);
      hero.style.setProperty('--my', `${Math.round(y - box.top)}px`);
    };
    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <ul ref={list} className="tiles" aria-hidden="true">
      {TILES.map((tile, index) => (
        <li key={tile.icon} style={{ '--x': tile.x, '--y': tile.y, '--size': tile.size, '--depth': tile.depth, '--in': `${0.5 + index * 0.09}s` } as CSSProperties}>
          <div className={`tile tile-${tile.path}`} style={{ '--time': tile.time, '--delay': `${-index * 1.7}s` } as CSSProperties}>
            <span style={{ '--icon': `url(/integrations/${tile.icon}.svg)` } as CSSProperties} />
          </div>
        </li>
      ))}
    </ul>
  );
}
