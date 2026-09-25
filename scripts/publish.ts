import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { db, getFinding, getPatch, getValidation, transition } from '../lib/core';
import { publishPullRequest } from '../lib/github';

const [tenantId,findingId]=process.argv.slice(2);
if(!tenantId||!findingId)throw new Error('Usage: npm run publish -- <tenantId> <findingId>');
const finding=getFinding(tenantId,findingId),patch=getPatch(tenantId,findingId),validation=getValidation(tenantId,findingId);
if(!finding||!patch||!validation)throw new Error('Finding, patch, or validation missing');
const repo=db().prepare('SELECT * FROM repositories WHERE tenant_id=? AND id=?').get(tenantId,finding.repoId) as Record<string,unknown>|undefined;
if(!repo?.github_installation_id)throw new Error('GitHub App installation missing for repository');
const body=patch.artifact?readFileSync(resolve(process.cwd(),patch.artifact),'utf8'):`Upstream change: ${finding.title}\nEvidence: ${finding.evidenceUrl}\nValidation: ${validation.status}\nRemaining uncertainty: ${finding.limitations.join('; ')}\nRollback: revert this PR.`;
const result=await publishPullRequest({tenantId,repoId:finding.repoId,installationId:Number(repo.github_installation_id),fullName:String(repo.name),branch:String(repo.branch),finding,proposal:patch.proposal,validation,body,draft:finding.evidenceUrl.startsWith('fixture:')});
db().prepare('UPDATE patches SET pr_url=? WHERE tenant_id=? AND finding_id=?').run(result.url,tenantId,findingId);
if(finding.status==='Action required')transition(finding,'Patching','Publishing validated patch');
if(finding.status==='Patching')transition(finding,'Validating','Validation already passed');
if(finding.status==='Validating')transition(finding,'PR opened',`GitHub PR ${result.url}`);
console.log(result.url);
