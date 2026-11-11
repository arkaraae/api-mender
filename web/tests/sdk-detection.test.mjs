import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverApiUsage, parseApiCalls } from '../lib/engine/inventory.ts';
import { analyzeImpact } from '../lib/engine/impact.ts';
import { contractEndpoint, getProvider } from '../lib/engine/providers/registry.ts';
import { plannedComparisons } from '../lib/provider-findings.ts';
import { sliceOperation, requestSchemaOf } from '../lib/engine/openapi-slice.ts';
import { inventoryFromContents } from '../lib/public-scan.ts';

const brief = calls => calls.map(call => [call.symbol, call.endpoint, call.origin, call.fields.join(','), call.fieldsComplete]);

test('JavaScript SDK clients map to the operations they send', () => {
  const source = `
import Stripe from 'stripe';
import { Octokit } from '@octokit/rest';
import OpenAI from 'openai';
import twilio from 'twilio';
const stripe = new Stripe(process.env.STRIPE_KEY, { apiVersion: '2024-06-20' });
const octokit = new Octokit({ auth: token });
const openai = new OpenAI();
const sms = twilio(sid, authToken);
export async function run(customerId, input) {
  await stripe.customers.create({ email: 'a@b.c', name: 'A' });
  await stripe.customers.update(customerId, { email: input.email });
  await stripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'], line_items: [] });
  await octokit.rest.issues.create({ owner: 'o', repo: 'r', title: 't', assignee: 'me' });
  await octokit.request('POST /repos/{owner}/{repo}/labels', { owner: 'o', repo: 'r', name: 'bug' });
  await openai.chat.completions.create({ model: 'gpt-x', messages: [] });
  await sms.messages.create({ to: '+1', from: '+2', body: 'hi' });
  await sms.messages('SM1').fetch();
  await stripe.customers.create(input);
}`;
  const calls = parseApiCalls('src/pay.ts', source);
  assert.deepEqual(brief(calls), [
    ['stripe.customers.create', 'POST /v1/customers', 'https://api.stripe.com', 'email,name', true],
    ['stripe.customers.update', 'POST /v1/customers/{}', 'https://api.stripe.com', 'email', true],
    ['stripe.checkout.sessions.create', 'POST /v1/checkout/sessions', 'https://api.stripe.com', 'mode,payment_method_types,line_items', true],
    ['octokit.issues.create', 'POST /repos/{}/{}/issues', 'https://api.github.com', 'title,assignee', true],
    ['octokit.request', 'POST /repos/{}/{}/labels', 'https://api.github.com', 'name', true],
    ['openai.chat.completions.create', 'POST /v1/chat/completions', 'https://api.openai.com', 'model,messages', true],
    ['sms.messages.create', 'POST /2010-04-01/Accounts/{}/Messages.json', 'https://api.twilio.com', 'To,From,Body', true],
    ['sms.messages().fetch', 'GET /2010-04-01/Accounts/{}/Messages/{}.json', 'https://api.twilio.com', '', true],
    ['stripe.customers.create', 'POST /v1/customers', 'https://api.stripe.com', '', false],
  ]);
  assert.deepEqual(calls[0].headers, { 'stripe-version': '2024-06-20' }, 'the client apiVersion is the version pin');
  assert.equal(calls[3].headersComplete, true, 'an Octokit client without default headers sends no version header');
  assert.equal(calls[3].sdk, 'issues.create');
});

test('SDK detection needs the provider package and ignores look-alikes', () => {
  const source = `
const stripe = makeStripe();
stripe.customers.create({ email: 'x' });
import OpenAI from 'openai';
const local = new OpenAI({ baseURL: 'http://localhost:11434/v1' });
local.chat.completions.create({ model: 'llama' });
const octokit = { rest: { issues: { create() {} } } };
octokit.rest.issues.create({ owner: 'o', repo: 'r', title: 't' });`;
  assert.deepEqual(parseApiCalls('src/x.ts', source), []);
});

test('a client exported by one file is recognised where another file imports it', () => {
  const inventory = discoverApiUsage([
    { path: 'src/lib/stripe.ts', source: "import Stripe from 'stripe';\nexport const stripe = new Stripe(key);\n" },
    { path: 'src/routes/pay.ts', source: "import { stripe } from '../lib/stripe';\nexport const pay = () => stripe.paymentIntents.create({ amount: 1, currency: 'usd' });\n" },
  ]);
  assert.deepEqual(brief(inventory.calls), [['stripe.paymentIntents.create', 'POST /v1/payment_intents', 'https://api.stripe.com', 'amount,currency', true]]);
  assert.equal(inventory.calls[0].headersComplete, false, 'headers set in another file are unknown');
  assert.deepEqual(inventory.services.map(service => [service.providerId, service.recognition]), [['stripe', 'catalog']]);
});

