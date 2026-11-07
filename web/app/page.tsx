import type { Metadata } from 'next';
import AuthCallbackRedirect from '@/components/auth-callback-redirect';
import JoinForm from '@/components/join-form';
import SiteHeader from '@/components/home-v2/site-header';
import TypedHeadline from '@/components/home-v2/typed-headline';
import GatewayBoard from '@/components/home-v2/gateway-board';
import './home-v2.css';

export const metadata: Metadata = {
  title: 'API Mender · APIs change. Your integrations shouldn’t break.',
  description: 'Mender checks the change, fixes the code that calls the API, and keeps old apps working through its gateway. No AI runs on your traffic.',
  openGraph: {
    title: 'API Mender',
    description: 'APIs change. Nothing breaks.',
    url: 'https://apimender.com',
    images: [{ url: 'https://apimender.com/home/og.png', width: 1920, height: 1080, alt: 'API Mender' }],
  },
  twitter: { card: 'summary_large_image', images: ['https://apimender.com/home/og.png'] },
};

const FORMATS = ['OpenAPI 3.1', 'Swagger 2.0', 'GraphQL SDL', 'gRPC / Protobuf', 'JSON Schema', 'AsyncAPI', 'Postman', 'Webhooks'];

const STEPS = [
  {
    title: 'Read both versions',
    text: 'Give Mender the old and the new API description. It finds every change, field by field, and says who it breaks.',
    sample: 'POST /quotes: customerId is now accountId',
    icon: <><path d="M5.6 20h7.9M5.6 20c-.9 0-1.6-.7-1.6-1.6V5.6C4 4.7 4.7 4 5.6 4h9.8L20 8.6v3.9" /><path d="M15 4v4.6h5" /><path d="M7.5 10h6M7.5 13h4" /><circle cx="17.2" cy="16.8" r="3.2" /><path d="M19.6 19.2 21.5 21.1" /></>,
  },
  {
    title: 'Prove the rule',
    text: 'Every old request has to become a valid new one, and every new answer has to turn back into what old callers expect. If Mender cannot prove it, it changes nothing.',
    sample: 'rename customerId to accountId: proved both ways',
    icon: <><path d="M12 3l7 3v5.5c0 4.2-3 7.7-7 9.5-4-1.8-7-5.3-7-9.5V6z" /><path d="M8.8 12l2.2 2.2 4.2-4.4" /></>,
  },
  {
    title: 'Translate on the way in',
    text: 'Old callers send their requests to /mender/v1/… and get the answers they were built for. A header says what Mender did.',
    sample: 'Mender-Status: translated',
    icon: <><path d="M4 20.5V10a8 8 0 0 1 16 0v10.5" /><path d="M8.2 20.5v-9.8a3.8 3.8 0 0 1 7.6 0v9.8" /><path d="M2.5 20.5h19" /></>,
  },
  {
    title: 'See who still calls version 1',
    text: 'Every old-version call is counted by caller, so you know whom to remind before you switch version 1 off.',
    link: { href: '/mender', label: 'See the live list →' },
    icon: <><path d="M2.6 12C4.5 7.9 8 5.5 12 5.5s7.5 2.4 9.4 6.5c-1.9 4.1-5.4 6.5-9.4 6.5S4.5 16.1 2.6 12z" /><circle cx="12" cy="12" r="3.3" /></>,
  },
];

const RESOURCES = [
  { href: '/docs', name: 'docs', label: 'Read the docs' },
  { href: '/mender', name: 'gateway', label: 'Live gateway' },
  { href: '/check', name: 'how_it_works', label: 'How it works' },
];

