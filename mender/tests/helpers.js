// Small assertion helpers shared by every test file. They work in browsers and in Node.

export function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
  return value;
}

// Deep equality that ignores the order of object keys.
export function same(actual, expected, message = 'values differ') {
  const a = JSON.stringify(sorted(actual));
  const b = JSON.stringify(sorted(expected));
  if (a !== b) throw new Error(`${message}\n          expected ${b}\n          actual   ${a}`);
}

export function throws(fn, pattern, message = 'expected an error') {
  let error = null;
  try { fn(); } catch (caught) { error = caught; }
  if (!error) throw new Error(message);
  if (pattern && !pattern.test(String(error.message))) throw new Error(`${message}: got "${error.message}"`);
}

export const clone = (value) => structuredClone(value);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
