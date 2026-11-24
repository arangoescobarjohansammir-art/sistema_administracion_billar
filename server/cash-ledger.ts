import type { DatabaseSync } from 'node:sqlite';

export function activeShiftId(database: DatabaseSync) {
  const shift = database.prepare('SELECT id FROM cash_shifts WHERE closed_at IS NULL').get();
  return shift ? Number(shift.id) : null;
}
