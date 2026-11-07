const repository = 'arkaraae/api-mender';
const contractPath = 'testbed/quotes-api/contract.json';

export type QuotesContract = {
  version: 1 | 2;
  operation: 'POST /api/testbed/quotes';
  requiredRequestFields: ('customerId' | 'accountId' | 'amountCents')[];
  acceptedIdentityField: 'customerId' | 'accountId';
};

export function parseQuotesContract(value: unknown): QuotesContract {
  if (!value || typeof value !== 'object') throw new Error('Quotes contract was invalid');
  const item = value as Partial<QuotesContract>;
  const identity = item.version === 1 ? 'customerId' : item.version === 2 ? 'accountId' : null;
  if (!identity || item.operation !== 'POST /api/testbed/quotes' || item.acceptedIdentityField !== identity || !Array.isArray(item.requiredRequestFields) || item.requiredRequestFields.length !== 2 || !item.requiredRequestFields.includes(identity) || !item.requiredRequestFields.includes('amountCents')) throw new Error('Quotes contract was invalid');
  return item as QuotesContract;
}

export function quotesOpenApi(contract: QuotesContract) {
  return {
    openapi: '3.0.3',
    info: { title: 'API Mender Quotes Test API', version: `${contract.version}.0.0`, description: 'A controlled breaking-change fixture. No customer data is stored.' },
    paths: {
      '/api/testbed/quotes': {
        post: {
          operationId: 'createQuote',
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object',
            required: contract.requiredRequestFields,
            properties: {
              customerId: { type: 'string' },
              accountId: { type: 'string' },
              amountCents: { type: 'integer', minimum: 1 },
            },
          } } } },
          responses: { '200': { description: 'Quote created' }, '422': { description: 'Invalid request for active contract' } },
        },
      },
    },
  };
}

async function smallText(url: string): Promise<string> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Quotes contract source returned ${response.status}`);
  const body = await response.arrayBuffer();
  if (body.byteLength > 32_000) throw new Error('Quotes contract source exceeded its size limit');
  return new TextDecoder().decode(body);
}

type ContractReading = { contract: QuotesContract; commit: string; sourceUrl: string };

// GitHub rate-limits requests from Cloudflare's shared servers (429), so the contract is not read
// on every request. A reading less than 30 seconds old is used as is; it is shared through the
// Cloudflare cache, so all server instances in a data center use the same one. If GitHub does
// not answer, a reading up to a day old still stands.
const FRESH_MS = 30_000;
const STALE_MS = 24 * 60 * 60_000;
const CACHE_KEY = 'https://quotes-contract.api-mender.internal/latest';
type Saved = { at: number; value: ContractReading };
let lastReading: Saved | null = null;

const edgeCache = () => (typeof caches === 'undefined' ? null : (caches as unknown as { default?: Cache }).default ?? null);

// The newest reading this instance knows of: its own, or one another instance shared.
async function savedReading(): Promise<Saved | null> {
  if (lastReading && Date.now() - lastReading.at < FRESH_MS) return lastReading;
  let shared: Saved | null = null;
  try {
    const hit = await edgeCache()?.match(CACHE_KEY);
    shared = hit ? ((await hit.json()) as Saved) : null;
  } catch {
    shared = null;
  }
  if (shared && (!lastReading || shared.at > lastReading.at)) lastReading = shared;
  return lastReading;
}

async function save(value: ContractReading) {
  lastReading = { at: Date.now(), value };
  try {
    await edgeCache()?.put(CACHE_KEY, new Response(JSON.stringify(lastReading), { headers: { 'content-type': 'application/json', 'cache-control': `max-age=${STALE_MS / 1000}` } }));
  } catch {
    // The memory copy still serves this instance.
  }
}

export async function fetchQuotesContract(): Promise<ContractReading> {
  const saved = await savedReading();
  if (saved && Date.now() - saved.at < FRESH_MS) return saved.value;
  let failure: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const value = await readQuotesContract();
      await save(value);
      return value;
    } catch (error) {
      failure = error;
    }
  }
  if (saved && Date.now() - saved.at < STALE_MS) return saved.value;
  throw failure;
}

async function readQuotesContract(): Promise<ContractReading> {
  const feed = await smallText(`https://github.com/${repository}/commits/main/${contractPath}.atom`);
  const commit = feed.match(/<entry>\s*<id>tag:github\.com,2008:Grit::Commit\/([a-f0-9]{40})<\/id>/)?.[1];
  if (!commit) throw new Error('Could not verify the Quotes contract commit');
  const sourceUrl = `https://raw.githubusercontent.com/${repository}/${commit}/${contractPath}`;
  const contract = parseQuotesContract(JSON.parse(await smallText(sourceUrl)));
  return { contract, commit, sourceUrl };
}
