import { sign, createHmac, timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { db, audit, inventory, type Finding, type PatchProposal, type Validation } from './core';

const b64=(x:string|Buffer)=>Buffer.from(x).toString('base64url');
export function verifyWebhook(body:string,header:string|null){const secret=process.env.GITHUB_WEBHOOK_SECRET;if(!secret||!header?.startsWith('sha256='))return false;const expected='sha256='+createHmac('sha256',secret).update(body).digest('hex');const a=Buffer.from(header),b=Buffer.from(expected);return a.length===b.length&&timingSafeEqual(a,b)}
function appJwt(){const id=process.env.GITHUB_APP_ID,key=process.env.GITHUB_APP_PRIVATE_KEY_BASE64;if(!id||!key)throw new Error('GitHub App credentials missing');const now=Math.floor(Date.now()/1000);const input=`${b64(JSON.stringify({alg:'RS256',typ:'JWT'}))}.${b64(JSON.stringify({iat:now-60,exp:now+480,iss:id}))}`;return `${input}.${sign('RSA-SHA256',Buffer.from(input),Buffer.from(key,'base64').toString('utf8')).toString('base64url')}`}
async function request(method:string,path:string,token:string,body?:unknown){const response=await fetch(`https://api.github.com${path}`,{method,headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'relay-api-watch'},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();if(!response.ok)throw new Error(`GitHub ${response.status}: ${text.slice(0,300)}`);return text?JSON.parse(text):null}
export async function installationToken(id:number){if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid installation ID');const result=await request('POST',`/app/installations/${id}/access_tokens`,appJwt());return result.token as string}
export function installationAuthorized(tenantId:string,id:number){return (process.env.TENANT_INSTALLATIONS||'').split(',').some(entry=>{const [tenant,installation]=entry.split(':');return tenant===tenantId&&Number(installation)===id})}
function repoPath(fullName:string){if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName))throw new Error('Invalid repository name');return fullName.split('/').map(encodeURIComponent).join('/')}
export async function branchState(token:string,fullName:string,branch:string){if(!/^[A-Za-z0-9_./-]{1,120}$/.test(branch)||branch.includes('..'))throw new Error('Invalid branch');const repo=repoPath(fullName);const b=await request('GET',`/repos/${repo}/branches/${encodeURIComponent(branch)}`,token);const commit=await request('GET',`/repos/${repo}/git/commits/${b.commit.sha}`,token);return {sha:b.commit.sha as string,tree:commit.tree.sha as string}}
export async function remoteFile(token:string,fullName:string,path:string,ref:string){const repo=repoPath(fullName);const encoded=path.split('/').map(encodeURIComponent).join('/');const j=await request('GET',`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`,token);if(j.type!=='file'||j.encoding!=='base64')throw new Error(`Unsupported remote file ${path}`);return Buffer.from(j.content,'base64').toString('utf8')}
export async function connectRepository(tenantId:string,installationId:number,fullName:string,branch:string){
  if(!installationAuthorized(tenantId,installationId))throw new Error('Installation is not assigned to tenant');
  const token=await installationToken(installationId),repo=repoPath(fullName);
  await request('GET',`/repos/${repo}`,token);
  const head=await branchState(token,fullName,branch);
  const tree=await request('GET',`/repos/${repo}/git/trees/${head.tree}?recursive=1`,token);
  if(tree.truncated)throw new Error('Repository tree truncated; onboarding requires review');
  const allowed=(tree.tree as {path:string;type:string;mode:string;size:number}[]).filter(x=>x.type==='blob'&&x.mode==='100644'&&x.size<300_000&&/^(package(-lock)?\.json|[^/].*\.[cm]?[jt]sx?)$/.test(x.path)&&!/(^|\/)(node_modules|dist|\.next|vendor)\//.test(x.path));
  if(allowed.length>250||allowed.reduce((n,x)=>n+x.size,0)>5_000_000)throw new Error('Repository exceeds bounded onboarding limits');
  const id='repo_'+createHash('sha256').update(`${tenantId}:${fullName}`).digest('hex').slice(0,16);
  const root=resolve(process.env.DATA_DIR||join(/*turbopackIgnore: true*/ process.cwd(),'data/current'),'repositories',id);
  mkdirSync(root,{recursive:true});
  for(const file of allowed){const target=resolve(root,file.path);if(!target.startsWith(root+'/'))throw new Error('Unsafe repository path');const content=await remoteFile(token,fullName,file.path,head.sha);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content)}
  db().prepare('INSERT INTO repositories(id,tenant_id,name,path,branch,head,provider,github_installation_id,created_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,branch=excluded.branch,head=excluded.head,github_installation_id=excluded.github_installation_id').run(id,tenantId,fullName,root,branch,head.sha,'stripe',String(installationId),new Date().toISOString());
  const scanned=inventory(tenantId,id,root);audit(tenantId,id,'github-app','repository.connected',{fullName,branch,head:head.sha,files:allowed.length});
  return {id,fullName,branch,head:head.sha,inventory:scanned};
}
export async function publishPullRequest(input:{tenantId:string;repoId:string;installationId:number;fullName:string;branch:string;finding:Finding;proposal:PatchProposal;validation:Validation;body:string;draft?:boolean}){
  const {tenantId,repoId,installationId,fullName,branch,finding,proposal,validation}=input;
  if(!installationAuthorized(tenantId,installationId))throw new Error('Installation is not assigned to tenant');
  if(finding.tenantId!==tenantId||finding.repoId!==repoId)throw new Error('Tenant mismatch');
  if(validation.findingId!==finding.id||validation.status!=='passed'||validation.checks.some(c=>!c.ok))throw new Error('Validation has not passed');
  if(proposal.needsDecision||!proposal.files.length)throw new Error('Patch requires a decision');
  if(proposal.files.some(f=>f.path.startsWith('/')||f.path.includes('..')))throw new Error('Unsafe patch path');
  const token=await installationToken(installationId),repo=repoPath(fullName);
  await request('GET',`/repos/${repo}`,token);
  const head=await branchState(token,fullName,branch);
  const record=db().prepare('SELECT head FROM repositories WHERE tenant_id=? AND id=?').get(tenantId,repoId) as {head:string}|undefined;
  if(!record||record.head!==head.sha||finding.baseCommit!==head.sha)throw new Error('Stale target branch');
  for(const file of proposal.files){const existing=await remoteFile(token,fullName,file.path,head.sha).catch(e=>{if(file.before===''&&e instanceof Error&&e.message.startsWith('GitHub 404:'))return '';throw e});if(existing!==file.before)throw new Error(`Stale remote file ${file.path}`)}
  const prBranch=`relay/${finding.id}`;
  const existing=await request('GET',`/repos/${repo}/pulls?head=${encodeURIComponent(fullName.split('/')[0]+':'+prBranch)}&state=open`,token) as {html_url:string}[];
  if(existing.length)return {url:existing[0].html_url,created:false};
  const tree=await request('POST',`/repos/${repo}/git/trees`,token,{base_tree:head.tree,tree:proposal.files.map(f=>({path:f.path,mode:'100644',type:'blob',content:f.after}))});
  const commit=await request('POST',`/repos/${repo}/git/commits`,token,{message:`fix(stripe): ${finding.title}`,tree:tree.sha,parents:[head.sha]});
  await request('POST',`/repos/${repo}/git/refs`,token,{ref:`refs/heads/${prBranch}`,sha:commit.sha});
  const pr=await request('POST',`/repos/${repo}/pulls`,token,{title:`[Relay] ${finding.title}`,head:prBranch,base:branch,body:input.body,draft:input.draft??false});
  audit(tenantId,repoId,'github-app','pull_request.created',{findingId:finding.id,url:pr.html_url,baseSha:head.sha});
  return {url:pr.html_url as string,created:true};
}
