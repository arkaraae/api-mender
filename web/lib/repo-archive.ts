// Reads source files out of a GitHub repository tarball (.tar.gz) in one
// streamed pass, so a scan costs one request instead of one per file. Only
// regular files the caller accepts are kept, within byte bounds. Nothing in
// the archive is executed or written to disk.
export type ArchiveLimits = { maxArchiveBytes: number; maxFiles: number; maxFileBytes: number; maxTotalBytes: number };

export class ArchiveLimitError extends Error {}

const decoder = new TextDecoder('utf-8', { fatal: true });
const text = (bytes: Uint8Array, from: number, length: number) => {
  let end = from;
  while (end < from + length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(from, end));
};
const octal = (bytes: Uint8Array, from: number, length: number) => {
  const value = text(bytes, from, length).trim();
  return /^[0-7]+$/.test(value) ? parseInt(value, 8) : NaN;
};

// pax records: "<len> key=value\n"
function paxPath(bytes: Uint8Array): string | null {
  const body = new TextDecoder().decode(bytes);
  for (const record of body.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match) return match[1];
  }
  return null;
}

/**
 * `accept(path, size)` decides which entries to keep; paths have the
 * archive's top-level directory (owner-repo-sha/) removed.
 */
export async function readTarGz(body: ReadableStream<Uint8Array>, accept: (path: string, size: number) => boolean, limits: ArchiveLimits): Promise<Map<string, string>> {
  const reader = (body.pipeThrough(new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).getReader();
  const files = new Map<string, string>();
  let buffer = new Uint8Array(0);
  let total = 0;
  let kept = 0;
  let keptBytes = 0;
  let longName: string | null = null;
  let done = false;
  // Ensure at least `count` bytes are buffered; false at end of stream.
  const fill = async (count: number) => {
    while (buffer.length < count && !done) {
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      total += chunk.value.byteLength;
      if (total > limits.maxArchiveBytes) throw new ArchiveLimitError('Repository archive exceeds the scan limit');
      const next = new Uint8Array(buffer.length + chunk.value.byteLength);
      next.set(buffer);
      next.set(chunk.value, buffer.length);
      buffer = next;
    }
    return buffer.length >= count;
  };
  const take = (count: number) => { const out = buffer.subarray(0, count); buffer = buffer.subarray(count); return out; };
  try {
    while (await fill(512)) {
      const header = take(512);
      if (header.every(byte => byte === 0)) break;
      const size = octal(header, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error('Repository archive is malformed');
      const type = String.fromCharCode(header[156] || 48);
      const padded = Math.ceil(size / 512) * 512;
      const ustarPrefix = text(header, 257, 6) === 'ustar' ? text(header, 345, 155) : '';
      let name = longName ?? (ustarPrefix ? `${ustarPrefix}/${text(header, 0, 100)}` : text(header, 0, 100));
      longName = null;
      const small = size <= 1_048_576;
      if ((type === 'x' || type === 'L') && small) {
        if (!(await fill(padded))) break;
        const data = take(padded).slice(0, size);
        longName = type === 'x' ? paxPath(data) : text(data, 0, size);
        continue;
      }
      const path = name.split('/').slice(1).join('/');
      const wanted = (type === '0' || type === '\0') && path && !path.split('/').some(part => part === '..' || part === '.')
        && size <= limits.maxFileBytes && accept(path, size);
      if (wanted) {
        if (++kept > limits.maxFiles) throw new ArchiveLimitError('Repository has more source files than the scan limit');
        if (!(await fill(padded))) throw new Error('Repository archive ended early');
        const data = take(padded).subarray(0, size);
        try { files.set(path, decoder.decode(data)); keptBytes += size; } catch { /* not UTF-8 text: skipped */ }
        if (keptBytes > limits.maxTotalBytes) throw new ArchiveLimitError('Repository source exceeds the scan limit');
      } else {
        // Skip the entry's data without keeping it.
        let remaining = padded;
        while (remaining > 0) {
          if (!(await fill(Math.min(remaining, 65_536)))) { remaining = 0; break; }
          const step = Math.min(remaining, buffer.length);
          take(step);
          remaining -= step;
        }
        name = '';
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return files;
}
