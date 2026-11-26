import { describe, expect, it } from 'vitest';
import { parseDefaultsForm } from '@/lib/agent-defaults';

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe('worker default model and effort form', () => {
  it('turns empty fields into the CLI default and keeps given values', () => {
    expect(parseDefaultsForm(form({ agent: 'claude', model: ' opus ', effort: 'high' }))).toEqual({ agent: 'claude', model: 'opus', effort: 'high' });
    expect(parseDefaultsForm(form({ agent: 'codex', model: '', effort: '' }))).toEqual({ agent: 'codex', model: null, effort: null });
    expect(parseDefaultsForm(form({ agent: 'claude', model: 'claude-sonnet-5-5[1m]' }))).toEqual({ agent: 'claude', model: 'claude-sonnet-5-5[1m]', effort: null });
  });

  it('rejects unknown workers, option-like models and unknown efforts', () => {
    expect(parseDefaultsForm(form({ agent: 'gemini', model: 'x' }))).toHaveProperty('error');
    expect(parseDefaultsForm(form({ agent: 'claude', model: '--dangerously-skip-permissions' }))).toHaveProperty('error');
    expect(parseDefaultsForm(form({ agent: 'claude', model: 'a b' }))).toHaveProperty('error');
    expect(parseDefaultsForm(form({ agent: 'codex', effort: 'ultra' }))).toHaveProperty('error');
  });
});
