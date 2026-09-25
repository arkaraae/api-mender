import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHmac } from 'node:crypto';

const temp=mkdtempSync(join(tmpdir(),'relay-test-'));
process.env.DATA_DIR=resolve(import.meta.dirname,`../data/test-runtime-${process.pid}`);
const core=await import('../lib/core');
const fixture=resolve(import.meta.dirname,'../fixtures/sample-repo');
const baseline=core.snapshot('stripe','openapi','fixture://base',readFileSync(resolve(import.meta.dirname,'../fixtures/contracts/baseline.json'),'utf8'),true);
const breaking=core.snapshot('stripe','openapi','fixture://breaking',readFileSync(resolve(import.meta.dirname,'../fixtures/contracts/breaking.json'),'utf8'),true);
const tenant='tenant_a',repo='repo_a';
core.db().prepare('INSERT INTO tenants(id,name) VALUES(?,?)').run(tenant,'A');
core.db().prepare('INSERT INTO tenants(id,name) VALUES(?,?)').run('tenant_b','B');
core.db().prepare('INSERT INTO repositories(id,tenant_id,name,path,branch,head,provider,created_at) VALUES(?,?,?,?,?,?,?,?)').run(repo,tenant,'a/repo',fixture,'main',core.currentHead(fixture),'stripe',new Date().toISOString());
core.inventory(tenant,repo,fixture);
const change={...core.stripeAdapter.diff(baseline,breaking)[0],applicability:'applies' as const};

test('diff and AST analysis find the affected call; repeated analysis deduplicates',()=>{
  assert.equal(change.kind,'required_request_field');
  const first=core.analyze(tenant,repo,change,breaking,core.currentHead(fixture));
  const second=core.analyze(tenant,repo,change,breaking,core.currentHead(fixture));
  assert.equal(first.id,second.id);
  assert.equal(first.affected[0].file,'src/payments.ts');
  assert.deepEqual(first.affected[0].fields,['amount','currency']);
  assert.equal(core.listFindings(tenant).length,1);
  assert.equal(core.getFinding('tenant_b',first.id),undefined);
  assert.equal(core.getInventory('tenant_b',repo),undefined);
});

test('bounded job retries and idempotent enqueue',()=>{
  const id=core.enqueue(tenant,repo,'monitor','same-key');
  assert.equal(core.enqueue(tenant,repo,'monitor','same-key'),id);
  const job=core.claimJob();assert.equal(job?.id,id);
  core.finishJob(id,'temporary failure');
  const row=core.db().prepare('SELECT state,attempts FROM jobs WHERE id=?').get(id) as {state:string;attempts:number};
  assert.equal(row.state,'retry');assert.equal(row.attempts,1);
  core.db().prepare('UPDATE jobs SET run_after=? WHERE id=?').run('2000-01-01T00:00:00Z',id);
  core.claimJob();core.finishJob(id,'again');
  core.db().prepare('UPDATE jobs SET run_after=? WHERE id=?').run('2000-01-01T00:00:00Z',id);
  core.claimJob();core.finishJob(id,'last');
  assert.equal((core.db().prepare('SELECT state FROM jobs WHERE id=?').get(id) as {state:string}).state,'failed');
});

test('stale branch and failed validation block publication',async()=>{
  const root=join(temp,'repo');cpSync(fixture,root,{recursive:true});
  const finding=core.analyze(tenant,repo,change,breaking,core.currentHead(root));
  const proposal=await core.fixtureGenerator('capture_method').generate({root,finding,inventory:core.discover(root)});
  assert.equal(proposal.files.length,2);
  const bad=core.validatePatch(root,{...proposal,files:proposal.files.filter(x=>x.path.includes('contract.test'))},finding,breaking);
  assert.equal(bad.validation.status,'failed');core.dispose(bad.workspace);
  const good=core.validatePatch(root,proposal,{...finding,repoId:'repo_demo'},breaking);
  assert.equal(good.validation.status,'passed');core.dispose(good.workspace);
  writeFileSync(join(root,'src/payments.ts'),readFileSync(join(root,'src/payments.ts'),'utf8')+'\n// changed\n');
  assert.throws(()=>core.assertFresh(root,finding.baseCommit),/Stale branch/);
  rmSync(root,{recursive:true,force:true});
});

test('tenant API token mapping stays scoped',()=>{
  process.env.TENANT_TOKENS='tenant_a:token-a,tenant_b:token-b';
  assert.equal(core.authorize('token-a'),'tenant_a');
  assert.equal(core.authorize('token-b'),'tenant_b');
  assert.equal(core.authorize('bad'),null);
});

test('GitHub webhook rejects forged payloads',async()=>{
  const {verifyWebhook,installationAuthorized}=await import('../lib/github');
  process.env.GITHUB_WEBHOOK_SECRET='test-webhook-secret';
  const body='{"action":"ping"}';
  const signature='sha256='+createHmac('sha256','test-webhook-secret').update(body).digest('hex');
  assert.equal(verifyWebhook(body,signature),true);
  assert.equal(verifyWebhook(body+' ',signature),false);
  assert.equal(verifyWebhook(body,'sha256=deadbeef'),false);
  process.env.TENANT_INSTALLATIONS='tenant_a:123,tenant_b:456';
  assert.equal(installationAuthorized('tenant_a',123),true);
  assert.equal(installationAuthorized('tenant_b',123),false);
});
