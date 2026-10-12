'use client';

// Compare two versions of an API description, right in the browser: what changed in plain words,
// whether old callers can be kept working, and the fix for a caller's code. Nothing is uploaded;
// descriptions on other sites are read through /api/mender/fetch only when the browser can't.

import { useEffect, useState } from 'react';
import yaml from 'js-yaml';
import { proveWithSchemas, rulesFromOpenApi } from '@/lib/mender/openapi.js';
import { changelog } from '@/lib/mender/rules.js';
import { fixConsumer } from '@/lib/mender/codefix.js';
import { pathsOf, summarize, touches } from '@/lib/mender/report.js';
import { quotesOpenApi } from '@/lib/quotes-testbed';

type Spec = { paths?: Record<string, unknown>; info?: { title?: string; version?: string } };
type Rule = Record<string, unknown>;
type Found = { rules: Rule[]; notes: { code: string; message: string }[]; operations: { status: string }[] };
type Proof = { ok: boolean; samples: number; checks: { endpoint: string; failures: { path: string; message: string }[] }[] };
type Item = { kind: 'bridged' | 'lost' | 'gone'; title: string; scope: string; fields: string[] };
type Note = { code: string; message: string; blocking: boolean };
type Report = { verdict: 'safe' | 'bridged' | 'breaks'; headline: string; detail: string; items: Item[]; attention: Note[]; counts: { endpoints: number; changes: number; toCheck: number } };
type Result = { found: Found; proof: Proof | null; report: Report; before: Spec; after: Spec };
type Source = { url: string; text: string; paste: boolean };
type Phase = 'idle' | 'reading' | 'comparing' | 'proving' | 'done';
type CodeCheck = { touched: { name: string; kind: string; title: string }[]; after: string; changes: { line: number; before: string; after: string }[]; summary: string; needsDecision: string | null };

const QUOTES_V1 = JSON.stringify(quotesOpenApi({ version: 1, operation: 'POST /api/testbed/quotes', requiredRequestFields: ['customerId', 'amountCents'], acceptedIdentityField: 'customerId' }), null, 2);

const QUOTES_CODE = `export async function createQuote(apiBaseUrl, customerId, amountCents) {
  const response = await fetch(\`\${apiBaseUrl}/api/testbed/quotes\`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId, amountCents }),
  });
  if (!response.ok) throw new Error(\`Quotes API returned \${response.status}\`);
  return response.json();
}
`;

const GITHUB = 'https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.';

const GITHUB_CODE = `const root = await github('/');
console.log('Hub:', root.hub_url);

const gists = await github('/gists/public');
for (const gist of gists) console.log(gist.id, gist.user.login);
`;

const EXAMPLES = [
  {
    id: 'quotes',
    label: 'Quote API: a renamed field',
    note: 'Our live test API. Version 2 is read from the site right now; version 1 is rebuilt by the same code that serves it.',
    before: { url: '', text: QUOTES_V1, paste: true },
    after: { url: '/api/testbed/openapi.json', text: '', paste: false },
    code: QUOTES_CODE,
  },
  {
    id: 'github',
    label: 'GitHub REST API: 2022 → 2026',
    note: 'GitHub’s real published descriptions, 13 MB each. Reading and checking takes a few seconds.',
    before: { url: `${GITHUB}2022-11-28.json`, text: '', paste: false },
    after: { url: `${GITHUB}2026-03-10.json`, text: '', paste: false },
    code: GITHUB_CODE,
  },
];

const KIND_LABEL: Record<Item['kind'], string> = { bridged: 'Mender bridges this', lost: 'Old callers lose this', gone: 'Endpoint removed' };
const FIRST = 8;
const pause = () => new Promise((done) => setTimeout(done, 30));

async function download(address: string) {
  const url = new URL(address, window.location.href);
  const direct = async () => {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${url.host} answered ${response.status}.`);
    return response.text();
  };
  if (url.origin === window.location.origin) return direct();
  try {
    return await direct();
  } catch {
    // Not every site lets a page read its files; the server reads public descriptions instead.
    const response = await fetch(`/api/mender/fetch?url=${encodeURIComponent(url.href)}`);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Could not read ${url.host}.`);
    }
    return response.text();
  }
}

