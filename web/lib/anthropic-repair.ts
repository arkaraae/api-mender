/** Ask Claude to choose a field mapping. Customer source code never leaves this Worker. */
export async function selectRepairField(input: {
  apiKey: string; model?: string; workspaceId?: string;
  endpoint: string; missingField: string; candidates: string[];
  fetcher?: typeof fetch;
}): Promise<string> {
  const { apiKey, endpoint, missingField, candidates } = input;
  if (!apiKey || candidates.length < 2 || candidates.length > 12
    || !/^(GET|POST|PUT|PATCH|DELETE) \/[A-Za-z0-9_./{}-]{1,200}$/.test(endpoint)
    || !/^[A-Za-z_$][\w$]{0,119}$/.test(missingField)
    || candidates.some(name => !/^[A-Za-z_$][\w$]{0,119}$/.test(name)))
    throw new Error('Unsupported AI repair input');
  const model = input.model || 'claude-sonnet-5';
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(model)) throw new Error('Invalid AI model configuration');
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-api-key': apiKey,
    'anthropic-version': '2026-10-21',
  };
  if (input.workspaceId) headers['anthropic-workspace-id'] = input.workspaceId;
  let response: Response;
  try {
    response = await (input.fetcher || fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers, redirect: 'manual', signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ model, max_tokens: 128,
        system: 'Select the previous request field that most likely maps to the newly required field. Return a candidate only when the mapping is unambiguous. No code, secrets, or field values are provided.',
        messages: [{ role: 'user', content: JSON.stringify({ endpoint, newRequiredField: missingField,
          oldCandidateFields: candidates }) }],
        output_config: { format: { type: 'json_schema', schema: {
          type: 'object', additionalProperties: false,
          properties: { oldField: { type: 'string', enum: candidates },
            confidence: { type: 'string', enum: ['high', 'uncertain'] } },
          required: ['oldField', 'confidence'],
        } } },
      }),
    });
  } catch { throw new Error('AI repair provider is unavailable'); }
  if (!response.ok) throw new Error(response.status === 429
    ? 'AI repair rate limit reached; try later' : 'AI repair provider rejected the request');
  let result: any;
  try { result = await response.json(); }
  catch { throw new Error('AI repair provider returned an invalid response'); }
  if (result.stop_reason !== 'end_turn' || !Array.isArray(result.content))
    throw new Error('AI repair did not return a complete answer');
  const text = result.content.find((block: any) => block?.type === 'text')?.text;
  let selected: any;
  try { selected = JSON.parse(text); }
  catch { throw new Error('AI repair returned an invalid field mapping'); }
  if (selected?.confidence !== 'high' || !candidates.includes(selected?.oldField))
    throw new Error('AI repair could not select a field confidently');
  return selected.oldField;
}
