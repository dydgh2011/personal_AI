'use client';

import { useRouter } from 'next/navigation';
import { useMemo } from 'react';
import type { StylesheetJson } from 'cytoscape';
import { CytoGraph, type StyleRules } from '@/components/graph/CytoGraph';
import { knowledgeHref, withStartPositions, type ElementDef, type Selection } from '@/lib/knowledge-graph';

/** Page types in fixed categorical order; the rest are "other". */
const TYPE_SLOTS: Record<string, string> = {
  course: '--viz-s1',
  topic: '--viz-s2',
  person: '--viz-s3',
  habit: '--viz-s4',
  goal: '--viz-s5',
  project: '--viz-s6',
};

const rules: StyleRules = (css) => {
  const text = css('--text', '#d8dee9');
  const panel = css('--panel', '#161a21');
  const muted = css('--muted', '#8b95a5');
  const accent = css('--accent', '#6aa6ff');
  const other = css('--viz-other', '#6b7280');
  return [
    { selector: 'node.page', style: { width: 'data(size)', height: 'data(size)', 'font-size': 12 } },
    ...Object.entries(TYPE_SLOTS).map(([type, v]) => ({ selector: `node.t-${type}`, style: { 'background-color': css(v, other) } })),
    { selector: 'node.t-me', style: { 'background-color': text, 'border-color': accent, 'border-width': 3 } },
    { selector: 'node.fact', style: { width: 9, height: 9, 'font-size': 9, 'background-color': other, 'min-zoomed-font-size': 11, 'border-width': 1 } },
    { selector: 'node.archived', style: { opacity: 0.45, 'border-style': 'dashed', 'border-color': muted } },
    {
      selector: 'edge.link',
      style: {
        width: 2,
        'line-color': muted,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': muted,
        'arrow-scale': 0.8,
        label: 'data(label)',
        'font-size': 9,
        color: muted,
        'text-rotation': 'autorotate',
        'text-outline-color': panel,
        'text-outline-width': 2,
        'min-zoomed-font-size': 9,
      },
    },
    { selector: 'edge.together', style: { 'line-style': 'dashed', 'line-color': muted, width: 'mapData(weight, 1, 10, 1, 4)', opacity: 0.6 } },
  ] as StylesheetJson;
};

export function KnowledgeGraph({
  elements,
  selectedId,
  facts,
  archived,
}: {
  elements: ElementDef[];
  selectedId: string | null;
  facts: boolean;
  archived: boolean;
}) {
  const router = useRouter();
  const placed = useMemo(() => withStartPositions(elements), [elements]);
  return (
    <CytoGraph
      elements={placed}
      rules={rules}
      selectedId={selectedId}
      searchPlaceholder="제목, 다른 이름, 사실 내용 검색"
      label="지식 그래프: 점은 문서와 사실, 선은 연결입니다. 아래 목록에서도 같은 내용을 볼 수 있습니다."
      onSelect={(id, group) => {
        // Tapping empty space clears the focus (the graph then goes back to the earlier view).
        if (!id) {
          if (selectedId) router.push(knowledgeHref({ facts, archived }), { scroll: false });
          return;
        }
        if (group !== 'nodes') return;
        const sel: Selection = id.startsWith('p:') ? { kind: 'page', slug: id.slice(2) } : { kind: 'fact', id: id.slice(2) };
        router.push(knowledgeHref({ facts, archived, sel }), { scroll: false });
      }}
    />
  );
}
