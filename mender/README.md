# Mender: ship a breaking API change without breaking callers

When an API publishes a new version that no longer accepts what older callers send, those callers start failing. Mender sits in front of the newest version and translates: old-style requests are rewritten on the way in, and answers are rewritten on the way back. Callers keep working, the API team sees who still has to move, and each caller gets a small code fix to review.

No AI runs when a request comes through. The translation is a short list of rules that Mender works out by comparing the two versions, and proves before it uses them.

## The four steps

1. **Find the rules.** From two API descriptions (OpenAPI 3 or Swagger 2, JSON or YAML), or from pairs of example records. For the Quote API the result is one rule: `customerId is now accountId (in requests)`.
2. **Prove them.** Mender generates sample requests and answers from the descriptions, translates them, and checks that every one fits the other version. With example records, each must come out exactly as the other version has it, in both directions. Rules that fail the proof are never used.
3. **Translate.** `withMender(handler, options)` wraps any handler that takes a `Request` and returns a `Response`. It rewrites what older callers send and what they get back, and steps through several versions if needed.
4. **Count and fix.** Every old-version call is counted per caller. `fixConsumer` rewrites the caller's code from the same rules, so the fix is a one-line diff to review, not a guess.

## Run it

Mender Studio, by itself (no install; Python 3 only):

```bash
python3 mender/tools/serve.py 4173
```

Then open http://localhost:4173/ for the Studio, http://localhost:4173/walkthrough.html for the five-step story, and http://localhost:4173/tests/ for the tests in a browser.

Inside the API Mender site (needs Node.js 24):

```bash
npm ci
npm run dev
```

Then open http://localhost:3000/mender for the gateway page and http://localhost:3000/studio for the Studio.

All tests from the command line:

```bash
node mender/tests/run.mjs
```

Add a word to run a part of them (`node mender/tests/run.mjs quotes`). Set `MENDER_LIVE=1` to add four tests that make real calls to the deployed Quotes testbed.

## Inside the API Mender site

| Address | What it does |
| --- | --- |
| `/mender/v1/api/managed/quotes` | The gateway. A caller written for version 1 uses this instead of `/api/managed/quotes`. Works the same for `/api/testbed/…`. |
| `/mender` | A page showing each published API, the rules between its versions, whether they are proven, a button that sends one real old-style request both ways, and who still calls an old version. |
| `/api/mender/status` | The same as JSON. Add `?check=1` to send the real request. |
| `/api/mender/explain` | `POST { "oldSpec", "newSpec" }` or `{ "pairs": [{ "old", "new" }] }` and get rules, notes and a proof back. |
| `/studio` | Mender Studio, copied from this folder by `node mender/tools/publish-to-site.mjs`. A test fails if the copy is out of date. |

The code is `lib/mender-gateway.js` plus three small route files. It reads the contracts the API already publishes (`/api/managed/openapi.json` and `?version=N`), so a new version is picked up within a minute and nothing has to be configured per change. Answers carry a `Mender-Status` header: `translated`, `current-version`, or `no-proven-adapter` when the rules did not pass the proof and Mender changed nothing. Calls Mender has to refuse say why: `unknown-version`, `untranslatable`, `contract-unavailable`, `api-unreachable`.

The gateway reaches the API over HTTP at the site's own address. Two settings change that:

- `MENDER_UPSTREAM_URL` points it at another server, for example a local copy of the API.
- `lib/mender-local.js` lists the site's own handlers, for a host that does not let a site call itself. Then no request leaves the process.

To see a version change locally without touching the live database, run a stand-in for the managed API that already publishes version 2, and point the site at it:

```bash
node mender/tools/managed-standin.mjs 4188 customerId accountId
```

```bash
MENDER_UPSTREAM_URL=http://127.0.0.1:4188 npm run dev
```

The team's own consumer test then fails straight at the stand-in and passes through the gateway, with no change to the consumer:

