import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { jsonLinesLogger } from './filelog.js';

describe('log file', () => {
  it('appends every line to a JSON-lines file per day in the data volume, and to stdout', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'notifier-log-')), 'logs');
    const out: string[] = [];
    const log = jsonLinesLogger(dir, 'notifier', () => new Date('2026-11-26T11:00:00Z'), (l) => out.push(l));
    log.info('request', { type: 'reminder', status: 502, error: 'Discord unreachable' });
    log.info('request', { type: 'plan', status: 201 });
    const lines = readFileSync(join(dir, 'notifier-2026-11-26.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.status, l.error ?? null]), [[502, 'Discord unreachable'], [201, null]]);
    assert.equal(out.length, 2);
  });
});
