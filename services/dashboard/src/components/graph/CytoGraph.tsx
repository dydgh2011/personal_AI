'use client';

import cytoscape, { type Core, type ElementDefinition, type StylesheetJson } from 'cytoscape';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import s from './graph.module.css';

/**
 * One graph canvas for the dashboard (Knowledge, Services): Cytoscape with the dashboard's theme
 * tokens, force or fixed layout, search, fit, selection ring. Pages give elements and extra style
 * rules; the canvas keeps node positions while only data or classes change (filters, sizes,
 * selection) and lays out again only when the set of elements or the layout mode changes.
 */

export interface GraphElement {
  group: 'nodes' | 'edges';
  data: Record<string, string | number | boolean | null>;
  classes?: string;
  position?: { x: number; y: number };
}

export type GraphLayout = 'force' | 'preset';

export type StyleRules = (css: (name: string, fallback: string) => string) => StylesheetJson;

function cssReader(el: Element) {
  const cs = getComputedStyle(el);
  return (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;
}

/** Base look shared by every graph; page rules come after and win. */
const BASE: StyleRules = (css) => {
  const text = css('--text', '#d8dee9');
  const panel = css('--panel', '#161a21');
  const muted = css('--muted', '#8b95a5');
  const border = css('--border', '#2a313c');
  const accent = css('--accent', '#6aa6ff');
  const warn = css('--warn', '#e5b454');
  return [
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        color: text,
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-outline-color': panel,
        'text-outline-width': 2,
        'min-zoomed-font-size': 7,
        'background-color': css('--viz-other', '#6b7280'),
        'border-color': panel,
        'border-width': 2,
      },
    },
    { selector: 'edge', style: { width: 1, 'line-color': border, 'curve-style': 'straight', opacity: 0.9 } },
    { selector: '.selected', style: { 'border-color': accent, 'border-width': 4, 'z-index': 10 } },
    { selector: 'edge.selected', style: { 'line-color': accent, 'target-arrow-color': accent, width: 3, opacity: 1 } },
    { selector: 'edge.near', style: { 'line-color': accent, 'target-arrow-color': accent, width: 2.6, opacity: 1, 'z-index': 9 } },
    { selector: 'node.neighbor', style: { 'border-color': accent, 'border-width': 3, opacity: 1, 'z-index': 9, 'font-weight': 'bold' } },
    { selector: '.distant', style: { opacity: 0.15 } },
    { selector: '.hit', style: { 'border-color': warn, 'border-width': 4 } },
    { selector: '.faded', style: { opacity: 0.12 } },
    { selector: '.dim', style: { opacity: 0.2 } },
    { selector: 'node.muted-label', style: { color: muted } },
  ] as StylesheetJson;
};

const FORCE = {
  name: 'cose',
  randomize: false,
  animate: false,
  nodeRepulsion: () => 9000,
  idealEdgeLength: (edge: cytoscape.EdgeSingular) => (edge.hasClass('short') ? 36 : 120),
  edgeElasticity: (edge: cytoscape.EdgeSingular) => (edge.hasClass('short') ? 200 : 80),
  gravity: 0.6,
  numIter: 1500,
  padding: 30,
} as unknown as cytoscape.LayoutOptions;

/** Deterministic start positions when a node has none: on a circle, so the same data draws the same map. */
function seeded(elements: GraphElement[]): GraphElement[] {
  const nodes = elements.filter((e) => e.group === 'nodes' && !e.position);
  const r = 120 + nodes.length * 14;
  const at = new Map(nodes.map((n, i) => [n, { x: Math.cos((2 * Math.PI * i) / Math.max(nodes.length, 1)) * r, y: Math.sin((2 * Math.PI * i) / Math.max(nodes.length, 1)) * r }]));
  return elements.map((e) => (at.has(e) ? { ...e, position: at.get(e) } : e));
}

