'use client';

import { usePathname } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { useT } from '@/i18n/client';
import type { RubricCriterion } from '@/lib/learning-types';
import { formatBytes, uploadProblem } from '@/lib/learning-view';
import s from './learning.module.css';

export interface TabItem {
  href: string;
  label: string;
  count?: number;
  hot?: boolean;
  /** Extra path prefixes that belong to this tab (e.g. /learning/assignments under Milestones). */
  also?: string[];
}

/** Learning sub-navigation highlights the current subsection, including nested routes. */
export function LearningTabs({ items }: { items: TabItem[] }) {
  const path = usePathname();
  const tr = useT();
  const on = (t: TabItem) => (t.href === '/learning' ? path === '/learning' : [t.href, ...(t.also ?? [])].some((p) => path === p || path.startsWith(`${p}/`)));
  return (
    <nav className={s.tabs} aria-label={tr.learn.tabs.aria}>
      {items.map((t) => (
        <a key={t.href} href={t.href} className={`${s.tab} ${on(t) ? s.tabOn : ''}`} aria-current={on(t) ? 'page' : undefined}>
          {t.label}
          {t.count !== undefined && t.count > 0 && <span className={`${s.count} ${t.hot ? s.countHot : ''}`}>{t.count}</span>}
        </a>
      ))}
    </nav>
  );
}

export function RubricCriteriaFields({ criteria = [] }: { criteria?: RubricCriterion[] }) {
  const [rows, setRows] = useState<Array<{ id: number; criterion?: RubricCriterion }>>(() =>
    criteria.length ? criteria.map((criterion, id) => ({ id, criterion })) : [{ id: 0 }],
  );
  const nextId = useRef(rows.length);
  const c = useT().learn.criteria;

  return (
    <div className={s.criteria}>
      {rows.map(({ id, criterion }, index) => (
        <fieldset className={s.criterionFields} key={id}>
          <legend>{c.criterion(index + 1)}</legend>
          <input type="hidden" name="c_key" value={criterion?.key ?? ''} />
          <div className={s.criterionRow}>
            <label className={s.field}>{c.title}<input name="c_title" required maxLength={200} defaultValue={criterion?.title} /></label>
            <label className={s.field}>{c.maxPoints}
              <input name="c_max" type="number" required min={0.5} max={100} step={0.01} defaultValue={criterion?.maxScore} />
            </label>
          </div>
          <label className={s.field}>{c.description}
            <textarea name="c_desc" rows={2} maxLength={2000} defaultValue={criterion?.description ?? ''} />
          </label>
          {rows.length > 1 && (
            <div className={s.formActions}>
              <button type="button" aria-label={c.removeAria(index + 1)}
                onClick={() => setRows((existing) => existing.filter((row) => row.id !== id))}>{c.remove}</button>
            </div>
          )}
        </fieldset>
      ))}
      {rows.length < 20 && (
        <div className={s.formActions}>
          <button type="button" onClick={() => {
            const id = nextId.current++;
            setRows((existing) => [...existing, { id }]);
          }}>{c.add}</button>
        </div>
      )}
    </div>
  );
}

/**
 * File input for submissions: lists the chosen files and blocks submitting (native form
 * validation) when they are over the limits, before any bytes are sent. The server checks again.
 */
export function FilePicker({ accept, limits, required = false }: {
  accept: string;
  limits: { maxFileBytes: number; maxFiles: number; maxTotalBytes: number };
  required?: boolean;
}) {
  const inputId = useId();
  const t = useT();
  const [files, setFiles] = useState<Array<{ name: string; size: number }>>([]);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <div className={s.field}>
      <label htmlFor={inputId}>{t.learn.files.attachments}{required ? t.learn.files.required : t.learn.files.optional}</label>
      <span id={inputId + '-limits'} className={s.hint}>
        {t.learn.files.limits(limits.maxFiles, formatBytes(limits.maxFileBytes), formatBytes(limits.maxTotalBytes))}
      </span>
      <input
        id={inputId}
        aria-describedby={inputId + '-limits'}
        type="file"
        name="files"
        required={required}
        multiple
        accept={accept}
        onChange={(e) => {
          const list = Array.from(e.currentTarget.files ?? []).map((f) => ({ name: f.name, size: f.size }));
          const p = uploadProblem(list, limits, t);
          e.currentTarget.setCustomValidity(p ?? '');
          setFiles(list);
          setProblem(p);
        }}
      />
      {files.length > 0 && (
        <span className={s.rowMeta}>
          {files.map((f) => `${f.name} (${formatBytes(f.size)})`).join(' · ')}
        </span>
      )}
      {problem && <span className={s.bad} style={{ borderRadius: 6, padding: '4px 8px' }} role="alert">{problem}</span>}
    </div>
  );
}
