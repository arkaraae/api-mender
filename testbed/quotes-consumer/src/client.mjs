export async function createQuote(apiBaseUrl, customerId, amountCents) {
  const response = await fetch(`${apiBaseUrl}/api/testbed/quotes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId: customerId, amountCents }),
  });
  if (!response.ok) throw new Error(`Quotes API returned ${response.status}: ${await response.text()}`);
  return response.json();
}