```bash
MENDER_TEST_API_URL=http://127.0.0.1:4188 npm test --prefix examples/quote-api-consumer
```

```bash
MENDER_TEST_API_URL=http://localhost:3000/mender/v1 npm test --prefix examples/quote-api-consumer
```

The monitor (`scripts/managed-api-mender.mjs`) now asks Mender for the consumer fix first. When the rules are proven and the fix is complete, it uses that and needs no OpenAI key; otherwise it falls back to the model as before. Either way the fix still has to pass the consumer's live test before a pull request is opened.

## The rules

A rule names an old field and a new one, with dotted paths (`customer.address.city`), list items (`items[].sku`), and optionally where it applies (`"in": "request"`, `"endpoint": "POST /orders/{id}"`).

| Rule | Meaning |
| --- | --- |
| `rename` | A field has a new name or a new place. |
| `scale` | A number changed unit, such as dollars to cents. |
| `case` | Text changed case, such as `usd` to `USD`. |
| `values` | A fixed set of labels changed, such as `shipped` to `in_transit`. |
| `time` | A date changed format, such as seconds to ISO text. |
| `type` | A value changed type, such as `"42"` to `42`. |
| `add` / `remove` | A field exists in only one version. |
| `endpoint_moved` | An address or method changed. |
| `endpoint_removed` | Nothing can translate this call; old callers get `410 Gone` with a link. |

## Files

| File | What it is |
| --- | --- |
| `index.html` | Mender Studio: call both versions or paste two descriptions, see the rules, the proof, a real request with and without the adapter, and the files to deploy. |
| `walkthrough.html` | The five-step story on a made-up shipping API called Parcel. |
| `src/rules.js` | The rules: check, apply, compile into an adapter, describe in words, prove on examples. |
| `src/infer.js` | Finds rules from pairs of example records, and says what it could not settle. |
| `src/openapi.js` | Finds rules from two API descriptions, and proves rules with samples generated from them. |
| `src/mender.js` | The runtime: `withMender`, version chains, JSON and form bodies, deprecation headers, per-caller events. |
| `src/codefix.js` | Rewrites a JavaScript or TypeScript client from the rules. |
| `src/replay.js` | Replays recorded calls through an adapter and ignores fields that change on every call. |
| `sandbox/` | Read-only test data: the Parcel sandbox API and both Quotes API descriptions. |
| `tools/serve.py` | Dev server. Also forwards calls to APIs that a browser may not call directly. |
| `tools/managed-standin.mjs` | A local copy of the managed Quote API at any version. |
| `tools/publish-to-site.mjs` | Copies the Studio to `public/studio`. |
| `tests/` | 218 tests, the same files in Node and in the browser. |

## What has been checked

- 218 tests: the rules (64), the rule finder (38), the runtime (38), API descriptions (35), the two Quote APIs with the team's own unchanged consumer code (16), the code fixer (12), and the Parcel walkthrough (15).
- Real calls: the deployed Quotes testbed rejects the unchanged consumer with `422`, and the same consumer gets a quote through Mender.
- Stripe's public API description (644 operations), compared with a copy that has one request field renamed on purpose: exactly one rule and nothing else to check, in under a second. The proof takes about two seconds, passes with the rule, and without it fails only on the changed endpoint. Renaming a field inside the shared `customer` record gives two rules and one note that names the record.

## Limits

- The proof from descriptions checks shape, not meaning. If a field keeps its name but changes what it means, only example records or a person can catch it.
- The gateway only fronts this site's two APIs, and its per-caller counts are kept in memory, so they reset when the server restarts.
- The code fixer handles renamed request fields in JavaScript and TypeScript. Everything else it reports in words for a person to decide.
- A field renamed inside a schema that many endpoints share gives one rule per place it appears, each listing its endpoints.
- Where a field can take several shapes (`oneOf`/`anyOf`), Mender translates the first shape only. It says so when one of the other shapes changed.
- In the walkthrough, Parcel, its customers and their traffic are made up. Everything else works on the API you point it at.
