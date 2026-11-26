import type { Dict } from '@/i18n';
import { parsePatch } from '@/lib/diff';
import type { DiffFile } from '@/lib/types';

/**
 * Per-file unified diff. Every line is a React text node (escaped); nothing from the patch is
 * ever used as HTML, a URL or an attribute that could execute.
 */
export function DiffView({ t, files, patch, omitted, withheld }: { t: Dict; files: DiffFile[]; patch: string | null; omitted: string[]; withheld: string | null }) {
  const n = t.review.diffNote;
  const parsed = new Map(parsePatch(patch).map((f) => [f.path, f]));
  const omittedSet = new Set(omitted);
  return (
    <div>
      {files.map((f, i) => {
        const body = parsed.get(f.path);
        let note: string | null = null;
        if (f.binary) note = n.binary;
        else if (f.sensitive) note = n.sensitive;
        else if (withheld) note = withheld;
        else if (patch === null) note = n.noPatch;
        else if (omittedSet.has(f.path) || !body) note = n.omitted;
        return (
          <details key={`${f.path}:${i}`} className="diff-file" open={files.length <= 20}>
            <summary>
              <span className="badge muted">{f.status}</span>
              <span className="mono">{f.path}</span>
              <span className="plus">+{f.additions ?? '?'}</span>
              <span className="minus">-{f.deletions ?? '?'}</span>
              {f.binary && <span className="badge warn">{n.binaryBadge}</span>}
              {f.sensitive && <span className="badge bad">{n.sensitiveBadge}</span>}
            </summary>
            {note ? (
              <div className="warning" style={{ margin: 8 }}>{note}</div>
            ) : (
              <div className="diff-body">
                <pre>
                  {body!.lines.map((l, i) => (
                    <span key={i} className={`dl ${l.kind}`}>{l.text || ' '}</span>
                  ))}
                </pre>
              </div>
            )}
          </details>
        );
      })}
      {files.length === 0 && <div className="muted">{t.review.noFiles}</div>}
    </div>
  );
}