test('Python HTTP calls and SDK clients are inventoried', () => {
  const source = `
import requests
import httpx
import stripe
from openai import OpenAI
from twilio.rest import Client

API = "unused"
client = OpenAI()
gh = httpx.Client(base_url="https://api.github.com")
sms = Client(sid, token)

def run(owner, repo, data):
    requests.post(f"https://api.github.com/repos/{owner}/{repo}/issues", json={"title": "t", "assignee": "me"},
                  headers={"X-GitHub-Api-Version": "2022-11-28"})
    gh.get(f"/repos/{owner}/{repo}")
    requests.get("https://api.example.com/v2/quotes?limit=5")
    requests.post("https://api.example.com/v2/quotes", json=data)
    client.chat.completions.create(model="gpt-x", messages=[], timeout=10)
    client.fine_tuning.jobs.create(model="m", training_file="f")
    stripe.Customer.create(email="a@b.c")
    stripe.checkout.Session.create(mode="payment", line_items=[])
    sms.messages.create(to="+1", from_="+2", body="hi")
    # requests.post("https://ignored.example/in/comment")
    print("requests.post('https://ignored.example/in/string')")
`;
  const calls = parseApiCalls('app/service.py', source);
  assert.deepEqual(brief(calls), [
    ['requests.post', 'POST /repos/{}/{}/issues', 'https://api.github.com', 'title,assignee', true],
    ['gh.get', 'GET /repos/{}/{}', 'https://api.github.com', '', true],
    ['requests.get', 'GET /v2/quotes', 'https://api.example.com', '', true],
    ['requests.post', 'POST /v2/quotes', 'https://api.example.com', '', false],
    ['client.chat.completions.create', 'POST /v1/chat/completions', 'https://api.openai.com', 'model,messages', true],
    ['client.fine_tuning.jobs.create', 'POST /v1/fine_tuning/jobs', 'https://api.openai.com', 'model,training_file', true],
    ['stripe.Customer.create', 'POST /v1/customers', 'https://api.stripe.com', 'email', true],
    ['stripe.checkout.Session.create', 'POST /v1/checkout/sessions', 'https://api.stripe.com', 'mode,line_items', true],
    ['sms.messages.create', 'POST /2010-04-01/Accounts/{}/Messages.json', 'https://api.twilio.com', 'To,From,Body', true],
  ]);
  assert.deepEqual(calls[0].headers, { 'x-github-api-version': '2022-11-28' });
  assert.equal(calls[0].headersComplete, true);
});

test('Python test files and virtualenvs are excluded from scans', () => {
  const call = 'import requests\nrequests.get("https://api.example.com/x")\n';
  const inventory = inventoryFromContents(new Map([
    ['app/a.py', call], ['tests/test_a.py', call], ['app/a_test.py', call], ['.venv/lib/x.py', call],
  ]));
  assert.deepEqual(inventory.files, ['app/a.py']);
  assert.deepEqual(inventory.tests.sort(), ['app/a_test.py', 'tests/test_a.py']);
});

test('OpenAI calls match contract keys without the /v1 server path', () => {
  const openai = getProvider('openai');
  assert.equal(contractEndpoint(openai, 'POST /v1/chat/completions'), 'POST /chat/completions');
  assert.equal(contractEndpoint(openai, 'POST /v10/x'), 'POST /v10/x');
  assert.equal(contractEndpoint(getProvider('stripe'), 'POST /v1/customers'), 'POST /v1/customers');
});

test('form-encoded request bodies are sliced and diffed like JSON bodies', async () => {
  const document = (properties, required = []) => ({ openapi: '3.0.0', paths: { '/v1/checkout/sessions': { post: {
    requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties, required } } } },
    responses: { 200: { description: 'ok' } } } } } });
  const before = await sliceOperation(document({ mode: { type: 'string' }, payment_method_types: { type: 'array' } }), 'POST /v1/checkout/sessions', { providerId: 'stripe', version: '2026-05-23', sourceUrl: 'https://x' });
  assert.deepEqual(Object.keys(requestSchemaOf(before).properties), ['mode', 'payment_method_types']);
});

