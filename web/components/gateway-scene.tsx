'use client';

// The gateway picture on the homepage: the team's film of coins riding a rail into a machine
// and coming out changed. Over it, an X-ray lens follows the pointer and shows the code behind
// that spot: what the old app sends (left), what Mender does (middle), what API version 2 gets
// (right). The lens closes when the pointer leaves. Phones and visitors who prefer reduced
// motion see the code laid out under the film instead, with no lens.
import { useEffect, useRef } from 'react';
import SceneFilm from '@/components/scene-film';

type Props = { mender: boolean };

const LENS = { width: 420, height: 200 };

function XrayCode({ mender }: Props) {
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

export default function GatewayScene({ mender }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el || !window.matchMedia('(hover: hover) and (min-width: 760px)').matches || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const lens = el.querySelector<HTMLElement>('.lens')!;
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
      const left = x - LENS.width / 2;
      const top = y - LENS.height / 2;
      lens.style.transform = `translate(${left.toFixed(1)}px, ${top.toFixed(1)}px) scale(${(0.85 + open * 0.15).toFixed(3)})`;
      lens.style.opacity = open.toFixed(3);
      const settled = Math.abs(targetX - x) < 0.2 && Math.abs(targetY - y) < 0.2 && Math.abs(targetOpen - open) < 0.005;
      frame = settled ? 0 : requestAnimationFrame(tick);
    };
    const onMove = (event: PointerEvent) => {
      const box = el.getBoundingClientRect();
      targetX = event.clientX - box.left;
      targetY = event.clientY - box.top;
      if (first) { x = targetX; y = targetY; first = false; }
      // Which part of the machine is under the pointer: where coins enter, the machine, or where they leave.
      const part = targetX / box.width;
      lens.dataset.zone = part < 0.36 ? 'app' : part < 0.66 ? 'mender' : 'api';
      targetOpen = 1;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onLeave = () => {
      targetOpen = 0;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    el.addEventListener('pointermove', onMove, { passive: true });
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className="scene" ref={host}>
      <SceneFilm />
      <span className="scene-label scene-label-app">Your app, on version 1</span>
      <span className={`scene-label scene-label-mender ${mender ? '' : 'is-off'}`}>{mender ? 'Mender' : 'Mender is off'}</span>
      <span className="scene-label scene-label-api">API version 2</span>
      <div className="lens" aria-hidden="true" data-zone="mender" style={{ width: LENS.width, height: LENS.height }}>
        <XrayCode mender={mender} />
      </div>
      {/* Without a pointer, the same details sit under the film. */}
      <div className="xray-static"><XrayCode mender={mender} /></div>
      <p className="scene-hint">Move your pointer over the machine to see the code behind it.</p>
    </div>
  );
}
