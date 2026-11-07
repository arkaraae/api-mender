import type { Metadata } from 'next';
import SiteFooter from '@/components/home-v2/site-footer';
import SiteHeader from '@/components/home-v2/site-header';
import { PageHead } from '@/components/home-v2/page-parts';
import '../check/check.css';
import '../home-v2.css';
import '../mv2-pages.css';

export const metadata: Metadata = {
  title: 'Alpha setup guide · API Mender',
  description: 'Connect a repository, watch an API contract, and review your first draft repair.',
};

const STEPS: [string, React.ReactNode][] = [
  ['Create your workspace', <>Open <a href="/live">the workspace</a>, create an account, confirm your email, and name your workspace.</>],
  ['Install the GitHub App', <>Go to <b>Integrated services</b>, select <b>Connect first API</b>, then <b>Connect GitHub App</b>. Choose only the repositories Mender should see: the one holding your OpenAPI file and the ones that call that API.</>],
  ['Watch your API contract', <>Choose the repository holding the contract, enter the path to its <b>OpenAPI JSON</b> file, and select <b>Watch API contract</b>. YAML contracts are not supported in this flow.</>],
  ['Connect the code that calls it', <>Under <b>Watched API</b>, choose the API and the <b>Consumer codebase</b>, then select <b>Connect consumer</b>. Pushes to a connected repository start a new scan.</>],
  ['Add the CI proof workflow', <>Under <b>Customer CI proof setup</b>, enter a focused test command and the exact text it prints when the old request fails, then select <b>Generate proof workflow</b>. Commit that file to the repository&apos;s default branch yourself. Point the test at a test API or a safe read-only endpoint, never at production writes.</>],
  ['Review a finding', <>Open <b>Findings</b> and select <b>Open evidence</b>. If it&apos;s a false alarm, select <b>Dismiss</b>; you can restore it later. There are no alerts for findings yet, so check this page after API changes.</>],
  ['Open a draft repair', <>Select <b>Preview bounded repair</b>. If two fields could match, <b>Try AI field mapping</b> asks Claude to choose, limited to five attempts per workspace per day. Save the repair job, then select <b>Open draft repair PR</b>.</>],
  ['Check the proof, then decide', <>Your CI runs the test on the old and new code. Select <b>Check customer CI proof</b> to see the result. Mender never merges: a person on your team reviews the draft and merges it.</>],
];

const LIMITS = [
  ['Detected', 'REST APIs described by OpenAPI, called from JavaScript or TypeScript in GitHub repositories.'],
  ['Repaired', 'One case only: a literal fetch JSON body missing one required field, where an existing field was renamed.'],
  ['Not supported yet', 'Other languages, GitLab or Bitbucket, GraphQL or gRPC, dynamic URLs, and calls wrapped in helper functions.'],
  ['CI proof', 'A pass shows your test failed before the patch and passed after it. It does not show that every path is safe. If the base branch moves, the proof is withdrawn and you need a new repair.'],
];

export default function DocsPage() {
  return (
    <div className="mv2">
    <SiteHeader current="/docs" />
    <main className="marketing-page">
      <PageHead kicker="Alpha setup guide" title="From first repository to first draft repair." cta={{ href: '/live', label: 'Open the workspace' }}>
        API Mender is in alpha. Expect rough edges, and read <a href="/privacy">what it reads and stores</a> before connecting a private repository.
      </PageHead>

      <div className="mv2-split">
        <section aria-labelledby="steps-title">
          <p className="mv2-list-label" id="steps-title"><span aria-hidden="true">✚</span> Setup steps</p>
          <ol className="mv2-rows">
            {STEPS.map(([title, body], i) => (
              <li key={title}>
                <span className="mv2-row-n">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <h2>{title}</h2>
                  <p>{body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <aside className="mv2-aside" aria-labelledby="limits-title">
          <h2 id="limits-title">What the alpha can and can&apos;t do</h2>
          <dl className="mv2-defs">
            {LIMITS.map(([term, detail]) => <div key={term}><dt>{term}</dt><dd>{detail}</dd></div>)}
          </dl>
          <div className="mv2-dark-card">
            <h2>Report a problem <span aria-hidden="true">→</span></h2>
            <p>Open an <a href="https://github.com/arkaraae/api-mender/issues" target="_blank" rel="noopener noreferrer">issue on GitHub</a>. Issues are public, so leave out private code and repository details. For anything private, use the <a href="/#join">Join us form</a>.</p>
          </div>
        </aside>
      </div>
    </main>
    <SiteFooter />
    </div>
  );
}
