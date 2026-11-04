import { Global, Inject, Injectable, Module } from '@nestjs/common';
import type { Database } from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { Clock } from '../common/clock.js';
import { SQLITE_CONNECTION } from '../database/database.module.js';

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  detailHash: string | null;
}

/**
 * Who changed what and when. Only a hash of the details is kept, so the log never becomes a second
 * copy of learning content or of anything sensitive the owner later deletes.
 */
@Injectable()
export class AuditService {
  constructor(@Inject(SQLITE_CONNECTION) private readonly db: Database, private readonly clock: Clock) {}

  record(actor: string, action: string, entityType: string, entityId: string, detail?: unknown): void {
    this.db.prepare(`INSERT INTO audit_events (id, at, actor, action, entity_type, entity_id, detail_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      randomUUID(), this.clock.now().toISOString(), actor, action, entityType, entityId,
      detail === undefined ? null : createHash('sha256').update(JSON.stringify(detail)).digest('hex'),
    );
  }

  forEntity(entityType: string, entityId: string): AuditEvent[] {
    return (this.db.prepare('SELECT * FROM audit_events WHERE entity_type = ? AND entity_id = ? ORDER BY at, rowid').all(entityType, entityId) as Array<Record<string, string | null>>)
      .map((r) => ({ id: r.id!, at: r.at!, actor: r.actor!, action: r.action!, entityType: r.entity_type!, entityId: r.entity_id!, detailHash: r.detail_hash }));
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
