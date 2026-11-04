import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ProposalDiffView, RoadmapTree } from '@/components/RoadmapTree';
import type { ProposalDiff, RoadmapContent } from '@/lib/learning-types';
import { MODULES } from '@/modules/registry';

const content: RoadmapContent = {
  nodes: [
    { key: 'basics', type: 'stage', title: 'Basics <script>alert(1)</script>', description: null, estimateMinutes: null, parentKey: null, skill: null, resources: [] },
    { key: 'jsx', type: 'topic', title: 'JSX', description: '<img src=x onerror=alert(2)>', estimateMinutes: 90, parentKey: 'basics', skill: 'React JSX',
      resources: [
        { title: 'Docs', url: 'https://react.dev', provenance: 'ai_suggested' },
        { title: 'Evil', url: 'javascript:alert(3)', provenance: 'user' },
      ] },
    { key: 'hooks', type: 'skill', title: 'Hooks', description: null, estimateMinutes: 30, parentKey: 'basics', skill: 'React Hooks', resources: [] },
  ],
  edges: [{ from: 'jsx', to: 'hooks' }],
};

describe('learning UI', () => {
  it('registers the Learning module in the navigation', () => {
    expect(MODULES.find((m) => m.id === 'learning')).toMatchObject({ href: '/learning', permission: 'admin' });
  });

  it('renders the roadmap hierarchy with prerequisites, escaping all text', () => {
    const html = renderToStaticMarkup(<RoadmapTree content={content} />);
    expect(html).toContain('requires: JSX');
    expect(html).toContain('3 node(s) · 1 prerequisite link(s)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('AI 제안 · 미검증');
    expect(html).toContain('href="https://react.dev"');
    expect(html).not.toContain('javascript:');
  });

  it('shows proposal diffs as text', () => {
    const data: ProposalDiff = {
      proposal: {} as ProposalDiff['proposal'], stale: false, currentVersionId: null,
      diff: {
        nodes: { added: [{ key: 'x', title: '<b>new</b>', type: 'topic' }], removed: [], changed: [{ key: 'jsx', fields: [{ field: 'title', from: 'JSX', to: 'JSX deep dive' }] }] },
        edges: { added: [{ from: 'jsx', to: 'x' }], removed: [] }, nodeCount: { from: 3, to: 4 }, estimateMinutes: { from: 120, to: 180 }, unchanged: false,
      },
    };
    const html = renderToStaticMarkup(<ProposalDiffView data={data} />);
    expect(html).toContain('+ topic &lt;b&gt;new&lt;/b&gt;');
    expect(html).toContain('title: JSX → JSX deep dive');
    expect(html).toContain('+ prerequisite jsx → x');
  });
});
