import type { RubricCriterion } from '../rubrics/rubrics.js';
import { budgetSources, checkEvaluationOutput, rubricOutcome, type EvaluationSource } from './evaluation-ai.js';

const criteria: RubricCriterion[] = [
  { key: 'correct', title: 'Correctness', description: null, maxScore: 6 },
  { key: 'clear', title: 'Clarity', description: null, maxScore: 4 },
];
const sources: EvaluationSource[] = [
  { label: 'body', ref: 'submission:s1#body', text: 'The derivative of x^2 is 2x.\nTherefore   the slope at 3 is 6.' },
  { label: 'work.py', ref: 'submission:s1#file:f1', text: 'def slope(x):\n    return 2 * x\n' },
];
const good = {
  scores: [
    { criterion: 'correct', score: 5.5, rationale: 'Right result', evidence: [{ quote: 'Therefore the slope at 3 is 6.', source: 'body' }, { quote: 'return 2 * x', source: 'body' }] },
    { criterion: 'clear', score: 3, rationale: 'Short', evidence: [{ quote: 'I proved the chain rule', source: 'body' }] },
  ],
  feedback: 'Good.',
  confidence: 0.8,
  limitations: ['Only text was read'],
  gaps: [{ skill: 'Derivatives', title: 'Explain steps', description: null }, { title: '' }],
  suggestedLevels: [{ skill: 'Derivatives', level: 3 }, { skill: 'x', level: 7 }],
};

describe('AI evaluation output check', () => {
  it('accepts a complete answer and verifies quotes against the submission', () => {
    const r = checkEvaluationOutput(good, criteria, sources, 'rubric:r1');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.scores.map((s) => s.score)).toEqual([5.5, 3]);
    const excerpts = r.value.evidence.filter((e) => e.type === 'excerpt');
    // whitespace differences do not matter; a quote is found in another source if mislabeled
    expect(excerpts.map((e) => [e.excerpt, e.verified, e.sourceRef])).toEqual([
      ['Therefore the slope at 3 is 6.', true, 'submission:s1#body'],
      ['return 2 * x', true, 'submission:s1#file:f1'],
      ['I proved the chain rule', false, 'submission:s1#body'],
    ]);
    expect(excerpts[2].limitations).toMatch(/unverified/);
    expect(r.value.evidence.filter((e) => e.type === 'criterion_score').every((e) => !e.verified)).toBe(true);
    expect(r.value.gaps).toHaveLength(1);
    expect(r.value.suggestedLevels).toEqual([{ skill: 'Derivatives', level: 3, rationale: null }]);
  });

  it('rejects missing, unknown, duplicate or out-of-range scores and bad fields', () => {
    const bad = (patch: Record<string, unknown>) => checkEvaluationOutput({ ...good, ...patch }, criteria, sources, 'rubric:r1');
    expect(checkEvaluationOutput(null, criteria, sources, 'r').ok).toBe(false);
    expect(checkEvaluationOutput('{"x":1}', criteria, sources, 'r').ok).toBe(false);
    const missing = bad({ scores: [good.scores[0]] });
    expect(missing.ok === false && missing.errors).toContain('criterion "clear" was not scored');
    const unknown = bad({ scores: [...good.scores, { criterion: 'bonus', score: 1, rationale: 'x' }] });
    expect(unknown.ok === false && unknown.errors[0]).toMatch(/unknown criterion "bonus"/);
    expect(bad({ scores: [good.scores[0], good.scores[0], good.scores[1]] }).ok).toBe(false);
    expect(bad({ scores: [{ ...good.scores[0], score: 7 }, good.scores[1]] }).ok).toBe(false);
    expect(bad({ scores: [{ ...good.scores[0], score: '5' }, good.scores[1]] }).ok).toBe(false);
    expect(bad({ scores: [{ ...good.scores[0], rationale: '' }, good.scores[1]] }).ok).toBe(false);
    expect(bad({ confidence: 1.5 }).ok).toBe(false);
    expect(bad({ feedback: '' }).ok).toBe(false);
    expect(bad({ limitations: 'none' }).ok).toBe(false);
  });

  it('cuts long submissions to the budget and says which part was cut', () => {
    const r = budgetSources([{ label: 'body', ref: 'b', text: 'a'.repeat(10) }, { label: 'f.txt', ref: 'f', text: 'b'.repeat(10) }, { label: 'g.txt', ref: 'g', text: 'c' }], 15);
    expect(r.sources.map((s) => s.text.length)).toEqual([10, 5, 0]);
    expect(r.truncated).toEqual(['f.txt', 'g.txt']);
  });

  it('turns scores into a rubric outcome, never a pass', () => {
    expect(rubricOutcome(7, 6, 0.9)).toBe('meets_rubric');
    expect(rubricOutcome(5, 6, null)).toBe('below_rubric');
    expect(rubricOutcome(10, 6, 0.2)).toBe('inconclusive');
  });
});
