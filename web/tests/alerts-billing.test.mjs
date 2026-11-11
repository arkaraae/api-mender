import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { openSecret, sealSecret } from '../lib/secret-box.ts';
import { dispatchFindingAlerts, isSlackWebhook, issueBody, slackMessage } from '../lib/finding-alerts.ts';
import { applyStripeEvent, repositoryLimitMessage, verifyStripeSignature } from '../lib/billing.ts';

const KEY = randomBytes(32).toString('base64');
const WS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const HOOK = 'https://hooks.slack.com/services/T000/B000/abcdefXYZ123';

// Minimal Supabase query builder over in-memory tables.
function fakeDatabase(tables) {
  const writes = [];
  return { writes, tables, from(table) {
    const filters = [];
    let operation = 'select';
    let payload;
    let options;
    const rows = () => (tables[table] ??= []).filter(row => filters.every(test => test(row)));
    const builder = {
      select() { return builder; }, order() { return builder; }, limit() { return builder; }, or() { return builder; },
      eq(column, value) { filters.push(row => row[column] === value); return builder; },
      in(column, values) { filters.push(row => values.includes(row[column])); return builder; },
      is(column, value) { filters.push(row => (row[column] ?? null) === value); return builder; },
      gte(column, value) { filters.push(row => row[column] >= value); return builder; },
      upsert(row, opts) { operation = 'upsert'; payload = row; options = opts; return builder; },
      insert(row) { operation = 'insert'; payload = row; return builder; },
      delete() { operation = 'delete'; return builder; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then(resolve, reject) {
        let result = { data: null, error: null };
        const list = (tables[table] ??= []);
        if (operation === 'select') result = { data: rows(), error: null };
        if (operation === 'insert') {
          if (table === 'stripe_events' && list.some(row => row.id === payload.id)) result = { data: null, error: { code: '23505' } };
          else { list.push(payload); writes.push({ table, operation, row: payload }); }
        }
        if (operation === 'upsert') {
          const keys = (options?.onConflict ?? 'id').split(',');
          const index = list.findIndex(row => keys.every(key => row[key] === payload[key]));
          if (index >= 0) list[index] = { ...list[index], ...payload }; else list.push({ ...payload });
          writes.push({ table, operation, row: payload });
        }
        if (operation === 'delete') tables[table] = list.filter(row => !filters.every(test => test(row)));
        return Promise.resolve(result).then(resolve, reject);
      },
    };
    return builder;
  } };
}

test('sealed secrets open only with the same key and workspace', async () => {
  const sealed = await sealSecret(KEY, WS, HOOK);
  assert.match(sealed, /^v1\./);
  assert.ok(!sealed.includes('hooks.slack.com'));
  assert.equal(await openSecret(KEY, WS, sealed), HOOK);
  await assert.rejects(openSecret(KEY, OTHER, sealed), 'bound to its workspace');
  await assert.rejects(openSecret(randomBytes(32).toString('base64'), WS, sealed));
  await assert.rejects(sealSecret(undefined, WS, HOOK), /MENDER_SETTINGS_KEY/);
});

test('only Slack incoming-webhook URLs are accepted', () => {
  assert.ok(isSlackWebhook(HOOK));
  for (const url of ['http://hooks.slack.com/services/a/b/c', 'https://hooks.slack.com.evil.example/services/a/b/c',
    'https://evil.example/services/a/b/c', 'https://hooks.slack.com/services/a/b', 'https://169.254.169.254/latest']) assert.ok(!isSlackWebhook(url), url);
});

const finding = (id, severity, created = '2026-11-10T12:00:00Z', extra = {}) => ({ id, workspace_id: WS, repository_id: 'r1',
  title: 'Request property `assignee` removed from POST /repos/{owner}/{repo}/issues', description: 'GitHub no longer accepts assignee. <script>',
  severity, status: 'Action required', created_at: created, dismissed_at: null,
  evidence: { codeUrl: 'https://github.com/acme/checkout/blob/abc/src/issues.ts#L10' }, ...extra });

test('new findings are posted to Slack once, above the severity threshold, after alerts were turned on', async () => {
  const database = fakeDatabase({
    workspace_alert_settings: [{ workspace_id: WS, slack_webhook_ciphertext: await sealSecret(KEY, WS, HOOK), github_issues: false,
      min_severity: 'medium', alerts_since: '2026-11-10T00:00:00Z' }],
    findings: [finding('f1', 'medium'), finding('f2', 'low'), finding('f3', 'high', '2026-11-09T12:00:00Z'), finding('f4', 'high', '2026-11-10T13:00:00Z', { dismissed_at: '2026-11-10T14:00:00Z' })],
    finding_notifications: [], monitored_repositories: [{ id: 'r1', full_name: 'acme/checkout', github_installation_id: null }],
  });
  const posts = [];
  const fetcher = async (url, init) => { posts.push({ url, body: JSON.parse(init.body) }); return new Response('ok'); };
  const now = Date.parse('2026-11-10T15:00:00Z');
  assert.deepEqual(await dispatchFindingAlerts(database, { MENDER_SETTINGS_KEY: KEY, SITE_ORIGIN: 'https://apimender.com' }, { fetcher, now }), { sent: 1, failed: 0 });
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, HOOK);
  assert.match(posts[0].body.text, /acme\/checkout/);
  assert.ok(!JSON.stringify(posts[0].body).includes('<script>'), 'finding text is escaped for Slack');
  assert.match(JSON.stringify(posts[0].body), /apimender\.com\/live\?finding=f1/);
  assert.deepEqual(database.tables.finding_notifications.map(row => [row.finding_id, row.channel, row.status]), [['f1', 'slack', 'sent']]);
  // A second run sends nothing new.
  assert.deepEqual(await dispatchFindingAlerts(database, { MENDER_SETTINGS_KEY: KEY }, { fetcher, now }), { sent: 0, failed: 0 });
  assert.equal(posts.length, 1);
});

