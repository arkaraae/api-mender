import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reportFailure } from '../lib/failure-alert.ts';

const config = { ALERT_WEBHOOK: 'https://hooks.example/alert', SITE_ORIGIN: 'https://mender.example' };

function recorder(response = new Response('ok')) {
  const sent = [];
  return { sent, fetcher: async (url, options) => { sent.push({ url, body: JSON.parse(options.body) }); return response; } };
}
const allow = async () => true;

test('a failure reaches both Slack and Discord fields, including Supabase-style errors', async () => {
  const { sent, fetcher } = recorder();
  await reportFailure(config, 'task-fields', { code: '42', message: 'database is down' }, { fetcher, claim: allow });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, config.ALERT_WEBHOOK);
  assert.match(sent[0].body.text, /https:\/\/mender\.example: task-fields: database is down/);
  assert.equal(sent[0].body.content, sent[0].body.text);
});

test('one task alerts at most hourly in an isolate, and tasks are limited separately', async () => {
  const { sent, fetcher } = recorder();
  const now = 1_000_000_000;
  await reportFailure(config, 'task-hourly', new Error('one'), { fetcher, claim: allow, now });
  await reportFailure(config, 'task-hourly', new Error('two'), { fetcher, claim: allow, now: now + 60_000 });
  await reportFailure(config, 'task-other', new Error('three'), { fetcher, claim: allow, now: now + 60_000 });
  await reportFailure(config, 'task-hourly', new Error('four'), { fetcher, claim: allow, now: now + 3_600_001 });
  assert.deepEqual(sent.map(item => item.body.text.split(': ').at(-1)), ['one', 'three', 'four']);
});

test('another isolate that already claimed the hour suppresses the alert', async () => {
  const { sent, fetcher } = recorder();
  await reportFailure(config, 'task-claimed', new Error('x'), { fetcher, claim: async () => false });
  assert.equal(sent.length, 0);
});

test('a database outage still alerts, because that is the failure worth hearing about', async () => {
  const { sent, fetcher } = recorder();
  await reportFailure(config, 'task-outage', new Error('x'), { fetcher,
    claim: async () => { throw new Error('database down'); } });
  assert.equal(sent.length, 1);
});

test('no webhook means log only, and a broken webhook never throws', async () => {
  const { sent, fetcher } = recorder();
  await reportFailure({}, 'task-silent', new Error('x'), { fetcher, claim: allow });
  assert.equal(sent.length, 0);
  await reportFailure(config, 'task-broken', new Error('x'), { claim: allow,
    fetcher: async () => { throw new Error('network'); } });
  await reportFailure(config, 'task-null', null, { fetcher, claim: allow });
  assert.match(sent[0].body.text, /task-null: null/);
});
