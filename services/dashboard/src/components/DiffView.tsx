import { parsePatch } from '@/lib/diff';
import type { DiffFile } from '@/lib/types';

/**
 * Per-file unified diff. Every line is a React text node (escaped); nothing from the patch is
 * ever used as HTML, a URL or an attribute that could execute.
 */
export function DiffView({ files, patch, omitted, withheld }: { files: DiffFile[]; patch: string | null; omitted: string[]; withheld: string | null }) {
  const parsed = new Map(parsePatch(patch).map((f) => [f.path, f]));
  const omittedSet = new Set(omitted);
  return (
    <div>
      {files.map((f, i) => {
        const body = parsed.get(f.path);
        let note: string | null = null;
        if (f.binary) note = 'Binary file - content not shown.';
        else if (f.sensitive) note = 'Sensitive file (credentials/keys pattern) - patch hidden by the worker.';
        else if (withheld) note = withheld;
        else if (patch === null) note = 'No patch recorded for this task (recorded before diff capture, or not reported).';
        else if (omittedSet.has(f.path) || !body) note = 'Patch for this file was omitted (size limit).';
        return (
          <details key={`${f.path}:${i}`} className="diff-file" open={files.length <= 20}>
            <summary>
              <span className="badge muted">{f.status}</span>
              <span className="mono">{f.path}</span>
              <span className="plus">+{f.additions ?? '?'}</span>
              <span className="minus">-{f.deletions ?? '?'}</span>
              {f.binary && <span className="badge warn">binary</span>}
              {f.sensitive && <span className="badge bad">sensitive</span>}
            </summary>
            {note ? (
              <div className="warning" style={{ margin: 8 }}>{note}</div>
            ) : (
              <div className="diff-body">
                <pre>
                  {body!.lines.map((l, n) => (
                    <span key={n} className={`dl ${l.kind}`}>{l.text || ' '}</span>
                  ))}
                </pre>
              </div>
            )}
          </details>
        );
      })}
      {files.length === 0 && <div className="muted">No files reported.</div>}
    </div>
  );
}
