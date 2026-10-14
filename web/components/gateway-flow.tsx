// Requests riding the rail in the gateway film: small chips travel into the machine and out
// again. With Mender on, each comes out changed (green, with a 200). With Mender off, each comes
// out exactly as it went in and gets a 422: nothing changed, still broken. Every chip carries a
// different change, the kinds of rules Mender's engine handles: rename, scale, move.
// Drawn as an SVG over the film with the same crop, so the rail lines up at any size. The
// animation is SVG's own (no script) and restarts when the switch is flipped.

const PATH = 'M -80 575 C 160 560, 240 470, 330 440 C 420 410, 470 470, 540 440 C 610 410, 650 395, 700 360 C 740 330, 770 240, 800 150';
const DUR = 4.4;
const CHIPS = [
  { delay: 0, before: '{ customerId }', after: '{ accountId }' },
  { delay: 1.1, before: '{ amount: 12.5 }', after: '{ amount_cents: 1250 }' },
  { delay: 2.2, before: '{ zip }', after: '{ postalCode }' },
  { delay: 3.3, before: '{ user.name }', after: '{ name }' },
];
const MONO = 'JetBrains Mono, Menlo, monospace';

export default function GatewayFlow({ mender }: { mender: boolean }) {
  return (
    <svg key={mender ? 'on' : 'off'} className="flow" viewBox="0 0 1000 562" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {CHIPS.map(({ delay, before, after }) => {
        const timing = { dur: `${DUR}s`, begin: `${delay}s`, repeatCount: 'indefinite' as const };
        return (
          <g key={before} opacity="0">
            <animateMotion {...timing} path={PATH} calcMode="spline" keyTimes="0;1" keySplines="0.3 0 0.7 1" />
            <animate {...timing} attributeName="opacity" values="0;1;1;1;0" keyTimes="0;0.05;0.9;0.97;1" />
            <g transform="translate(-92 -16)">
              <rect width="184" height="32" rx="7" fill="#1c1f26" stroke="rgba(255,255,255,.35)">
                {mender && <animate {...timing} attributeName="fill" values="#1c1f26;#1c1f26;#35e08f;#35e08f" keyTimes="0;0.58;0.62;1" />}
              </rect>
              {/* What went in. With Mender on it swaps for what comes out at the machine. */}
              <text x="92" y="21" textAnchor="middle" fontFamily={MONO} fontSize="13" fontWeight="500" fill="#ffffff">
                {before}
                {mender && <animate {...timing} attributeName="opacity" values="1;1;0;0" keyTimes="0;0.58;0.6;1" />}
              </text>
              {mender && (
                <text x="92" y="21" textAnchor="middle" fontFamily={MONO} fontSize="13" fontWeight="500" fill="#06130c" opacity="0">
                  {after}
                  <animate {...timing} attributeName="opacity" values="0;0;1;1" keyTimes="0;0.6;0.62;1" />
                </text>
              )}
              {/* The API's answer, after the machine. */}
              <text x="92" y="50" textAnchor="middle" fontFamily={MONO} fontSize="12" fontWeight="700" fill={mender ? '#35e08f' : '#ff5f57'} opacity="0">
                {mender ? '200' : '422 · unchanged'}
                <animate {...timing} attributeName="opacity" values="0;0;1;1" keyTimes="0;0.64;0.68;1" />
              </text>
            </g>
          </g>
        );
      })}
    </svg>
  );
}
