# Mender: ship breaking changes without breaking customers

Mender lets an API company ship a breaking change while customers pinned to the old version keep working. For each breaking change, Mender writes a small **adapter**, proves it on recorded real traffic with **replay**, then runs it in front of the newest API version. Every call that passes through the adapter is counted per customer, so the provider knows who still has to migrate and when the old version can be switched off.

Everything here runs in the browser with no build step.

## Run it

Serve this folder with any static file server, then open the page:

```bash
python3 -m http.server 4173 --directory mender
```

- Studio: http://localhost:4173/ (use Mender on your own API)
- Walkthrough: http://localhost:4173/walkthrough.html (the five-step story)
- Tests: http://localhost:4173/tests/ (15 tests: adapter, headers, pass-through, rules, replay)

## Mender Studio

1. **Call your API, old and new.** Enter a URL for each version (with `{path}` where the record path goes), any headers such as a version header or test key, and the record paths. Mender makes real GET calls to both versions and uses the answers as before/after records. It opens connected to the Parcel sandbox (`sandbox/`), a read-only test API served as plain files. You can also paste records by hand.
2. **Mender writes the adapter** as a short list of readable rules (`src/rules.js`): rename, scale, case, values, time, add, remove, endpoint_removed. "Find rules from examples" matches fields by value with no AI. "Write with AI" asks Claude, where the viewer can use it.
3. **Proof on your examples.** Every example runs through the rules both ways and must round-trip exactly.
4. **Try it.** Paste any answer from the new API and see what old customers receive, or any old request and see what the new API receives. Check whether an endpoint passes through or gets 410 Gone.
5. **Ship it.** Copy `mender-rules.json` and a `server.js` snippet that puts `withMender` in front of your handler.

Rules found from a single Parcel example pass replay on all 200 recorded calls (see the tests).

## The walkthrough

1. **Acme's app works on Parcel 2026-03-01.** Parcel is a made-up shipping API. Acme's checkout code never changes during the demo.
2. **Parcel ships 2026-09-01.** Five breaking changes: a renamed field, a new money format, a renamed status, a new timestamp format, and a removed endpoint. Acme's app crashes.
3. **Mender writes an adapter.** Plain code: `upgradeRequest` rewrites old requests on the way in, `downgradeResponse` rewrites new answers on the way out, and `untranslatable` lists calls no translation can save.
4. **Replay proves it.** 200 recorded calls run twice, once against the old version (to learn which fields change on every run, such as ids and timestamps) and once through the adapter. The first draft fails with 124 differences (`status` not renamed back, `created` in milliseconds). The final adapter matches all 196 translatable calls; 4 removed-endpoint calls get a 410 with a migration link.
5. **The adapter goes live.** Acme's app works again, every answer carries `Deprecation`, `Sunset` and `Link` headers (RFC 9745 and RFC 8594), and Parcel sees calls per customer on the old version.

## Files

| File | What it is |
| --- | --- |
| `src/mender.js` | The Mender runtime. `withMender(handler, options)` wraps any fetch-style handler (Next.js route handlers, Hono, Cloudflare Workers, Bun, Deno). |
| `src/rules.js` | The rules format: apply, verify, find rules from examples, and compile rules into an adapter. |
| `src/replay.js` | Replay with noise detection, the idea behind Twitter's Diffy applied to version adapters. |
| `src/adapters/2026-09-01.js` | The final adapter for Parcel 2026-03-01 → 2026-09-01. |
| `src/adapters/2026-09-01.first-draft.js` | A first draft with two bugs, kept to show replay catching them. |
| `sandbox/` | Parcel sandbox API: `GET sandbox/<version>/orders/<id>` over real HTTP. |
| `src/parcel.js` | Parcel's two versions, simulated in memory. |
| `src/traffic.js` | 200 sample calls from three customers, generated from a fixed seed. |
| `src/acme-app.js` | Acme's unchanged checkout code. |
| `tests/` | Browser test runner and tests. |

## Live vs. staged

- **Live:** the runtime, replay, headers and per-customer counts all run for real on every click.
- **Staged:** Claude wrote both adapter drafts ahead of time, standing in for Mender's AI writer. Parcel, its customers and their traffic are made up.

## Next

- Run the AI writer live: two API specs in, adapter out, replay as the gate.
- A real case: Strapi v4 → v5 response format and `documentId` changes.
- Migration pull requests for each customer still on the old version.
