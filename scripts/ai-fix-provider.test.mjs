import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateAiFix } from './ai-fix-provider.mjs';

test('Claude request uses structured output and returns token usage without revealing its key', async () => {
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'staging-test-key';
  try {
    const result = await generateAiFix({ before: 'old client' }, {
      provider: 'anthropic',
      fetcher: async (url, options) => {
        assert.equal(url, 'https://api.anthropic.com/v1/messages');
        assert.equal(options.headers['x-api-key'], 'staging-test-key');
        const request = JSON.parse(options.body);
        assert.equal(request.output_config.format.type, 'json_schema');
        assert.equal(request.messages[0].role, 'user');
        assert.equal(request.max_tokens, 4096);
        return new Response(JSON.stringify({
          stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ after: 'new client', summary: 'renamed field', needsDecision: null }) }],
          usage: { input_tokens: 100, output_tokens: 30 },
        }), { status: 200 });
      },
    });
    assert.equal(result.after, 'new client');
    assert.deepEqual(result.usage, { inputTokens: 100, outputTokens: 30 });
    assert.equal(JSON.stringify(result).includes('staging-test-key'), false);
  } finally {
    if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = old;
  }
});

test('Claude refuses an incomplete patch', async () => {
  const old = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'staging-test-key';
  try {
    await assert.rejects(() => generateAiFix({}, {
      provider: 'anthropic',
      fetcher: async () => new Response(JSON.stringify({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{}' }] }), { status: 200 }),
    }), /stopped before completing/);
  } finally {
    if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = old;
  }
});
