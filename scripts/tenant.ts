import { db } from '../lib/core';
const [id,name]=process.argv.slice(2);
if(!id||!name||!/^tenant_[A-Za-z0-9_-]{2,50}$/.test(id))throw new Error('Usage: npm run tenant -- tenant_id "Workspace name"');
db().prepare('INSERT INTO tenants(id,name) VALUES(?,?)').run(id,name);
console.log(`Created ${id}`);
