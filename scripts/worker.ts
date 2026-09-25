import { db, claimJob, finishJob, fetchSource, stripeAdapter, getRepo, inventory, analyze, audit, snapshot } from '../lib/core';

const job=claimJob();
if(!job){console.log('No jobs ready');process.exit(0)}
try{
  const tenant=String(job.tenant_id),repoId=String(job.repo_id);
  const repo=getRepo(tenant,repoId);
  if(!repo||repo.paused)throw new Error('Repository disconnected or paused');
  if(job.kind!=='monitor')throw new Error('Unsupported job');
  const root=String(repo.path||'');
  inventory(tenant,repoId,root);
  for(const sourceInfo of stripeAdapter.sourceUrls){
    const cancelled=db().prepare('SELECT cancelled FROM jobs WHERE id=?').get(job.id as string) as {cancelled:number};
    if(cancelled.cancelled)throw new Error('Job cancelled');
    const previous=db().prepare('SELECT * FROM sources WHERE provider=? AND kind=? AND simulated=0 ORDER BY retrieved_at DESC LIMIT 1').get('stripe',sourceInfo.kind) as Record<string,unknown>|undefined;
    const latest=await fetchSource('stripe',sourceInfo.kind,sourceInfo.url);
    if(!previous||previous.hash===latest.hash)continue;
    if(sourceInfo.kind==='openapi'){
      const before={id:String(previous.id),provider:'stripe',kind:'openapi' as const,url:String(previous.url),retrievedAt:String(previous.retrieved_at),hash:String(previous.hash),body:String(previous.body),simulated:false};
      for(const change of stripeAdapter.diff(before,latest))analyze(tenant,repoId,change,latest,String(repo.head));
    }else{
      const kind=sourceInfo.kind==='sdk_release'?'sdk' as const:'behavior' as const;
      analyze(tenant,repoId,{kind,endpoint:'*',description:`${sourceInfo.kind} source changed`,evidence:latest.body.slice(0,600),applicability:'unknown'},latest,String(repo.head));
    }
  }
  finishJob(String(job.id));audit(tenant,repoId,'worker','monitor.complete',{jobId:job.id});console.log(`Completed ${job.id}`);
}catch(e){const msg=e instanceof Error?e.message:String(e);finishJob(String(job.id),msg);console.error(`Job ${job.id} failed: ${msg}`);process.exitCode=1}
