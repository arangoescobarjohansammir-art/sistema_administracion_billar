import type { DatabaseSync } from 'node:sqlite';

export function installCashReconciliation(database: DatabaseSync) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const columns = [
      ['cash_shifts', 'INTEGER NOT NULL DEFAULT 0'],
      ['cash_counts', 'INTEGER'],
    ];
    for (const [table, definition] of columns) {
      if (!database.prepare('PRAGMA table_info(' + table + ')').all().some(({ name }) => name === 'reconciliation_revision')) {
        database.exec('ALTER TABLE ' + table + ' ADD COLUMN reconciliation_revision ' + definition);
      }
    }

    // Track each change separately. An entry and its reversal can leave the same expected totals.
    const tracked = [
      ['cash_movements', 'NEW.shift_id', 'NEW.sales_delta <> 0 OR NEW.purchases_delta <> 0'],
      ['cash_staff_payment_corrections', '(SELECT shift_id FROM cash_movements WHERE id = NEW.payment_id)', '1'],
      ['cash_shift_payments', 'NEW.shift_id', '1'],
      ['cash_shift_redemptions', 'NEW.shift_id', 'EXISTS (SELECT 1 FROM tejo_redemptions WHERE id = NEW.redemption_id AND tokens > 0)'],
      ['tejo_redemption_voids', '(SELECT shift_id FROM cash_shift_redemptions WHERE redemption_id = NEW.redemption_id)', '1'],
      ['cash_shift_tokens', 'NEW.shift_id', '1'],
      ['cash_shift_slot_tokens', 'NEW.shift_id', '1'],
      ['account_payment_voids', '(SELECT shift_id FROM cash_shift_payments WHERE payment_id = NEW.payment_id)', '1'],
      ['sale_voids', `(SELECT tracked.shift_id FROM account_payments payment
        JOIN cash_shift_payments tracked ON tracked.payment_id = payment.id WHERE payment.sale_id = NEW.sale_id)`, '1'],
    ];
    for (const [table, shift, condition] of tracked) {
      database.exec(`
        CREATE TRIGGER IF NOT EXISTS cash_reconciliation_${table} AFTER INSERT ON ${table}
        WHEN ${condition} BEGIN
          UPDATE cash_shifts SET reconciliation_revision = reconciliation_revision + 1
          WHERE id = ${shift} AND closed_at IS NULL;
        END;
      `);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
