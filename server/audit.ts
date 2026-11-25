import type { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import type { AuditKind } from '../shared/operators.js';
import { activeShiftId } from './cash-ledger.js';
import { requestOperator } from './operators.js';

export function createAudit(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cash_audit (
      id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES cash_operators(id),
      actor_name TEXT NOT NULL, shift_id INTEGER REFERENCES cash_shifts(id), kind TEXT NOT NULL,
      target_id INTEGER NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS cash_audit_by_target ON cash_audit(kind, target_id, id);
  `);
  function record(request: IncomingMessage, kind: AuditKind, targetId: number, reason = '') {
    const actor = requestOperator(request);
    if (!actor) throw new Error('Falta el usuario de la operación.');
    database.prepare(`
      INSERT INTO cash_audit (operator_id, actor_name, shift_id, kind, target_id, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(actor.id, actor.name, activeShiftId(database), kind, targetId, reason, new Date().toISOString());
  }

  function list(before: number) {
    return database.prepare(`
      SELECT id, actor_name AS actorName, shift_id AS shiftId, kind, target_id AS targetId, reason, created_at AS createdAt
      FROM cash_audit WHERE id < ? ORDER BY id DESC LIMIT 50
    `).all(before);
  }

  return { record, list };
}
export type Audit = ReturnType<typeof createAudit>;
