import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface JournalEntry {
  at: string;
  publicationId: string;
  taskId: string;
  reviewId: string | null;
  headSha: string;
  mode: 'dry-run' | 'publish';
  outcome: 'ready' | 'failed' | 'published' | 'pr_created' | 'error';
  blockers: string[];
  reported: boolean;
  pullRequest?: { number: number; url: string };
}

/**
 * Append-only record of every run, on the publisher's own volume. The controller is the source of
 * truth (its unique index allows one publish per review); this journal is the publisher's second,
 * independent memory: E-2B refuses to push for a review the journal already lists as published,
 * even if the controller's record were lost or rolled back.
 */
export class Journal {
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = join(stateDir, 'publications.jsonl');
  }

  async append(entry: JournalEntry): Promise<void> {
    await mkdir(join(this.file, '..'), { recursive: true });
    await appendFile(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  }

  async entries(): Promise<JournalEntry[]> {
    const text = await readFile(this.file, 'utf8').catch(() => '');
    return text.split('\n').filter(Boolean).flatMap((line) => {
      try {
        return [JSON.parse(line) as JournalEntry];
      } catch {
        return [];
      }
    });
  }

  async publishedReview(reviewId: string): Promise<boolean> {
    return (await this.entries()).some((e) => e.reviewId === reviewId && e.outcome === 'published');
  }

  /** Every run is listed; publish runs also get an 'published' entry written before the controller is told. */
  async latest(reviewId: string): Promise<JournalEntry | null> {
    return (await this.entries()).filter((e) => e.reviewId === reviewId).at(-1) ?? null;
  }
}
