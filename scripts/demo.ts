import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { db, snapshot, stripeAdapter, inventory, analyze, transition, fixtureGenerator, validatePatch, persistValidation, savePatch, currentHead, assertFresh, dispose, getFinding, getInventory, getValidation, getPatch, audit } from '../lib/core';

const project=resolve(import.meta.dirname,'..');
const root=join(project,'fixtures/sample-repo');
const artifacts=join(project,'artifacts');
mkdirSync(artifacts,{recursive:true});
const d=db();
d.prepare('INSERT OR IGNORE INTO tenants(id,name) VALUES(?,?)').run('tenant_demo','Demo workspace');
const head=currentHead(root);
d.prepare('INSERT OR IGNORE INTO repositories(id,tenant_id,name,path,branch,head,provider,created_at) VALUES(?,?,?,?,?,?,?,?)').run('repo_demo','tenant_demo','acme/checkout',root,'main',head,'stripe',new Date().toISOString());
d.prepare('UPDATE repositories SET head=? WHERE id=?').run(head,'repo_demo');
const url='fixture://simulated-stripe-contract';
const baseline=snapshot('stripe','openapi',url,readFileSync(join(project,'fixtures/contracts/baseline.json'),'utf8'),true);
const breaking=snapshot('stripe','openapi',url,readFileSync(join(project,'fixtures/contracts/breaking.json'),'utf8'),true);
const changes=stripeAdapter.diff(baseline,breaking);
if(changes.length!==1)throw new Error(`Expected one change, found ${changes.length}`);
const inv=inventory('tenant_demo','repo_demo',root);
const change={...changes[0],applicability:'applies' as const};
let finding=analyze('tenant_demo','repo_demo',change,breaking,head);
if(finding.status==='Detected'){transition(finding,'Analyzing',null);transition(finding,'Patching','Supported fixture recipe');}
if(finding.status==='Failed')transition(finding,'Patching','Demo retry');
if(finding.status==='Action required')transition(finding,'Patching','Revalidating local artifact');
if(finding.status!=='Patching'&&finding.status!=='Validating'&&finding.status!=='PR opened')throw new Error(`Unexpected finding state ${finding.status}`);
const proposal=await fixtureGenerator('capture_method').generate({root,finding,inventory:inv});
if(proposal.needsDecision)throw new Error(proposal.needsDecision);
const regressionOnly={...proposal,files:proposal.files.filter(x=>x.path.includes('contract.test'))};
const before=validatePatch(root,regressionOnly,finding,breaking);
writeFileSync(join(artifacts,'before-validation.json'),JSON.stringify(before.validation,null,2));
dispose(before.workspace);
if(before.validation.status!=='failed')throw new Error('Regression must fail before patch');
if(finding.status==='Patching')transition(finding,'Validating',null);
const after=validatePatch(root,proposal,finding,breaking);
persistValidation('tenant_demo',after.validation);
writeFileSync(join(artifacts,'after-validation.json'),JSON.stringify(after.validation,null,2));
if(after.validation.status!=='passed'){transition(finding,'Failed','Validation failed');throw new Error('Patched fixture failed validation');}
assertFresh(root,finding.baseCommit);
const patchParts:string[]=[];
for(const file of proposal.files){
  const oldPath=join(artifacts,`old-${file.path.replaceAll('/','-')}`),newPath=join(artifacts,`new-${file.path.replaceAll('/','-')}`);
  writeFileSync(oldPath,file.before);writeFileSync(newPath,file.after);
  const diff=spawnSync('git',['diff','--no-index','--',file.before?oldPath:'/dev/null',newPath],{encoding:'utf8'});
  let piece=diff.stdout||'';
  if(file.before)piece=piece.replaceAll(`a${oldPath}`,`a/${file.path}`);
  else piece=piece.replaceAll(`a${newPath}`,`a/${file.path}`);
  piece=piece.replaceAll(`b${newPath}`,`b/${file.path}`);
  patchParts.push(piece);rmSync(oldPath,{force:true});rmSync(newPath,{force:true});
}
const patch=patchParts.join('\n');
writeFileSync(join(artifacts,'demo.patch'),patch);
const pr=`# [Demo] Add capture_method for simulated PaymentIntent contract\n\n**Simulation:** This is a local artifact. No live Stripe change or GitHub PR is claimed.\n\n## Evidence\nThe simulated contract at ${url} adds \`capture_method\` to \`POST /v1/payment_intents\` required fields. Snapshot SHA-256: ${breaking.hash}.\n\n## Impact\n${finding.affected.map(x=>`- ${x.file}:${x.line} ${x.symbol}`).join('\n')}\n\n## Implementation\n- Explicitly set \`capture_method: "automatic"\` to preserve immediate capture.\n- Add regression test that fails against the prior code.\n\n## Validation\n- Regression before patch: ${before.validation.status}\n- Checks after patch: ${after.validation.checks.map(c=>`${c.name}: ${c.ok?'pass':'fail'}`).join('; ')}\n- Base commit/content hash: ${head}\n\n## Uncertainty and rollback\nThe source change is simulated. Real Stripe API version applicability and production behavior have not been verified. Revert the code and test commit if needed. Human review is required before merge.\n`;
writeFileSync(join(artifacts,'demo-pr.md'),pr);
savePatch('tenant_demo',finding.id,proposal,'artifacts/demo-pr.md',null);
if(finding.status==='Validating')transition(finding,'Action required','Local PR artifact ready for human review; no live GitHub PR');
audit('tenant_demo','repo_demo','demo','artifact.created',{path:'artifacts/demo-pr.md'});
dispose(after.workspace);
console.log(JSON.stringify({finding:getFinding('tenant_demo',finding.id),inventory:getInventory('tenant_demo','repo_demo'),validation:getValidation('tenant_demo',finding.id),patch:getPatch('tenant_demo',finding.id),artifact:'artifacts/demo-pr.md'},null,2));
