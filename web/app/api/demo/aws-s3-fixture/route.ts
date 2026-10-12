import { NextResponse } from 'next/server';
import { fetchOfficialS3Model, readS3Operations, S3_MODEL_PAGE } from '@/lib/aws-s3-model';
import { extractCalls } from '@/lib/public-scan';

const fixtureRoot = 'testbed/aws-s3';
const repository = 'arkaraae/api-mender';

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Fixture source returned ${response.status}`);
  const body = await response.arrayBuffer();
  if (body.byteLength > 300_000) throw new Error('Fixture source exceeded the allowed size');
  return new TextDecoder().decode(body);
}

export async function GET() {
  try {
    const [feed, source] = await Promise.all([
      fetchText(`https://github.com/${repository}/commits/main.atom`),
      fetchOfficialS3Model(),
    ]);
    const head = feed.match(/<entry>\s*<id>tag:github\.com,2008:Grit::Commit\/([a-f0-9]{40})<\/id>/)?.[1];
    if (!head) throw new Error('Could not verify the fixture commit');
    const [manifestText, code] = await Promise.all([
      fetchText(`https://raw.githubusercontent.com/${repository}/${head}/${fixtureRoot}/package.json`),
      fetchText(`https://raw.githubusercontent.com/${repository}/${head}/${fixtureRoot}/src/objects.ts`),
    ]);
    const manifest = JSON.parse(manifestText) as { dependencies?: Record<string, unknown> };
    const sdkVersion = manifest.dependencies?.['@aws-sdk/client-s3'];
    if (typeof sdkVersion !== 'string') throw new Error('Fixture had no S3 SDK dependency');
    const file = `${fixtureRoot}/src/objects.ts`;
    const calls = extractCalls(file, code).filter(call => call.endpoint.startsWith('S3 '));
    if (!calls.length) throw new Error('The S3 fixture was not found in the public repository');
    const names = [...new Set(calls.map(call => call.symbol.replace(/Command$/, '')))];
    const operations = readS3Operations(source.model, names);
    return NextResponse.json({
      state: 'baseline',
      message: 'Fixture calls matched current official S3 operations. No change impact has been determined.',
      repository: { fullName: repository, head, url: `https://github.com/${repository}/tree/${head}/${fixtureRoot}` },
      sdkVersion,
      calls: calls.map(call => ({ ...call, url: `https://github.com/${repository}/blob/${head}/${call.file}#L${call.line}` })),
      model: { url: S3_MODEL_PAGE, sha256: source.sha256, retrievedAt: source.retrievedAt, operations },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Fixture check failed' }, { status: 502 });
  }
}
