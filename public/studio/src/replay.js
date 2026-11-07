// Replay: prove an adapter is right before any customer depends on it.
//
// Each recorded call from an old-version customer is sent twice:
//   1. to the old version again, to learn which fields change on every run (ids, timestamps)
//   2. through the adapter into the newest version
// The answer from (2) must match what the customer originally got, except for the fields
// found in (1). This is the idea behind Twitter's Diffy, applied to version adapters.

import { API } from './parcel.js';

export function toRequest(call) {
  return new Request(API + call.path, {
    method: call.method,
    headers: {
      authorization: `Bearer ${call.key}`,
      'parcel-version': call.version,
      ...(call.body ? { 'content-type': 'application/json' } : {}),
    },
    body: call.body ? JSON.stringify(call.body) : undefined,
  });
}

async function send(handler, call) {
  const response = await handler(toRequest(call));
  return { status: response.status, body: await response.json() };
}

export async function record(handler, calls) {
  const recorded = [];
  for (const call of calls) recorded.push({ call, response: await send(handler, call) });
  return recorded;
}

export function flatten(value, prefix = '', out = new Map()) {
  if (value !== null && typeof value === 'object') {
    const entries = Array.isArray(value)
      ? value.map((v, i) => [`${prefix}[${i}]`, v])
      : Object.entries(value).map(([k, v]) => [prefix ? `${prefix}.${k}` : k, v]);
    if (entries.length === 0) out.set(prefix, JSON.stringify(value));
    for (const [key, v] of entries) flatten(v, key, out);
  } else {
    out.set(prefix, value);
  }
  return out;
}

const general = (path) => path.replace(/\[\d+\]/g, '[]');

function differences(a, b) {
  const left = flatten(a.body);
  const right = flatten(b.body);
  const paths = [];
  if (a.status !== b.status) paths.push({ path: 'HTTP status', expected: a.status, got: b.status });
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    if (!Object.is(left.get(key), right.get(key))) paths.push({ path: key, expected: left.get(key), got: right.get(key) });
  }
  return paths;
}

export async function replay({ recorded, baseline, candidate, onProgress = () => {} }) {
  const result = { total: recorded.length, matched: 0, differed: [], untranslatable: [], noise: new Set() };
  for (const [index, { call, response }] of recorded.entries()) {
    const again = await send(baseline, call);
    const got = await send(candidate, call);
    const noisy = new Set(differences(response, again).map((d) => general(d.path)));
    for (const path of noisy) result.noise.add(`${path} on ${call.method} ${call.route}`);

    if (got.status === 410 && got.body?.error?.type === 'version_gone') {
      result.untranslatable.push({ index, call, reason: got.body.error.message });
    } else {
      const diffs = differences(response, got).filter((d) => !noisy.has(general(d.path)));
      if (diffs.length) result.differed.push({ index, call, diffs });
      else result.matched += 1;
    }
    onProgress(index + 1, recorded.length);
  }
  return result;
}