test('snapshot providers compare from the baseline and set applicability from the adapter', async () => {
  const stripe = getProvider('stripe');
  const calls = parseApiCalls('src/pay.ts', "import Stripe from 'stripe';\nconst stripe = new Stripe(k);\nstripe.checkout.sessions.create({ mode: 'payment', payment_method_types: ['card'] });\n");
  const versions = new Map([['stripe', [
    { version: '2026-11-10', operationKeys: ['POST /v1/checkout/sessions'] },
    { version: '2026-05-23', operationKeys: ['POST /v1/checkout/sessions'] },
  ]]]);
  assert.deepEqual(plannedComparisons(calls, versions).map(plan => [plan.from, plan.to, plan.operation]), [['2026-05-23', '2026-11-10', 'POST /v1/checkout/sessions']]);
  const change = { providerId: 'stripe', operation: 'POST /v1/checkout/sessions', fromVersion: '2026-05-23', toVersion: '2026-11-10',
    kind: 'request-property-removed', fields: ['payment_method_types'], summary: 's', before: {}, after: {}, oldSha256: 'a', newSha256: 'b', oldSourceUrl: '', newSourceUrl: '' };
  const [finding] = await analyzeImpact({ provider: stripe, changes: [change], calls });
  assert.equal(finding.evidence.applicability, 'on-upgrade');
  assert.match(finding.evidence.staticChecks[0], /official SDK method `checkout\.sessions\.create`/);
  const openaiCalls = parseApiCalls('src/ai.ts', "import OpenAI from 'openai';\nconst ai = new OpenAI();\nai.images.generate({ prompt: 'x' });\n");
  const [required] = await analyzeImpact({ provider: getProvider('openai'), calls: openaiCalls, changes: [{ ...change, providerId: 'openai',
    operation: 'POST /images/generations', kind: 'request-property-required', fields: ['model'] }] });
  assert.equal(required.evidence.applicability, 'active');
  assert.equal(required.location.line, 3);
});

// ---------- repairs on SDK calls ----------
import { proposeRepair } from '../lib/engine/repair/index.ts';
import { contract, fakeModel, makeFinding, patch } from './fixtures/repair/reference.mjs';

const octokitFile = 'src/bugs.ts';
const octokitSource = [
  "import { Octokit } from '@octokit/rest';",
  'const octokit = new Octokit({ auth: process.env.GH_TOKEN });',
  'export async function fileBug(title, onCall) {',
  '  return octokit.rest.issues.create({',
  "    owner: 'acme',",
  "    repo: 'checkout',",
  '    title,',
  '    assignee: onCall,',
  '  });',
  '}',
  '',
].join('\n');

async function octokitFinding(source = octokitSource) {
  const [call] = parseApiCalls(octokitFile, source);
  const finding = makeFinding({ provider: { id: 'github-rest', name: 'GitHub REST API' } });
  finding.change = { ...finding.change, providerId: 'github-rest' };
  finding.location = { file: octokitFile, line: call.line, endLine: call.endLine, bodyLine: call.bodyLine, symbol: call.symbol };
  finding.evidence.call = call;
  return finding;
}

test('a model fix to an Octokit call passes every gate and leaves path parameters alone', async () => {
  const finding = await octokitFinding();
  assert.deepEqual(finding.evidence.call.fields, ['title', 'assignee']);
  const model = fakeModel(patch('    assignees: [onCall],', 8));
  const result = await proposeRepair({ finding, source: octokitSource, contract, model: model.config });
  assert.equal(result.abstained, undefined, JSON.stringify(result.policy?.filter(check => !check.passed) ?? result));
  assert.ok(result.policy.every(check => check.passed));
  assert.match(result.diff, /\+    assignees: \[onCall\],/);
});

test('a fix that edits an Octokit path parameter is rejected', async () => {
  const finding = await octokitFinding();
  const model = fakeModel({ decision: 'patch', reason: 'x', edits: [{ start_line: 5, end_line: 8,
    replacement: "    owner: 'evil',\n    repo: 'checkout',\n    title,\n    assignees: [onCall]," }] });
  const result = await proposeRepair({ finding, source: octokitSource, contract, model: model.config });
  assert.ok(result.abstained);
  assert.ok(result.policy.filter(check => !check.passed).map(check => check.name).includes('call-inventory-stable'));
  assert.match(result.policy.find(check => !check.passed).detail, /path parameter or SDK option/);
});
