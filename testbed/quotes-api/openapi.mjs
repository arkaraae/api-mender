import { readFileSync } from 'node:fs';

export function toOpenApi(contract) {
  const identity = contract.version === 1 ? 'customerId' : contract.version === 2 ? 'accountId' : null;
  if (!identity || contract.operation !== 'POST /api/testbed/quotes' || contract.acceptedIdentityField !== identity || !Array.isArray(contract.requiredRequestFields) || contract.requiredRequestFields.length !== 2 || !contract.requiredRequestFields.includes(identity) || !contract.requiredRequestFields.includes('amountCents')) throw new Error('Invalid Quotes contract');
  return { openapi: '3.0.3', info: { title: 'API Mender Quotes Test API', version: `${contract.version}.0.0`, description: 'A controlled breaking-change fixture. No customer data is stored.' }, paths: { '/api/testbed/quotes': { post: { operationId: 'createQuote', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: contract.requiredRequestFields, properties: { customerId: { type: 'string' }, accountId: { type: 'string' }, amountCents: { type: 'integer', minimum: 1 } } } } } }, responses: { '200': { description: 'Quote created' }, '422': { description: 'Invalid request for active contract' } } } } } };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  if (!process.argv[2]) throw new Error('Pass a Quotes contract JSON file');
  process.stdout.write(`${JSON.stringify(toOpenApi(JSON.parse(readFileSync(process.argv[2], 'utf8'))))}\n`);
}