export function CytoGraph({
  elements,
  rules,
  layout = 'force',
  selectedId,
  onSelect,
  searchPlaceholder,
  label,
  tools,
}: {
  elements: GraphElement[];
  rules: StyleRules;
  layout?: GraphLayout;
  selectedId: string | null;
  onSelect: (id: string | null, group: 'nodes' | 'edges' | null) => void;
  searchPlaceholder: string;
  label: string;
  tools?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  /** The view before the current focus began; restored when the selection is cleared. */
  const before = useRef<{ zoom: number; pan: { x: number; y: number } } | null>(null);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState(0);
  const select = useRef(onSelect);
  select.current = onSelect;
  const style = useRef(rules);
  style.current = rules;

  const full = useMemo(() => JSON.stringify(elements), [elements]);
  const structure = useMemo(() => `${layout}|${elements.map((e) => `${e.data.id}`).join('|')}`, [elements, layout]);

  const sheet = (el: Element) => {
    const css = cssReader(el);
    return [...BASE(css), ...style.current(css)] as StylesheetJson;
  };

  // (Re)build when the set of elements or the layout mode changes.
  useEffect(() => {
    if (!box.current) return;
    const els = seeded(JSON.parse(full) as GraphElement[]);
    const instance = cytoscape({
      container: box.current,
      elements: els as ElementDefinition[],
      style: sheet(box.current),
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.25,
      layout: { name: 'preset', fit: true, padding: 30 },
    });
    if (layout === 'force') instance.layout(FORCE).run();
    instance.on('tap', (evt) => {
      if (evt.target === instance) select.current(null, null);
    });
    instance.on('tap', 'node, edge', (evt) => select.current(String(evt.target.id()), evt.target.isNode() ? 'nodes' : 'edges'));
    cy.current = instance;
    before.current = null;
    const watch = new MutationObserver(() => box.current && instance.style(sheet(box.current)));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      watch.disconnect();
      instance.destroy();
      cy.current = null;
    };
    // `full` is read once per structure; later data changes are applied below without a new layout.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structure]);

  // Same elements, new data or classes (sizes, filters, labels): update in place, keep positions.
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    const els = JSON.parse(full) as GraphElement[];
    instance.batch(() => {
      for (const e of els) {
        const ele = instance.getElementById(String(e.data.id));
        if (ele.empty()) continue;
        ele.data(e.data);
        const keep = ['selected', 'near', 'neighbor', 'distant', 'hit', 'faded'].filter((c) => ele.hasClass(c));
        ele.classes([...(e.classes || '').split(' ').filter(Boolean), ...keep]);
      }
    });
  }, [full]);

  // Selection: ring it, light its lines and the nodes at their other ends, fade everything else
  // (a selected line lights its two ends), and zoom to that group. The view from before the first
  // selection is kept and comes back only when the selection is cleared; moving from one selection
  // to another keeps zooming to the new group.
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.elements().removeClass('selected near neighbor distant');
    const ele = selectedId ? instance.getElementById(selectedId) : null;
    if (!ele || ele.empty()) {
      const back = before.current;
      before.current = null;
      if (back) {
        instance.stop();
        instance.animate({ zoom: back.zoom, pan: back.pan, duration: 250 });
      }
      return;
    }
    if (!before.current) before.current = { zoom: instance.zoom(), pan: { ...instance.pan() } };
    ele.addClass('selected');
    const isNode = ele.isNode();
    const lines = isNode ? ele.connectedEdges() : ele;
    const ends = isNode ? ele.neighborhood().nodes() : (ele as unknown as cytoscape.EdgeSingular).connectedNodes();
    lines.addClass('near');
    ends.addClass('neighbor');
    instance.elements().difference(ele.union(lines).union(ends)).addClass('distant');
    instance.stop();
    if (ends.nonempty()) instance.animate({ fit: { eles: ele.union(ends), padding: 90 }, duration: 250 });
    else instance.animate({ center: { eles: ele }, duration: 250 });
  }, [selectedId, structure]);

  // Search over data.search: highlight matches, fade the rest.
  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.elements().removeClass('hit faded');
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) {
      setHits(0);
      return;
    }
    let n = 0;
    instance.nodes().forEach((node) => {
      const hay = String(node.data('search') || node.data('label') || '').toLowerCase();
      const hit = words.every((w) => hay.includes(w));
      node.addClass(hit ? 'hit' : 'faded');
      if (hit) n++;
    });
    instance.edges().addClass('faded');
    setHits(n);
    const matched = instance.nodes('.hit');
    if (matched.nonempty()) instance.animate({ fit: { eles: matched, padding: 80 }, duration: 250 });
  }, [query, structure]);

  return (
    <div className={s.wrap}>
      <div className={s.tools}>
        <label className={s.search}>
          <span className={s.srOnly}>검색</span>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={searchPlaceholder} />
        </label>
        {query.trim() && <span className="muted">{hits}개 찾음</span>}
        {tools}
        <button type="button" onClick={() => cy.current?.animate({ fit: { eles: cy.current.elements(), padding: 30 }, duration: 250 })}>
          전체 보기
        </button>
      </div>
      <div ref={box} className={s.canvas} role="img" aria-label={label} />
    </div>
  );
}
