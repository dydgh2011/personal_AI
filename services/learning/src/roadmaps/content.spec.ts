import { canonicalSkill, contentHash, diffContent, findCycle, validateContent } from './content.js';

const node = (key: string, extra: Record<string, unknown> = {}) => ({ key, type: 'topic', title: key.toUpperCase(), ...extra });

describe('roadmap content', () => {
  it('accepts a valid DAG and normalizes it', () => {
    const r = validateContent({ nodes: [node('b'), node('a', { estimateMinutes: 30 })], edges: [{ from: 'a', to: 'b' }] });
    expect(r.ok).toBe(true);
    expect(r.content!.nodes.map((n) => n.key)).toEqual(['a', 'b']);
    expect(r.content!.nodes[1]).toMatchObject({ description: null, parentKey: null, skill: null, resources: [], estimateMinutes: null });
  });

  it('rejects direct and indirect prerequisite cycles with the path', () => {
    const direct = validateContent({ nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
    expect(direct.ok).toBe(false);
    expect(direct.cycle).toEqual(['a', 'b', 'a']);
    const indirect = validateContent({ nodes: [node('a'), node('b'), node('c')], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }] });
    expect(indirect.cycle).toEqual(['a', 'b', 'c', 'a']);
    expect(validateContent({ nodes: [node('a')], edges: [{ from: 'a', to: 'a' }] }).errors[0]).toMatch(/own prerequisite/);
    expect(findCycle(['x', 'y'], [{ from: 'x', to: 'y' }])).toBeNull();
  });

  it('rejects malformed content', () => {
    for (const bad of [null, 'text', [], { nodes: [] }, { nodes: [node('A')] }, { nodes: [node('a'), node('a')] }, { nodes: [{ key: 'a', type: 'video', title: 'x' }] },
      { nodes: [node('a', { parentKey: 'zz' })] }, { nodes: [node('a', { parentKey: 'b' }), node('b', { parentKey: 'a' })] },
      { nodes: [node('a')], edges: [{ from: 'a', to: 'missing' }] }, { nodes: [node('a', { estimateMinutes: -5 })] },
      { nodes: [node('a', { resources: [{ title: 'x', url: 'javascript:alert(1)', provenance: 'user' }] })] }]) {
      expect(validateContent(bad).ok).toBe(false);
    }
  });

  it('hashes equal content equally regardless of order, and diffs versions', () => {
    const a = validateContent({ nodes: [node('a'), node('b')], edges: [{ from: 'a', to: 'b' }] }).content!;
    const b = validateContent({ nodes: [node('b'), node('a')], edges: [{ from: 'a', to: 'b' }] }).content!;
    expect(contentHash(a)).toBe(contentHash(b));
    const c = validateContent({ nodes: [node('a', { title: 'Renamed', estimateMinutes: 60 }), node('c')], edges: [{ from: 'a', to: 'c' }] }).content!;
    const d = diffContent(a, c);
    expect(d.nodes.added.map((n) => n.key)).toEqual(['c']);
    expect(d.nodes.removed.map((n) => n.key)).toEqual(['b']);
    expect(d.nodes.changed[0]).toMatchObject({ key: 'a', fields: [{ field: 'title', from: 'A', to: 'Renamed' }, { field: 'estimateMinutes', from: null, to: 60 }] });
    expect(d.edges).toEqual({ added: [{ from: 'a', to: 'c' }], removed: [{ from: 'a', to: 'b' }] });
    expect(diffContent(a, b).unchanged).toBe(true);
    expect(diffContent(null, a).nodes.added).toHaveLength(2);
  });

  it('canonicalizes shared skill names', () => {
    expect(canonicalSkill('  React   Hooks ')).toBe('react hooks');
  });
});
