import type { Metadata } from 'next';
import BrandLogo from '@/components/brand-logo';
import SiteNav from '@/components/site-nav';
import '../check/check.css';

export const metadata: Metadata = {
  title: 'Pricing · API Mender',
  description: 'Free for developers who call APIs. API companies pay per API, not per seat.',
};

const PLANS = [
  {
    name: 'Free',
    price: '$0',
    per: 'forever',
    who: 'For developers who call APIs',
    features: [
      'Check any API change in plain words, with error, warning and info levels',
      'See which lines of your code a change touches, and the fix',
      'Watch the APIs you depend on, with daily checks and Slack or Discord alerts',
      'A typed TypeScript client for any API',
      'Test servers that answer like a new version, before it ships',
      'A pull-request check for your API description, on GitHub'
    ],
    cta: { href: '/check', label: 'Check a change' },
    dark: false,
  },
  {
    name: 'Pro',
    price: '$19',
    per: 'per API per month',
    who: 'For companies that run an API',
    note: 'Free while in beta',
    features: [
      'Everything in Free',
      'The gateway: old callers keep working after a breaking change',
      'Every rule proven before it runs; no AI on your traffic',
      'See which customers still call an old version, saved over time',
      'A changelog your customers can read',
    ],
    cta: { href: '/mender', label: 'See the gateway' },
    dark: true,
  },
];

const QUESTIONS = [
  ['Why is it this cheap?', 'Mender works out the rules between two versions once and proves them. Calls through the gateway follow those rules; no AI model runs on your traffic, so each call costs almost nothing.'],
  ['What counts as one API?', 'One API description (OpenAPI or Swagger), with any number of endpoints and versions.'],
  ['Does my API description leave my browser?', 'Checking a change runs in your browser. Mender only downloads a description for you when the website hosting it does not let browsers read it, or when you ask Mender to watch it.'],
  ['Do I need an account?', 'Not for checking or watching. The private link to a watch is all you need; share it only with your team.'],
];

export default function PricingPage() {
  return (
    <main className="marketing-page">
      <SiteNav current="/pricing" />
      <div className="check-page">
        <section className="check-hero">
          <p className="hero-kicker">PRICING</p>
          <h1>Free to use. Pay only for the APIs you run.</h1>
          <p className="hero-subtitle">Developers who call APIs never pay. Companies that run an API pay per API, not per seat.</p>
        </section>
        <section className="pricing-plans" aria-label="Plans">
          {PLANS.map((plan) => (
            <article key={plan.name} className={`pricing-plan ${plan.dark ? 'pricing-plan-dark' : ''}`}>
              <div className="pricing-plan-head">
                <h2>{plan.name}</h2>
                {plan.note && <span className="pricing-note">{plan.note}</span>}
              </div>
              <p className="pricing-price"><strong>{plan.price}</strong> <span>{plan.per}</span></p>
              <p className="pricing-who">{plan.who}</p>
              <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
              <a className={`pill-button ${plan.dark ? 'pill-outline' : 'pill-dark'}`} href={plan.cta.href}>{plan.cta.label} <span aria-hidden="true">↗</span></a>
            </article>
          ))}
        </section>
        <section className="check-card" aria-labelledby="questions-title">
          <h2 id="questions-title">Questions</h2>
          <dl className="pricing-questions">
            {QUESTIONS.map(([question, answer]) => (
              <div key={question}><dt>{question}</dt><dd>{answer}</dd></div>
            ))}
          </dl>
        </section>
      </div>
      <footer className="marketing-footer"><span className="site-brand"><BrandLogo /></span><span>Know what changed. Know what to do.</span><a href="/check">Check a change ↗</a></footer>
    </main>
  );
}
