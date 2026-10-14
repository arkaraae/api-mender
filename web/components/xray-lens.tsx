'use client';

// The X-ray lens: a liquid-glass window that follows the pointer over a film and shows the code
// behind that spot. Left third: what the old app sends. Middle: what Mender does. Right: what
// API version 2 gets. It closes when the pointer leaves the film or rests on something named
// in `ignore` (text, cards, the top bar). It attaches to its parent element.
import { useEffect, useRef } from 'react';

const LENS = { width: 420, height: 200 };

export function XrayCode({ mender }: { mender: boolean }) {
  return (
    <div className="xray">
      <div className="xray-col">
        <span className="xray-kicker">What the old app sends</span>
        <pre>{'POST /mender/v1/api/testbed/quotes\n{ "customerId": "acct_1",\n  "amountCents": 2500 }'}</pre>
      </div>
      <div className="xray-col">
        {mender
          ? <><span className="xray-kicker">What Mender does</span><pre>{'rule   rename customerId → accountId\nproof  request ✓   response ✓\nMender-Status: translated'}</pre></>
          : <><span className="xray-kicker is-off">Mender is off</span><pre>{'no rule runs\nthe request goes on unchanged\nMender-Status: (none)'}</pre></>}
      </div>
      <div className="xray-col">
        <span className="xray-kicker">What API version 2 gets</span>
        {mender
          ? <pre>{'POST /api/testbed/quotes\n{ "accountId": "acct_1",\n  "amountCents": 2500 }\n'}<b className="is-pass">200</b>{' { "id": "quote_…", "identity": "acct_1" }'}</pre>
          : <pre>{'POST /api/testbed/quotes\n{ "customerId": "acct_1",\n  "amountCents": 2500 }\n'}<b className="is-fail">422</b>{' { "error": "Request does not satisfy\n        the active contract" }'}</pre>}
      </div>
    </div>
  );
}

export default function XrayLens({ mender, ignore }: { mender: boolean; ignore?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const lens = ref.current;
    const el = lens?.parentElement;
    if (!lens || !el || !window.matchMedia('(hover: hover) and (min-width: 760px)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let open = 0;
    let targetOpen = 0;
    let first = true;
    let frame = 0;
    const tick = () => {
      x += (targetX - x) * 0.14;
      y += (targetY - y) * 0.14;
      open += (targetOpen - open) * 0.16;
      lens.style.transform = `translate(${(x - LENS.width / 2).toFixed(1)}px, ${(y - LENS.height / 2).toFixed(1)}px) scale(${(0.85 + open * 0.15).toFixed(3)})`;
      lens.style.opacity = open.toFixed(3);
      const settled = Math.abs(targetX - x) < 0.2 && Math.abs(targetY - y) < 0.2 && Math.abs(targetOpen - open) < 0.005;
      frame = settled ? 0 : requestAnimationFrame(tick);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(tick); };
    const onMove = (event: PointerEvent) => {
      if (ignore && event.target instanceof Element && event.target.closest(ignore)) { targetOpen = 0; schedule(); return; }
      const box = el.getBoundingClientRect();
      targetX = event.clientX - box.left;
      targetY = event.clientY - box.top;
      if (first) { x = targetX; y = targetY; first = false; }
      // Which part is under the pointer: where requests come from, Mender, or the API.
      const part = targetX / box.width;
      lens.dataset.zone = part < 0.36 ? 'app' : part < 0.66 ? 'mender' : 'api';
      targetOpen = 1;
      schedule();
    };
    const onLeave = () => { targetOpen = 0; schedule(); };
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(frame);
    };
  }, [ignore]);

  return (
    <div className="lens" ref={ref} aria-hidden="true" data-zone="mender" style={{ width: LENS.width, height: LENS.height }}>
      <XrayCode mender={mender} />
    </div>
  );
}
