import type { DatabaseSync } from 'node:sqlite';
import type { AccountCycle, AccountHistory, AccountMovement } from '../shared/account-history.js';

export function createAccountHistory(database: DatabaseSync) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const exists = database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'account_history_events'").get();
    database.exec(`
      CREATE TABLE IF NOT EXISTS account_history_events (
        id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES customer_accounts(id),
        kind TEXT NOT NULL CHECK (kind IN ('sale', 'payment', 'void')),
        source_id INTEGER NOT NULL, UNIQUE (kind, source_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS account_history_by_account ON account_history_events(account_id, id);

      CREATE TRIGGER IF NOT EXISTS account_history_sale AFTER INSERT ON sales
      WHEN NEW.account_id IS NOT NULL BEGIN
        INSERT INTO account_history_events (account_id, kind, source_id) VALUES (NEW.account_id, 'sale', NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS account_history_payment AFTER INSERT ON account_payments
      WHEN NEW.account_id IS NOT NULL BEGIN
        INSERT INTO account_history_events (account_id, kind, source_id) VALUES (NEW.account_id, 'payment', NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS account_history_void AFTER INSERT ON sale_voids BEGIN
        INSERT INTO account_history_events (account_id, kind, source_id)
        SELECT account_id, 'void', id FROM sales WHERE id = NEW.sale_id AND account_id IS NOT NULL;
      END;
    `);
    if (!exists) {
      // Older records have separate sequences. Keep a sale and its payment together when their timestamps tie.
      database.exec(`
        INSERT INTO account_history_events (account_id, kind, source_id)
        SELECT account_id, kind, source_id FROM (
          SELECT account_id, 'sale' AS kind, id AS source_id, created_at, 0 AS category, id AS batch, 0 AS position
          FROM sales WHERE account_id IS NOT NULL
          UNION ALL
          SELECT account_id, 'payment', id, created_at, CASE WHEN sale_id IS NULL THEN 1 ELSE 0 END,
            COALESCE(sale_id, id), 1 FROM account_payments WHERE account_id IS NOT NULL
          UNION ALL
          SELECT sales.account_id, 'void', sales.id, sale_voids.created_at, 2, sales.id, 0
          FROM sale_voids JOIN sales ON sales.id = sale_voids.sale_id WHERE sales.account_id IS NOT NULL
        ) ORDER BY created_at, category, batch, position;
      `);
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  const events = database.prepare(`
    SELECT event.id, event.kind, event.source_id AS sourceId,
      CASE event.kind WHEN 'sale' THEN sale.created_at WHEN 'payment' THEN payment.created_at ELSE correction.created_at END AS createdAt,
      CASE event.kind WHEN 'sale' THEN sale.total
        WHEN 'payment' THEN payment.cash + payment.transfer + payment.tokens * payment.token_value
        ELSE sale.total - COALESCE(linked.cash + linked.transfer + linked.tokens * linked.token_value, 0) END AS amount,
      correction.reason
    FROM account_history_events event
    LEFT JOIN sales sale ON event.kind IN ('sale', 'void') AND sale.id = event.source_id
    LEFT JOIN account_payments payment ON event.kind = 'payment' AND payment.id = event.source_id
    LEFT JOIN sale_voids correction ON event.kind = 'void' AND correction.sale_id = event.source_id
    LEFT JOIN account_payments linked ON event.kind = 'void' AND linked.sale_id = event.source_id
    WHERE event.account_id = ? ORDER BY event.id
  `);

  return (accountId: number): AccountHistory => {
    const closed: AccountCycle[] = [];
    const cycleBySale = new Map<number, AccountCycle>();
    let current: AccountCycle | null = null;
    let balance = 0;
    for (const event of events.iterate(accountId)) {
      const id = Number(event.id);
      const kind = event.kind as AccountMovement['kind'];
      const sourceId = Number(event.sourceId);
      const amount = Number(event.amount);
      const createdAt = String(event.createdAt);
      const movement = { id, kind, sourceId, amount, createdAt,
        ...(event.reason === null ? {} : { reason: String(event.reason) }) };

      // A refunded sale that was paid in full changes no outstanding balance.
      const original = kind === 'void' && amount === 0 ? cycleBySale.get(sourceId) : undefined;
      if (original && original !== current) {
        original.movements.push({ ...movement, balanceAfter: 0 });
        continue;
      }
      if (current === null) current = { id, openedAt: createdAt, closedAt: null, movements: [] };
      if (kind === 'sale') cycleBySale.set(sourceId, current);
      balance += kind === 'sale' ? amount : -amount;
      current.movements.push({ ...movement, balanceAfter: balance });
      if (balance === 0) {
        current.closedAt = createdAt;
        closed.push(current);
        current = null;
      }
    }
    return { current, closed: closed.reverse() };
  };
}
