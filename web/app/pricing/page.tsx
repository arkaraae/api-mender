import type { Metadata } from 'next';
import BrandLogo from '@/components/brand-logo';
import SalesForm from '@/components/sales-form';
import SiteNav from '@/components/site-nav';
import '../check/check.css';

export const metadata: Metadata = {
  title: 'Pricing · API Mender',
  description: 'Free for developers who call APIs. $28.98 per API per month for companies that run one. Enterprise: talk to us.',
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
      'A typed TypeScript client and a test server for any API',
      'A pull-request check for your API description, on GitHub',
    ],
    cta: { href: '/check', label: 'Check a change' },
    look: 'light',
  },
  {
    name: 'Pro',
    price: '$28.98',
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
    look: 'dark',
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    per: 'yearly contract',
    who: 'For companies with many APIs or strict rules',
    features: [
      'Everything in Pro, for all your APIs',
      'Run the gateway in your own Cloudflare account',
      'Our team helps write and review the rules for your APIs',
      'Support with response times agreed in the contract',
      'Invoices and yearly billing',
    ],
    cta: { href: '#contact-sales', label: 'Contact sales' },
    look: 'light',
  },
];

const QUESTIONS = [
  ['Why is it this cheap?', 'Mender works out the rules between two versions once and proves them. Calls through the gateway follow those rules; no AI model runs on your traffic, so each call costs almost nothing.'],
  ['What counts as one API?', 'One API description (OpenAPI or Swagger), with any number of endpoints and versions.'],
  ['Is anything charged now?', 'No. Pro is free while API Mender is in beta, and there is no card to enter.'],
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
          <p className="hero-subtitle">Developers who call APIs never pay. Companies that run an API pay per API, not per seat. Large teams talk to us.</p>
        </section>
        <section className="pricing-plans" aria-label="Plans">
          {PLANS.map((plan) => (
            <article key={plan.name} className={`pricing-plan ${plan.look === 'dark' ? 'pricing-plan-dark' : ''}`}>
              <div className="pricing-plan-head">
                <h2>{plan.name}</h2>
                {plan.note && <span className="pricing-note">{plan.note}</span>}
              </div>
              <p className="pricing-price"><strong>{plan.price}</strong> <span>{plan.per}</span></p>
              <p className="pricing-who">{plan.who}</p>
              <ul>{plan.features.map((feature) => <li key={feature}>{feature}</li>)}</ul>
              <a className={`pill-button ${plan.look === 'dark' ? 'pill-outline' : 'pill-dark'}`} href={plan.cta.href}>{plan.cta.label} <span aria-hidden="true">{plan.cta.href.startsWith('#') ? '↓' : '↗'}</span></a>
            </article>
          ))}
        </section>
        <section className="check-card" id="contact-sales" aria-labelledby="sales-title">
          <h2 id="sales-title">Contact sales</h2>
          <p className="check-hint">Tell us about your APIs. We reply within two working days.</p>
          <SalesForm />
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
