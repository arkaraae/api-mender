// Builds a GitHub-style .tar.gz (top-level owner-repo-sha/ directory, a pax
// global header) for scanner tests.
import { gzipSync } from 'node:zlib';

function header(name, size, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return block;
}

const pad = data => Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

export function tarGz(files, root = 'owner-repo-abc1234') {
  const parts = [];
  const comment = Buffer.from('52 comment=abc1234abc1234abc1234abc1234abc1234abc1\n');
  parts.push(header('pax_global_header', comment.length, 'g'), pad(comment));
  parts.push(header(`${root}/`, 0, '5'));
  for (const [path, source] of Object.entries(files)) {
    const data = Buffer.from(source);
    const name = `${root}/${path}`;
    if (name.length > 100) {
      const record = `path=${name}\n`;
      let length = record.length + 3;
      while (`${length} ${record}`.length !== length) length++;
      const pax = Buffer.from(`${length} ${record}`);
      parts.push(header('PaxHeader', pax.length, 'x'), pad(pax));
    }
    parts.push(header(name, data.length), pad(data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

export const archiveResponse = bytes => new Response(new Blob([bytes]).stream(), { status: 200 });
