import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Keys of events already delivered, so a caller that repeats an event (retry, restart) never double-posts. */
export interface SentStore {
  has(key: string): boolean;
  add(key: string, at: number): void;
}

const RETENTION_MS = 30 * 24 * 3600 * 1000;

export class MemoryStore implements SentStore {
  protected readonly sent = new Map<string, number>();
  has(key: string): boolean {
    return this.sent.has(key);
  }
  add(key: string, at: number): void {
    this.sent.set(key, at);
    for (const [k, t] of this.sent) if (t < at - RETENTION_MS) this.sent.delete(k);
  }
}

/** JSON file on the notifier-data volume, rewritten atomically (temp file + rename). */
export class FileStore extends MemoryStore {
  constructor(private readonly file: string) {
    super();
    mkdirSync(dirname(file), { recursive: true });
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, number>;
      for (const [k, t] of Object.entries(data)) if (typeof t === 'number') this.sent.set(k, t);
    } catch {
      // Missing or unreadable: start empty. Worst case is one repeated message per recent event.
    }
  }
  override add(key: string, at: number): void {
    super.add(key, at);
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.sent)), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
}
