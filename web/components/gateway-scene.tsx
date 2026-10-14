'use client';

// The gateway picture: the team's film of coins riding a rail into a machine and coming out
// changed, with the X-ray lens over it (components/xray-lens.tsx). Phones and visitors who
// prefer reduced motion see the same code laid out under the film instead.
import SceneFilm from '@/components/scene-film';
import XrayLens, { XrayCode } from '@/components/xray-lens';

export default function GatewayScene({ mender }: { mender: boolean }) {
  return (
    <div className="scene">
      <SceneFilm />
      <span className="scene-label scene-label-app">Your app, on version 1</span>
      <span className={`scene-label scene-label-mender ${mender ? '' : 'is-off'}`}>{mender ? 'Mender' : 'Mender is off'}</span>
      <span className="scene-label scene-label-api">API version 2</span>
      <XrayLens mender={mender} />
      <div className="xray-static"><XrayCode mender={mender} /></div>
      <p className="scene-hint">Move your pointer over the machine to see the code behind it.</p>
    </div>
  );
}
