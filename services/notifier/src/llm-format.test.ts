import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from './format.js';
import { formatLlm, parseLlm } from './llm-format.js';

describe('llm events', () => {
  it('renders the three gateway events with fixed text', () => {
    const sw = formatLlm(parseLlm({ kind: 'free_switch', pool: 'openai-shared-small', label: 'OpenAI 무료 (mini/nano)', used: 2_000_000, limit: 2_500_000, unit: 'tokens' }), '123456');
    assert.match(sw, /2\.00M \/ 2\.50M/);
    assert.match(sw, /유료로는 넘어가지 않아요/);
    assert.doesNotMatch(sw, /<@/); // a switch is informational, no ping
    const need = formatLlm(parseLlm({ kind: 'paid_needed', alias: 'kelly', capUsd: 0.3 }), '123456');
    assert.match(need, /^<@123456>/);
    assert.match(need, /\/ai-paid on/);
    assert.match(need, /\$0\.30/);
    assert.match(formatLlm(parseLlm({ kind: 'paid_cap', spentUsd: 0.31, capUsd: 0.3 }), null), /\$0\.31 \/ \$0\.30/);
  });

  it('rejects free text and unknown fields', () => {
    assert.throws(() => parseLlm({ kind: 'paid_needed', alias: 'kelly', capUsd: 0.3, note: 'hi' }), ValidationError);
    assert.throws(() => parseLlm({ kind: 'free_switch', pool: 'x', label: '<@everyone>', used: 1, limit: 2, unit: 'tokens' }), ValidationError);
    assert.throws(() => parseLlm({ kind: 'other' }), ValidationError);
  });
});
