'use client';

// The gateway picture: the team's film of coins riding a rail into a machine and coming out
// changed, with the X-ray lens over it (components/xray-lens.tsx). Phones and visitors who
// prefer reduced motion see the same code laid out under the film instead.
import GatewayFlow from '@/components/gateway-flow';
import SceneFilm from '@/components/scene-film';
import XrayLens, { XrayCode } from '@/components/xray-lens';

type Answer = { status: number; ms: number; throughMender: boolean };

export default function GatewayScene({ mender, answer }: { mender: boolean; answer?: Answer | null }) {
  // The stamp shows the real timing of the last call sent the same way as the switch is set.
  const timed = answer && answer.throughMender === mender ? answer : null;
  return (
    <div className={`scene ${mender ? 'is-on' : 'is-off'}`}>
      <div className="scene-film-wrap">
      <SceneFilm />
      <GatewayFlow mender={mender} />
      <span className="scene-label scene-label-app">Your app, on version 1</span>
      <span className={`scene-label scene-label-mender ${mender ? '' : 'is-off'}`}>{mender ? 'Mender: translating old requests' : 'Mender is off: nothing is translated'}</span>
      <span className={`scene-label scene-label-api ${mender ? '' : 'is-off'}`}>{mender ? 'API version 2: accepting' : 'API version 2: refusing old calls'}</span>
      <div className={`scene-stamp ${mender ? 'is-pass' : 'is-fail'}`} aria-live="polite"><strong>{timed ? timed.status : mender ? '200' : '422'}</strong><span>{mender ? 'Translated' : 'Refused'}{timed ? ` · ${timed.ms} ms` : ''}</span></div>
      <XrayLens mender={mender} />
      <p className="scene-hint">Move your pointer over the machine to see the code behind it.</p>
      </div>
      <div className="xray-static"><XrayCode mender={mender} /></div>
    </div>
  );
}
