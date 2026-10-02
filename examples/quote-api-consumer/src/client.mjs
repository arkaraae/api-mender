/** A separate application using the public, database-backed Quote API. */
export async function createQuote(apiBaseUrl, customerId, sku) {
  const response = await fetch(`${apiBaseUrl}/api/managed/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ customerId, sku }),
  });
  if (!response.ok) throw new Error(`Quote API returned ${response.status}: ${await response.text()}`);
  return response.json();
}
