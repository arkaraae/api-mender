'use client';

// The 3D gateway at the top of the homepage (the scene itself is lib/gateway-scene.ts). three.js
// loads after the page is shown; without WebGL a plain picture of the same flow is shown.
import { useEffect, useRef, useState } from 'react';
import type { SceneControls, Shot } from '@/lib/gateway-scene';

type Props = { mender: boolean; shot: Shot | null; onToggle: () => void };

export default function GatewayScene({ mender, shot, onToggle }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const appLabel = useRef<HTMLSpanElement>(null);
  const ringLabel = useRef<HTMLSpanElement>(null);
  const apiLabel = useRef<HTMLSpanElement>(null);
  const latest = useRef({ mender, onToggle });
  latest.current = { mender, onToggle };
  const controls = useRef<SceneControls | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    void (async () => {
      try {
        const [THREE, { RoundedBoxGeometry }, { buildScene }] = await Promise.all([
          import('three'),
          import('three/examples/jsm/geometries/RoundedBoxGeometry.js'),
          import('@/lib/gateway-scene'),
        ]);
        if (cancelled || !host.current || !canvas.current || !tip.current || !appLabel.current || !ringLabel.current || !apiLabel.current) return;
        const built = await buildScene(THREE, RoundedBoxGeometry, {
          host: host.current,
          canvas: canvas.current,
          tip: tip.current,
          labels: { app: appLabel.current, ring: ringLabel.current, api: apiLabel.current },
        }, { mender: () => latest.current.mender, toggle: () => latest.current.onToggle(), still });
        if (cancelled) built.dispose();
        else controls.current = built;
      } catch (error) {
        console.error('The 3D gateway could not start:', error);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      controls.current?.dispose();
      controls.current = null;
    };
  }, []);

  useEffect(() => { controls.current?.refresh(); }, [mender]);
  useEffect(() => { if (shot) controls.current?.fire(shot); }, [shot]);

  if (failed) {
    return (
      <div className="scene scene-flat" aria-label="Requests from an app on version 1 pass through Mender and reach API version 2.">
        <span>Your app, on version 1</span>
        <code>{'{"customerId":"acct_1"}'}</code>
        <strong>{mender ? 'Mender renames it' : 'Mender is off'}</strong>
        <code>{mender ? '{"accountId":"acct_1"}' : '{"customerId":"acct_1"}'}</code>
        <span>API version 2: {mender ? '200' : '422'}</span>
      </div>
    );
  }

  return (
    <div className="scene" ref={host}>
      <span className="aurora aurora-a" aria-hidden="true" />
      <span className="aurora aurora-b" aria-hidden="true" />
      <canvas ref={canvas} role="img" aria-label={`Requests from an app on version 1 travel to API version 2. Mender is ${mender ? 'on: it renames customerId to accountId and the API accepts them' : 'off: the API refuses them with 422'}.`} />
      <span className="scene-label" ref={appLabel} aria-hidden="true">Your app, on version 1</span>
      <span className={`scene-label scene-label-mender ${mender ? '' : 'is-off'}`} ref={ringLabel} aria-hidden="true">{mender ? 'Mender' : 'Mender is off'}</span>
      <span className="scene-label" ref={apiLabel} aria-hidden="true">API version 2</span>
      <div className="scene-tip" ref={tip} hidden aria-hidden="true"><strong /><span /></div>
    </div>
  );
}
