import { db, enqueue } from '../lib/core';
const bucket=new Date().toISOString().slice(0,13);
const repos=db().prepare('SELECT id,tenant_id FROM repositories WHERE paused=0').all() as {id:string;tenant_id:string}[];
for(const repo of repos)console.log(enqueue(repo.tenant_id,repo.id,'monitor',`monitor:${repo.id}:${bucket}`));
