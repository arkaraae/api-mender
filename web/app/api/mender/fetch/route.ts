// Reads a public API description for the /check page when the browser may not read it directly.
// Only https addresses on public hosts, only files that look like OpenAPI or Swagger, 20 MB at most.
import { boundedBody, DescriptionTooLargeError, fetchPublicSource, publicHttps } from '@/lib/mender/public-source.js';

const refuse = (status: number, message: string) => Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(request: Request) {
  const here = new URL(request.url);
  let target: URL;
  try { target = publicHttps(here.searchParams.get('url')); } catch { return refuse(400, 'Enter the address of a public https:// API description.'); }
  if (target.hostname === here.hostname) return refuse(400, 'Use the address of another public website.');
  let response: Response;
  try {
    ({ response } = await fetchPublicSource(target.href, { blockedHostname: here.hostname, headers: { accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.5' } }));
  } catch {
    return refuse(502, 'Could not reach a public HTTPS API description.');
  }
  if (!response.ok) return refuse(502, `${target.hostname} answered ${response.status}.`);
  let body: ArrayBuffer;
  try { body = await boundedBody(response); }
  catch (error) { return error instanceof DescriptionTooLargeError ? refuse(413, error.message) : refuse(502, 'Could not read that description.'); }
  const start = new TextDecoder().decode(body.slice(0, 4096));
  if (!/\b(openapi|swagger)\b/i.test(start)) return refuse(422, 'That file does not look like an OpenAPI or Swagger description.');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
}
