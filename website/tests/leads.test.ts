import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleLeadRequest } from '../src/lib/leads.server.ts';
const origin = 'https://example.test';
function request(body: unknown, extra: Record<string,string> = {}) {
  return new Request(`${origin}/api/leads`, {method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
}
const valid = {email:'Sam@Example.com',intent:'early',source:'demo',consent:true};
test('unconfigured signup does not report success', async () => {
  const response = await handleLeadRequest(request(valid), {});
  assert.equal(response.status,503);
  assert.deepEqual(await response.json(),{error:'Signups are not configured'});
});
test('rejects invalid consent and cross-origin requests before storage', async () => {
  assert.equal((await handleLeadRequest(request({...valid,consent:false}),{})).status,400);
  assert.equal((await handleLeadRequest(request(valid,{Origin:'https://other.test'}),{})).status,403);
});
test('saves a consented enquiry through the server-only database key', async () => {
  const oldFetch = globalThis.fetch;
  let captured: {url:string;headers:Headers;body:Record<string,unknown>} | undefined;
  globalThis.fetch = async (input, init) => {
    captured = {url:String(input),headers:new Headers(init?.headers),body:JSON.parse(String(init?.body))};
    return new Response(null,{status:201});
  };
  try {
    const response = await handleLeadRequest(request(valid),{LEADS_DB_URL:'https://db.example.test',LEADS_DB_SECRET_KEY:'server-secret'});
    assert.equal(response.status,200);
    assert.equal(captured?.url,'https://db.example.test/rest/v1/website_leads?on_conflict=email,intent');
    assert.equal(captured?.headers.get('apikey'),'server-secret');
    assert.equal(captured?.headers.get('authorization'),null);
    assert.equal(captured?.body.email,'sam@example.com');
    assert.equal(captured?.body.source,'demo');
  } finally {globalThis.fetch = oldFetch;}
});
