// A local stand-in for api.github.com, used so the tests need no network.
//
// It models one documented difference between REST API versions for
// POST /repos/{owner}/{repo}/issues: version 2022-11-28 accepts the deprecated
// `assignee` property, version 2026-03-10 no longer does and ignores it.
// It is a model of the published contract, not GitHub itself.
//
// MENDER_PROVIDER_VERSION answers "what would this call do if GitHub served it
// under that version?" — which is what happens when the pinned version is
// retired or the header is bumped.
const served = () => process.env.MENDER_PROVIDER_VERSION || null;

export function installFakeGitHub() {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const { pathname, origin } = new URL(url);
    const match = /^\/repos\/([^/]+)\/([^/]+)\/issues$/.exec(pathname);
    if (origin !== 'https://api.github.com' || !match || options.method !== 'POST')
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    const headers = new Headers(options.headers);
    if (!headers.get('authorization')) return new Response(JSON.stringify({ message: 'Requires authentication' }), { status: 401 });
    const version = served() || headers.get('x-github-api-version') || '2022-11-28';
    const payload = JSON.parse(options.body);
    requests.push({ version, payload });
    if (typeof payload.title !== 'string' || !payload.title)
      return new Response(JSON.stringify({ message: 'Validation Failed' }), { status: 422 });
    const logins = new Set(Array.isArray(payload.assignees) ? payload.assignees : []);
    if (version < '2026-03-10' && typeof payload.assignee === 'string') logins.add(payload.assignee);
    return new Response(JSON.stringify({ number: 101, title: payload.title,
      assignees: [...logins].map(login => ({ login })) }), { status: 201 });
  };
  return { requests, restore: () => { globalThis.fetch = original; } };
}
