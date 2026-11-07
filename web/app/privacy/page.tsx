import type { Metadata } from 'next';
import SiteFooter from '@/components/home-v2/site-footer';
import SiteHeader from '@/components/home-v2/site-header';
import WindowBand from '@/components/home-v2/window-band';
import '../check/check.css';
import '../home-v2.css';
import '../mv2-pages.css';

export const metadata: Metadata = {
  title: 'Alpha data notice · API Mender',
  description: 'What the API Mender alpha reads, stores, and sends to other services.',
};

const SECTIONS = [
  ['Your account', 'Your email address and sign-in details, handled by Supabase, plus the workspaces you belong to.'],
  ['What Mender reads', 'The source files of the repositories you select when installing the GitHub App, read during a scan to find API calls. It reads only those repositories, using short-lived access tokens.'],
  ['What Mender stores', 'Repository names, commit IDs, and API call locations (file, line, endpoint, and request field names). Also your OpenAPI documents, findings, and repair jobs, which include short before-and-after snippets of the changed line. It does not save your full source files.'],
  ['What Mender writes', 'Only when an editor selects Open draft repair PR: one branch and one draft pull request changing one file. Mender never merges.'],
  ['What goes to AI', 'Only when an editor selects Try AI field mapping: the API operation and the candidate field names go to Anthropic. Source code and field values are not sent. Nothing goes to AI otherwise.'],
  ['Optional database details', 'If you choose to add database schema details, Mender stores the column information you provide. It never connects to your database.'],
  ['Services involved', 'Cloudflare (hosting), Supabase (database and sign-in), GitHub (repository access), and Anthropic (AI field mapping only).'],
  ['Removing your data', 'Removing a repository from the GitHub App deletes its stored repository record and linked findings. There is no self-service account or workspace deletion yet, and no automatic deletion schedule. To request deletion, use the Join us form and mention data removal.'],
  ['Alpha status', 'API Mender is an early alpha offered as is. It may change, break, or miss API problems, and it has no security certifications. Review every draft pull request yourself, and connect a private repository only if you are authorized to.'],
];

export default function PrivacyPage() {
  return (
    <div className="mv2">
    <SiteHeader />
    <main className="marketing-page">
      <WindowBand scene="privacy" />
      <div className="check-page">
        <section className="check-hero">
          <p className="hero-kicker">ALPHA DATA NOTICE</p>
          <h1>What the alpha reads and stores.</h1>
          <p className="hero-subtitle">A plain description of the alpha as it works today. It is not our final privacy policy or terms of service, which will come before general release.</p>
        </section>
        <section className="check-card" aria-label="Data notice">
          <dl className="pricing-questions">
            {SECTIONS.map(([term, detail]) => <div key={term}><dt>{term}</dt><dd>{detail}</dd></div>)}
          </dl>
        </section>
      </div>
    </main>
    <SiteFooter />
    </div>
  );
}