test('a failed Slack post is retried a bounded number of times', async () => {
  const database = fakeDatabase({
    workspace_alert_settings: [{ workspace_id: WS, slack_webhook_ciphertext: await sealSecret(KEY, WS, HOOK), github_issues: false, min_severity: 'low', alerts_since: '2026-11-01T00:00:00Z' }],
    findings: [finding('f1', 'medium')], finding_notifications: [], monitored_repositories: [],
  });
  let calls = 0;
  const fetcher = async () => { calls++; return new Response('no', { status: 500 }); };
  for (let run = 0; run < 5; run++) await dispatchFindingAlerts(database, { MENDER_SETTINGS_KEY: KEY }, { fetcher, now: Date.parse('2026-11-10T15:00:00Z') });
  assert.equal(calls, 3);
  assert.equal(database.tables.finding_notifications[0].status, 'failed');
  assert.equal(database.tables.finding_notifications[0].attempts, 3);
});

test('GitHub issues are opened with an issues-only token, and skipped for repositories without the App', async () => {
  const database = fakeDatabase({
    workspace_alert_settings: [{ workspace_id: WS, slack_webhook_ciphertext: null, github_issues: true, min_severity: 'low', alerts_since: '2026-11-01T00:00:00Z' }],
    findings: [finding('f1', 'medium'), finding('f2', 'medium', '2026-11-10T12:00:00Z', { repository_id: 'r2' })], finding_notifications: [],
    monitored_repositories: [{ id: 'r1', full_name: 'acme/checkout', github_installation_id: 42 }, { id: 'r2', full_name: 'acme/public', github_installation_id: null }],
  });
  const requests = [];
  const tokens = [];
  const fetcher = async (url, init) => { requests.push({ url, init, body: JSON.parse(init.body) }); return Response.json({ html_url: 'https://github.com/acme/checkout/issues/7' }, { status: 201 }); };
  const result = await dispatchFindingAlerts(database, { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k' },
    { fetcher, now: Date.parse('2026-11-10T15:00:00Z'), token: async (installation, repo) => { tokens.push([installation, repo]); return 'issue-token'; } });
  assert.deepEqual(result, { sent: 1, failed: 0 });
  assert.deepEqual(tokens, [[42, 'checkout']]);
  assert.equal(requests[0].url, 'https://api.github.com/repos/acme/checkout/issues');
  assert.equal(requests[0].init.headers.authorization, 'Bearer issue-token');
  assert.match(requests[0].body.title, /^\[Mend\] Request property/);
  assert.match(requests[0].body.body, /nothing is merged automatically/);
  const rows = Object.fromEntries(database.tables.finding_notifications.map(row => [row.finding_id, row]));
  assert.equal(rows.f1.url, 'https://github.com/acme/checkout/issues/7');
  assert.equal(rows.f2.status, 'skipped');
});

test('messages link to the code and to Mend, and never include source code', () => {
  const body = issueBody(finding('f1', 'high'), 'https://apimender.com');
  assert.match(body, /https:\/\/github\.com\/acme\/checkout\/blob\/abc\/src\/issues\.ts#L10/);
  const message = slackMessage(finding('f1', 'high', undefined, { evidence: { codeUrl: 'javascript:alert(1)' } }), 'acme/checkout', 'https://apimender.com');
  assert.ok(!JSON.stringify(message).includes('javascript:'), 'only github.com code links are used');
});

const sign = (payload, secret, timestamp) => `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex')}`;

test('Stripe webhook signatures are verified, with a time window', async () => {
  const payload = '{"id":"evt_1"}';
  const now = Date.parse('2026-11-10T15:00:00Z');
  const t = Math.floor(now / 1000);
  assert.ok(await verifyStripeSignature(payload, sign(payload, 'whsec_test', t), 'whsec_test', now));
  assert.ok(!await verifyStripeSignature(payload, sign(payload, 'whsec_other', t), 'whsec_test', now));
  assert.ok(!await verifyStripeSignature(`${payload} `, sign(payload, 'whsec_test', t), 'whsec_test', now));
  assert.ok(!await verifyStripeSignature(payload, sign(payload, 'whsec_test', t - 600), 'whsec_test', now), 'old signatures are rejected');
  assert.ok(!await verifyStripeSignature(payload, null, 'whsec_test', now));
  assert.ok(!await verifyStripeSignature(payload, sign(payload, 'whsec_test', t), undefined, now));
});

test('subscription events set the plan from Stripe’s current state, once per event', async () => {
  const database = fakeDatabase({ workspace_billing: [{ workspace_id: WS, plan: 'free', status: 'none', stripe_customer_id: 'cus_A' }], stripe_events: [] });
  const config = { STRIPE_SECRET_KEY: 'sk_test', STRIPE_PRICE_PRO: 'price_PRO' };
  const fetched = [];
  const fetcher = async url => { fetched.push(url); return Response.json({ id: 'sub_1', customer: 'cus_A', status: 'active', metadata: { workspace_id: WS },
    items: { data: [{ price: { id: 'price_PRO' }, current_period_end: 1795000000 }] } }); };
  const event = { id: 'evt_1', type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } };
  assert.deepEqual(await applyStripeEvent(database, config, event, fetcher), { applied: true, workspaceId: WS, plan: 'pro', status: 'active' });
  assert.equal(database.tables.workspace_billing[0].plan, 'pro');
  assert.match(database.tables.workspace_billing[0].current_period_end, /^2026-11-18/);
  assert.equal(fetched[0], 'https://api.stripe.com/v1/subscriptions/sub_1');
  assert.deepEqual(await applyStripeEvent(database, config, event, fetcher), { applied: false, reason: 'duplicate' });
  // A canceled subscription returns the workspace to Free.
  const canceled = async () => Response.json({ id: 'sub_1', customer: 'cus_A', status: 'canceled', items: { data: [{ price: { id: 'price_PRO' } }] } });
  await applyStripeEvent(database, config, { id: 'evt_2', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } }, canceled);
  assert.equal(database.tables.workspace_billing[0].plan, 'free');
  assert.equal(database.tables.workspace_billing[0].status, 'canceled');
  // A Stripe outage lets the event be retried.
  const failing = async () => new Response('{}', { status: 500 });
  await assert.rejects(applyStripeEvent(database, config, { id: 'evt_3', type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } }, failing));
  assert.ok(!database.tables.stripe_events.some(row => row.id === 'evt_3'));
  assert.deepEqual(await applyStripeEvent(database, config, { id: 'evt_4', type: 'invoice.paid', data: { object: {} } }, fetcher), { applied: false, reason: 'ignored' });
});

test('the repository-limit database error becomes an upgrade message', () => {
  assert.equal(repositoryLimitMessage({ message: 'repository limit reached: this plan allows 3 repositories' }), 'Your plan allows 3 repositories. Upgrade to Pro to connect more.');
  assert.equal(repositoryLimitMessage({ message: 'duplicate key' }), null);
  assert.equal(repositoryLimitMessage(null), null);
});