function parse(text: string): Spec {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('It is empty.');
  const value = /^[{[]/.test(trimmed) ? JSON.parse(trimmed) : yaml.load(trimmed);
  if (!value || typeof value !== 'object' || !(value as Spec).paths) throw new Error('It is not an OpenAPI or Swagger description (there is no "paths" section).');
  return value as Spec;
}

async function read(side: string, source: Source) {
  try {
    return parse(source.paste ? source.text : await download(source.url.trim()));
  } catch (error) {
    throw new Error(`${side}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function copy(text: string, button: HTMLButtonElement) {
  void navigator.clipboard.writeText(text).then(() => {
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
}

function SourceBox({ label, hint, value, onChange }: { label: string; hint: string; value: Source; onChange: (next: Source) => void }) {
  return (
    <div className="check-source">
      <div className="check-source-head">
        <h3>{label}</h3>
        <button type="button" className="check-link" onClick={() => onChange({ ...value, paste: !value.paste })}>{value.paste ? 'Use an address instead' : 'Paste the file instead'}</button>
      </div>
      <p className="check-hint">{hint}</p>
      {value.paste
        ? <textarea aria-label={`${label}: the description`} spellCheck={false} value={value.text} onChange={(event) => onChange({ ...value, text: event.target.value })} placeholder="Paste an OpenAPI or Swagger description (JSON or YAML)" />
        : <input aria-label={`${label}: address of the description`} spellCheck={false} value={value.url} onChange={(event) => onChange({ ...value, url: event.target.value })} placeholder="https://example.com/openapi.json" />}
    </div>
  );
}

export default function ChangeCheck() {
  const [before, setBefore] = useState<Source>(EXAMPLES[0].before);
  const [after, setAfter] = useState<Source>(EXAMPLES[0].after);
  const [example, setExample] = useState(EXAMPLES[0].id);
  const [phase, setPhase] = useState<Phase>('idle');
  const [problem, setProblem] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [door, setDoor] = useState<'call' | 'run'>('call');
  const [code, setCode] = useState(EXAMPLES[0].code);
  const [codeCheck, setCodeCheck] = useState<CodeCheck | null>(null);

  function choose(id: string) {
    const picked = EXAMPLES.find((entry) => entry.id === id);
    if (!picked) return;
    setExample(id);
    setBefore(picked.before);
    setAfter(picked.after);
    setCode(picked.code);
    setResult(null);
    setCodeCheck(null);
    setProblem('');
  }

  async function run(oldSource: Source = before, newSource: Source = after) {
    setProblem('');
    setResult(null);
    setCodeCheck(null);
    setShowAll(false);
    try {
      setPhase('reading');
      const [oldSpec, newSpec] = await Promise.all([read('Before', oldSource), read('After', newSource)]);
      setPhase('comparing');
      await pause();
      const found = rulesFromOpenApi(oldSpec, newSpec) as Found;
      setResult({ found, proof: null, report: summarize({ found, proof: null }) as Report, before: oldSpec, after: newSpec });
      setPhase('proving');
      await pause();
      const proof = proveWithSchemas(oldSpec, newSpec, found.rules) as Proof;
      setResult({ found, proof, report: summarize({ found, proof }) as Report, before: oldSpec, after: newSpec });
      setPhase('done');
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
      setPhase('idle');
    }
  }

  // /check?before=…&after=… opens with those two addresses and checks them right away
  // (the watch page links here for each change it saw).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const first = params.get('before');
    const second = params.get('after');
    if (!first || !second) return;
    const oldSource = { url: first, text: '', paste: false };
    const newSource = { url: second, text: '', paste: false };
    setExample('own');
    setBefore(oldSource);
    setAfter(newSource);
    setCode('');
    void run(oldSource, newSource);
    // Runs once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function watchIt() {
    window.location.href = `/watch?url=${encodeURIComponent(new URL(after.url.trim(), window.location.href).href)}`;
  }

  function checkCode() {
    if (!result) return;
    const touched = touches(code, result.found.rules) as CodeCheck['touched'];
    // Only the changes this code touches, plus the renames the fixer can apply by itself.
    const relevant = result.found.rules.filter((rule) => rule.op === 'rename' || touched.some((hit) => String(rule.old ?? rule.new ?? rule.path ?? '').includes(hit.name.split('.').at(-1) ?? '')));
    const fix = fixConsumer(code, relevant, { paths: pathsOf(result.before) }) as Omit<CodeCheck, 'touched'>;
    setCodeCheck({ ...fix, touched });
  }

  const busy = phase === 'reading' || phase === 'comparing' || phase === 'proving';
  const report = result?.report;
  const items = report ? (showAll ? report.items : report.items.slice(0, FIRST)) : [];
  const rulesText = result ? JSON.stringify({ from: result.before.info?.version ?? 'old', to: result.after.info?.version ?? 'new', rules: result.found.rules }, null, 2) : '';
  const changes = result ? changelog({ from: result.before.info?.version ?? 'the old version', to: result.after.info?.version ?? 'the new version', rules: result.found.rules }) : '';

  return (
    <div className="check-page">
      <section className="check-hero">
        <p className="hero-kicker">FREE · NO SIGN-UP · RUNS IN YOUR BROWSER</p>
        <h1>Will this API change break anyone?</h1>
        <p className="hero-subtitle">Compare two versions of an API. See every change in plain words, whether old callers can be kept working, and the fix for your code.</p>
      </section>

      <section className="check-card" aria-labelledby="versions-title">
        <div className="check-card-head">
          <h2 id="versions-title"><span className="check-step">1</span>The two versions</h2>
          <div className="check-examples" role="group" aria-label="Examples">
            {EXAMPLES.map((entry) => (
              <button key={entry.id} type="button" className={`check-chip ${example === entry.id ? 'selected' : ''}`} onClick={() => choose(entry.id)}>{entry.label}</button>
            ))}
            <button type="button" className={`check-chip ${example === 'own' ? 'selected' : ''}`} onClick={() => { setExample('own'); setBefore({ url: '', text: '', paste: false }); setAfter({ url: '', text: '', paste: false }); setCode(''); setResult(null); setCodeCheck(null); }}>Your own API</button>
          </div>
        </div>
        {example !== 'own' && <p className="check-hint">{EXAMPLES.find((entry) => entry.id === example)?.note}</p>}
        <div className="check-sources">
          <SourceBox label="Before" hint="The version people use today." value={before} onChange={setBefore} />
          <SourceBox label="After" hint="The new version." value={after} onChange={setAfter} />
        </div>
        <div className="check-actions">
          <button type="button" className="pill-button pill-dark" disabled={busy} onClick={() => void run(before, after)}>{busy ? 'Checking…' : 'Check the change'}</button>
          <span className="check-phase" aria-live="polite">
            {phase === 'reading' && 'Reading both versions…'}
            {phase === 'comparing' && 'Comparing every endpoint…'}
            {phase === 'proving' && 'Proving the result with generated samples… (large APIs take a few seconds)'}
            {phase === 'done' && result?.proof && `Done. Checked ${result.report.counts.endpoints} endpoint${result.report.counts.endpoints === 1 ? '' : 's'} and ${result.proof.samples} samples.`}
          </span>
        </div>
        {problem && <p className="check-problem" role="alert">{problem}</p>}
      </section>

      {report && result && (
        <>
          <section className={`check-verdict verdict-${report.verdict}`} aria-live="polite">
            <span className="check-verdict-mark" aria-hidden="true">{report.verdict === 'safe' ? '✓' : report.verdict === 'bridged' ? '⇄' : '!'}</span>
            <div>
              <h2>{report.headline}</h2>
              <p>{report.detail}</p>
            </div>
          </section>

          <section className="check-stats" aria-label="Summary">
            <div><strong>{report.counts.endpoints}</strong><span>endpoints compared</span></div>
            <div><strong>{report.counts.changes}</strong><span>changes that affect old callers</span></div>
            <div><strong>{result.proof ? (result.proof.ok ? 'Yes' : 'No') : '…'}</strong><span>{result.proof ? `proof on ${result.proof.samples} samples` : 'proving'}</span></div>
          </section>

          {report.items.length > 0 && (
            <section className="check-card" aria-labelledby="changes-title">
              <h2 id="changes-title"><span className="check-step">2</span>What changed for old callers</h2>
              <ul className="check-changes">
                {items.map((item, index) => (
                  <li key={`${item.title}-${index}`} className={`change-${item.kind}`}>
                    <span className="change-badge">{KIND_LABEL[item.kind]}</span>
                    <div>
                      <p className="change-title">{item.title}</p>
                      {item.scope && <p className="change-scope">{item.scope}</p>}
                      {item.fields.length > 1 && <details><summary>Show the fields</summary><p className="change-fields">{item.fields.join(', ')}</p></details>}
                    </div>
                  </li>
                ))}
              </ul>
              {report.items.length > FIRST && <button type="button" className="check-link" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show fewer' : `Show all ${report.items.length} changes`}</button>}
            </section>
          )}

          {report.attention.length > 0 && (
            <details className="check-card check-attention">
              <summary>{report.attention.length} thing{report.attention.length === 1 ? '' : 's'} worth a look{report.attention.some((note) => note.blocking) ? ', including changes nothing can translate' : ''}</summary>
              <ul>
                {report.attention.map((note, index) => <li key={index} className={note.blocking ? 'blocking' : ''}>{note.message}</li>)}
              </ul>
            </details>
          )}

          <section className="check-card" aria-labelledby="next-title">
            <h2 id="next-title"><span className="check-step">3</span>What to do next</h2>
            <div className="check-doors" role="tablist" aria-label="Who you are">
              <button type="button" role="tab" aria-selected={door === 'call'} className={door === 'call' ? 'selected' : ''} onClick={() => setDoor('call')}>I call this API</button>
              <button type="button" role="tab" aria-selected={door === 'run'} className={door === 'run' ? 'selected' : ''} onClick={() => setDoor('run')}>I run this API</button>
            </div>

            {door === 'call' && (
              <div className="check-door">
                <p className="check-hint">Paste the code that calls this API. Mender points to every line the change touches and rewrites what it can safely change by itself.</p>
                {!after.paste && after.url.trim() && !after.url.includes('/api/mender/watch/') && (
                  <p className="check-hint">Want to know when it changes again? <button type="button" className="check-link" onClick={watchIt}>Watch this API</button> and Mender checks it every day.</p>
                )}
                <textarea aria-label="Your code" className="check-code" spellCheck={false} value={code} onChange={(event) => { setCode(event.target.value); setCodeCheck(null); }} placeholder="Paste JavaScript or TypeScript that calls the API" />
                <div className="check-actions"><button type="button" className="pill-button pill-dark" disabled={!code.trim()} onClick={checkCode}>Check my code</button></div>
                {codeCheck && (
                  <div className="check-code-result">
                    {codeCheck.touched.length === 0 && codeCheck.changes.length === 0
                      ? <p className="check-ok">This code does not use anything that changed.</p>
                      : <ul className="check-touched">{codeCheck.touched.map((hit) => <li key={hit.name} className={`change-${hit.kind}`}>Your code uses <code>{hit.name}</code>: {hit.title}</li>)}</ul>}
                    {codeCheck.changes.length > 0 && (
                      <>
                        <p className="check-ok">{codeCheck.summary}</p>
                        <ul className="check-diff">{codeCheck.changes.map((change) => <li key={change.line}><span className="diff-line">Line {change.line}</span><del>{change.before}</del><ins>{change.after}</ins></li>)}</ul>
                        <div className="check-block-head"><span>Fixed code</span><button type="button" className="check-link" onClick={(event) => copy(codeCheck.after, event.currentTarget)}>Copy</button></div>
                        <pre>{codeCheck.after}</pre>
                      </>
                    )}
                    {codeCheck.needsDecision && codeCheck.changes.length > 0 && <p className="check-hint">Still for a person: {codeCheck.needsDecision}</p>}
                  </div>
                )}
              </div>
            )}

            {door === 'run' && (
              <div className="check-door">
                {report.verdict === 'safe'
                  ? <p className="check-ok">Nothing to do: callers of the old version keep working.</p>
                  : <p className="check-hint">{report.verdict === 'bridged'
                    ? 'Ship the new version and keep old callers working: Mender translates their calls with the rules below, and every translated call is counted per caller so you know who still has to move.'
                    : 'Mender can bridge the changes marked in green. The ones in red remove things old callers may use, so tell those callers before you ship.'}</p>}
                <div className="check-block-head"><span>The rules Mender runs, no AI involved</span><button type="button" className="check-link" onClick={(event) => copy(rulesText, event.currentTarget)}>Copy</button></div>
                <pre className="check-scroll">{rulesText}</pre>
                <div className="check-block-head"><span>A changelog your customers can read</span><button type="button" className="check-link" onClick={(event) => copy(changes, event.currentTarget)}>Copy</button></div>
                <pre className="check-scroll">{changes}</pre>
                <p className="check-hint">See it working on a real API: <a href="/mender">our own Quote APIs run behind the Mender gateway</a>.</p>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
