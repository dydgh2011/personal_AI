import type { ProposalDiff, RoadmapContent, RoadmapNode } from '@/lib/learning-types';

const TYPE_TONE: Record<RoadmapNode['type'], string> = { stage: 'info', topic: 'muted', skill: 'ok', milestone: 'warn' };

/**
 * Accessible list view of a roadmap version: the stage/topic hierarchy (parentKey) with each
 * node's prerequisites. All text is rendered as text; resource URLs are links only for http(s).
 */
export function RoadmapTree({ content }: { content: RoadmapContent }) {
  const byParent = new Map<string | null, RoadmapNode[]>();
  for (const n of content.nodes) byParent.set(n.parentKey, [...(byParent.get(n.parentKey) ?? []), n]);
  const title = new Map(content.nodes.map((n) => [n.key, n.title]));
  const requires = (key: string) => content.edges.filter((e) => e.to === key).map((e) => title.get(e.from) ?? e.from);
  const render = (parent: string | null, depth: number): React.ReactNode => {
    const children = byParent.get(parent) ?? [];
    if (!children.length) return null;
    return (
      <ul style={{ listStyle: 'none', paddingLeft: depth ? 18 : 0, margin: 0 }}>
        {children.map((n) => (
          <li key={n.key} style={{ margin: '4px 0' }}>
            <details open={n.type === 'stage'}>
              <summary>
                <span className={`badge ${TYPE_TONE[n.type]}`}>{n.type}</span> <strong>{n.title}</strong>
                {n.estimateMinutes !== null && <span className="muted"> · {n.estimateMinutes} min</span>}
                {n.skill && <span className="muted"> · skill: {n.skill}</span>}
                {requires(n.key).length > 0 && <span className="muted"> · requires: {requires(n.key).join(', ')}</span>}
              </summary>
              <div style={{ paddingLeft: 18 }}>
                <div className="muted mono">key: {n.key}</div>
                {n.description && <div>{n.description}</div>}
                {n.resources.map((r, i) => (
                  <div key={i}>
                    {r.url && /^https?:\/\//.test(r.url) ? <a href={r.url} rel="noopener noreferrer nofollow" target="_blank">{r.title}</a> : r.title}{' '}
                    <span className={`badge ${r.provenance === 'ai_suggested' ? 'warn' : 'muted'}`}>{r.provenance === 'ai_suggested' ? 'AI 제안 · 미검증' : r.provenance}</span>
                  </div>
                ))}
              </div>
              {render(n.key, depth + 1)}
            </details>
          </li>
        ))}
      </ul>
    );
  };
  const total = content.nodes.reduce((s, n) => s + (n.estimateMinutes ?? 0), 0);
  return (
    <div>
      <div className="muted">{content.nodes.length} node(s) · {content.edges.length} prerequisite link(s) · estimated {Math.round(total / 60)} h</div>
      {render(null, 0)}
    </div>
  );
}

export function ProposalDiffView({ data }: { data: ProposalDiff }) {
  const d = data.diff;
  if (!d) return null;
  const v = (x: unknown) => (x === null || x === undefined ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x));
  return (
    <div>
      <div className="muted">
        nodes {d.nodeCount.from} → {d.nodeCount.to} · estimate {Math.round(d.estimateMinutes.from / 60)} h → {Math.round(d.estimateMinutes.to / 60)} h
        {d.unchanged && ' · no changes'}
      </div>
      {d.nodes.added.map((n) => <div key={`a${n.key}`} className="dl add">+ {n.type} {n.title} <span className="mono">({n.key})</span></div>)}
      {d.nodes.removed.map((n) => <div key={`r${n.key}`} className="dl del">− {n.type} {n.title} <span className="mono">({n.key})</span></div>)}
      {d.nodes.changed.map((c) => (
        <div key={`c${c.key}`} className="dl hunk">
          ~ <span className="mono">{c.key}</span>: {c.fields.map((f) => `${f.field}: ${v(f.from)} → ${v(f.to)}`).join('; ')}
        </div>
      ))}
      {d.edges.added.map((e) => <div key={`ea${e.from}${e.to}`} className="dl add">+ prerequisite {e.from} → {e.to}</div>)}
      {d.edges.removed.map((e) => <div key={`er${e.from}${e.to}`} className="dl del">− prerequisite {e.from} → {e.to}</div>)}
    </div>
  );
}
