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

export async function fetchQuotesContract(): Promise<{ contract: QuotesContract; commit: string; sourceUrl: string }> {
  const feed = await smallText(`https://github.com/${repository}/commits/main/${contractPath}.atom`);
  const commit = feed.match(/<entry>\s*<id>tag:github\.com,2008:Grit::Commit\/([a-f0-9]{40})<\/id>/)?.[1];
  if (!commit) throw new Error('Could not verify the Quotes contract commit');
  const sourceUrl = `https://raw.githubusercontent.com/${repository}/${commit}/${contractPath}`;
  const contract = parseQuotesContract(JSON.parse(await smallText(sourceUrl)));
  return { contract, commit, sourceUrl };
}
