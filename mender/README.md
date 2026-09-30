# Mender: ship breaking changes without breaking customers

Mender lets an API company ship a breaking change while customers pinned to the old version keep working. For each breaking change, Mender writes a small **adapter**, proves it on recorded real traffic with **replay**, then runs it in front of the newest API version. Every call that passes through the adapter is counted per customer, so the provider knows who still has to migrate and when the old version can be switched off.

This folder is the first working demo. It runs entirely in the browser with no build step.

## Run it

Serve this folder with any static file server, then open the page:

```bash
python3 -m http.server 4173 --directory mender
```

- Demo: http://localhost:4173/
- Tests: http://localhost:4173/tests/ (10 tests: adapter, headers, pass-through, replay)

## What the demo shows

1. **Acme's app works on Parcel 2026-03-01.** Parcel is a made-up shipping API. Acme's checkout code never changes during the demo.
2. **Parcel ships 2026-09-01.** Five breaking changes: a renamed field, a new money format, a renamed status, a new timestamp format, and a removed endpoint. Acme's app crashes.
3. **Mender writes an adapter.** Plain code: `upgradeRequest` rewrites old requests on the way in, `downgradeResponse` rewrites new answers on the way out, and `untranslatable` lists calls no translation can save.
4. **Replay proves it.** 200 recorded calls run twice, once against the old version (to learn which fields change on every run, such as ids and timestamps) and once through the adapter. The first draft fails with 124 differences (`status` not renamed back, `created` in milliseconds). The final adapter matches all 196 translatable calls; 4 removed-endpoint calls get a 410 with a migration link.
5. **The adapter goes live.** Acme's app works again, every answer carries `Deprecation`, `Sunset` and `Link` headers (RFC 9745 and RFC 8594), and Parcel sees calls per customer on the old version.

## Files

| File | What it is |
| --- | --- |
| `src/mender.js` | The Mender runtime. `withMender(handler, options)` wraps any fetch-style handler (Next.js route handlers, Hono, Cloudflare Workers, Bun, Deno). |
| `src/replay.js` | Replay with noise detection, the idea behind Twitter's Diffy applied to version adapters. |
| `src/adapters/2026-09-01.js` | The final adapter for Parcel 2026-03-01 → 2026-09-01. |
| `src/adapters/2026-09-01.first-draft.js` | A first draft with two bugs, kept to show replay catching them. |
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
