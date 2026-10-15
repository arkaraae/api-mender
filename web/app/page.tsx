import AuthCallbackRedirect from '@/components/auth-callback-redirect';
import BrandLogo from '@/components/brand-logo';
import HomeHero from '@/components/home-hero';
import './home.css';
import './hero.css';

const STEPS = [
  {
    title: 'Read both versions',
    text: 'Give Mender the old and the new API description. It finds every change, field by field, and says who it breaks.',
    sample: 'POST /quotes: customerId is now accountId',
  },
  {
    title: 'Prove the rule',
    text: 'Every old request has to become a valid new one, and every new answer has to turn back into what old callers expect. If Mender cannot prove it, it changes nothing.',
    sample: 'rename customerId to accountId: proved both ways',
  },
  {
    title: 'Translate on the way in',
    text: 'Old callers send their requests to /mender/v1/… and get the answers they were built for. A header says what Mender did.',
    sample: 'Mender-Status: translated',
  },
  {
    title: 'See who still calls version 1',
    text: 'Every old-version call is counted by caller, so you know whom to remind before you switch version 1 off.',
    link: { href: '/mender', label: 'See the live list' },
  },
];

export default function Home() {
  return (
    <main className="marketing-page home">
      <AuthCallbackRedirect />
      <div className="home-dark">
        <HomeHero />
      </div>

      <section className="home-seam" aria-labelledby="seam-title">
        <div className="home-seam-intro">
          <h2 id="seam-title">How Mender mends a breaking change</h2>
          <p>No AI runs on your traffic. Mender works out the rules once, proves them, and then follows them on every call.</p>
        </div>
        <div className="seam-wrap">
          <span className="seam-thread" aria-hidden="true" />
          <ol className="seam">
          {STEPS.map((step) => (
            <li key={step.title}>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
              {step.sample && <code>{step.sample}</code>}
              {step.link && <a href={step.link.href}>{step.link.label}</a>}
            </li>
          ))}
          </ol>
        </div>
      </section>

      <section className="home-doors" aria-label="Who API Mender is for">
        <article className="door door-call">
          <h2>You call APIs</h2>
          <p className="door-price">Free</p>
          <p>Check what an API change means for your code, watch the APIs you depend on, and get the fix for the lines it touches.</p>
          <a className="home-button home-button-ink" href="/check">Check a change</a>
        </article>
        <article className="door door-run">
          <h2>You run an API</h2>
          <p className="door-price">$28.98 per API per month, free while in beta</p>
          <p>Ship breaking changes behind the gateway, with every rule proven and a list of who still calls the old version.</p>
          <a className="home-button home-button-thread" href="/pricing">See pricing</a>
        </article>
      </section>

      <footer className="marketing-footer home-footer">
        <span className="site-brand"><BrandLogo /></span>
        <span>Know what changed. Know what to do.</span>
        <nav aria-label="More">
          <a href="/watch">Watch an API</a>
          <a href="/demo">Team demo</a>
          <a href="/live">Live workspace</a>
        </nav>
      </footer>
    </main>
  );
}
