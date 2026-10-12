// Reads a public API description for the /check page when the browser may not read it directly.
// Only https addresses on public hosts, only files that look like OpenAPI or Swagger, 20 MB at most.
const MAX_BYTES = 20 * 1024 * 1024;

const refuse = (status: number, message: string) => Response.json({ error: message }, { status, headers: { 'cache-control': 'no-store' } });

export async function GET(request: Request) {
  const here = new URL(request.url);
  let target: URL;
  try { target = new URL(here.searchParams.get('url') ?? ''); } catch { return refuse(400, 'Enter a full address that starts with https://'); }
  if (target.protocol !== 'https:') return refuse(400, 'Only https:// addresses can be read.');
  const host = target.hostname.toLowerCase();
  if (host === here.hostname || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || /^[\d.]+$/.test(host) || host.includes(':')) {
    return refuse(400, 'Use the address of a public website.');
  }
  let response: Response;
  try {
    response = await fetch(target, { headers: { accept: 'application/json, application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  } catch {
    return refuse(502, `Could not reach ${host}.`);
  }
  if (!response.ok) return refuse(502, `${host} answered ${response.status}.`);
  if (Number(response.headers.get('content-length') || 0) > MAX_BYTES) return refuse(413, 'That file is larger than 20 MB.');
  const body = await response.arrayBuffer();
  if (body.byteLength > MAX_BYTES) return refuse(413, 'That file is larger than 20 MB.');
  const start = new TextDecoder().decode(body.slice(0, 4096));
  if (!/\b(openapi|swagger)\b/i.test(start)) return refuse(422, 'That file does not look like an OpenAPI or Swagger description.');
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' } });
}
