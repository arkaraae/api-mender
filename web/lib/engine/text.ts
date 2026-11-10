// Names taken from provider documents and repositories are untrusted. Before
// one is placed in an engine-written sentence it is reduced to printable
// ASCII without backticks or line breaks and cut short, so it cannot pose as
// markup, a second sentence on a new line, or an instruction block.
export function plainName(value: string, limit = 160): string {
  const kept = value.slice(0, limit * 2).replace(/[^\x20-\x7e]|`/g, '?');
  return kept.length > limit ? `${kept.slice(0, limit)}...` : kept;
}

export function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