export default function Home() {
  return (
    <div className="mv2">
      <AuthCallbackRedirect />
      <SiteHeader />

      <main>
        <section className="mv2-hero" aria-label="API Mender">
          <div className="mv2-stage">
            <video className="mv2-bg-video" src="/home/ascii-meadow.mp4" poster="/home/ascii-meadow_poster.webp" autoPlay muted loop playsInline aria-hidden="true" />
            <video className="mv2-screen-video" src="/home/ascii-wildflowers.mp4" poster="/home/ascii-wildflowers_poster.webp" autoPlay muted loop playsInline aria-hidden="true" />
            <picture className="only-light">
              <source media="(max-width: 700px)" srcSet="/home/hero_office_mobile_light.webp" />
              <img src="/home/hero_office_light.webp" alt="A sunlit office with three tall windows and a desk with a monitor" />
            </picture>
            <picture className="only-dark">
              <source media="(max-width: 700px)" srcSet="/home/hero_office_mobile_dark.webp" />
              <img src="/home/hero_office_dark.webp" alt="The same office in the evening, lit by two pendant lamps" />
            </picture>
          </div>
          <div className="mv2-hero-copy mv2-wrap">
            <span className="mv2-eyebrow">API Gateway</span>
            <TypedHeadline />
            <p className="mv2-hero-sub">Mender checks the change, fixes the code that calls the API, and keeps old apps working through its gateway. No AI runs on your traffic.</p>
            <div className="mv2-ctas">
              <a className="mv2-btn" href="/check">Start for free</a>
              <a className="mv2-btn-ghost" href="#join">Book a demo</a>
            </div>
            <span className="mv2-beta"><b>Beta</b> Pro is free while we are in beta</span>
          </div>
        </section>

        <section className="mv2-strip" aria-label="Supported API description formats">
          <span className="mv2-eyebrow">Reads every API description</span>
          <div className="mv2-marquee">
            <div className="mv2-track" aria-hidden="true">
              {[...FORMATS, ...FORMATS].map((f, i) => <span key={i} className={i % 2 ? 'alt' : undefined}>{f}</span>)}
            </div>
          </div>
        </section>

        <section className="mv2-section mv2-wrap" aria-labelledby="gw-title">
          <h2 className="mv2-h2" id="gw-title">Old requests go in. Version-two requests come out.</h2>
          <p className="mv2-lede">Every old-version call is translated, proved, and counted by caller, so you know who to remind before you switch version 1 off.</p>
          <GatewayBoard />
        </section>

        <section className="mv2-section mv2-wrap mv2-tight" aria-labelledby="how-title">
          <h2 className="mv2-h2" id="how-title">How Mender mends a breaking change</h2>
          <p className="mv2-lede">No AI runs on your traffic. Mender works out the rules once, proves them, and then follows them on every call.</p>
          <ol className="mv2-steps">
            {STEPS.map((step, i) => (
              <li key={step.title} className="mv2-step">
                <div className="mv2-step-head">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{step.icon}</svg>
                  <span className="mv2-step-n">0{i + 1} / 0{STEPS.length}</span>
                </div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
                {step.sample && <code>{step.sample}</code>}
                {step.link && <a href={step.link.href}>{step.link.label}</a>}
              </li>
            ))}
          </ol>
        </section>

        <div className="mv2-band">
          <section className="mv2-section mv2-wrap" id="join" aria-labelledby="join-title">
            <h2 className="mv2-h2" id="join-title">Interested in API Mender?</h2>
            <p className="mv2-lede">Want to try the product, collaborate, invest, share feedback, or simply follow along? Leave your name and email. We are open to every kind of conversation.</p>
            <div className="mv2-portal" aria-hidden="true">
              <img className="mv2-grid-art only-light" src="/home/grid_light.svg" alt="" />
              <img className="mv2-grid-art only-dark" src="/home/grid_dark.svg" alt="" />
              <img className="mv2-rings-art only-light" src="/home/gateway_rings_light.svg" alt="" />
              <img className="mv2-rings-art only-dark" src="/home/gateway_rings_dark.svg" alt="" />
              <span className="mv2-tag t1"><i>v1</i>{'{ customerId }'}</span>
              <span className="mv2-tag t2"><i>✓</i>proved both ways</span>
              <span className="mv2-tag t3"><i>v2</i>{'{ accountId }'}</span>
              <span className="mv2-tag t4"><i>200</i>translated</span>
            </div>
            <div className="mv2-join-card">
              <JoinForm />
            </div>
          </section>
        </div>

        <section className="mv2-section mv2-wrap" aria-labelledby="res-title">
          <h2 className="mv2-h2" id="res-title">Resources</h2>
          <p className="mv2-lede">The setup guide, the live gateway, and a walk through how a change gets mended.</p>
          <div className="mv2-res">
            {RESOURCES.map((r) => (
              <a key={r.name} href={r.href} aria-label={r.label}>
                <img className="only-light" src={`/home/${r.name}_light.png`} alt={r.label} width={638} height={561} />
                <img className="only-dark" src={`/home/${r.name}_dark.png`} alt={r.label} width={638} height={561} />
              </a>
            ))}
          </div>
        </section>
      </main>

      <footer className="mv2-footer">
        <div className="mv2-wrap">
          <div className="mv2-foot">
            <div><small>For API teams</small><a href="#join">Get in touch</a></div>
            <div><small>Try it</small><a href="/check">Check a change</a></div>
            <div><small>Read more</small><a href="/docs">Setup guide</a></div>
            <div><small>Pricing</small><a href="/pricing">Free in beta</a></div>
          </div>
          <div className="mv2-legal">
            <span>© 2026 API Mender · Know what changed. Know what to do.</span>
            <nav aria-label="More">
              <a href="/watch">Watch an API</a><a href="/demo">Team demo</a><a href="/privacy">Privacy</a><a href="/live">Sign in</a>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
