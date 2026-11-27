import type { DatabaseSync } from 'node:sqlite';
import { colombianDay, dayAfter, emptyAmounts, type AccountingAmounts, type AccountingData, type AccountingRange,
  type AccountingClose, type AccountingDay, type AccountingMovement } from '../shared/accounting.js';

export function readAccounting(database: DatabaseSync, range: AccountingRange, now = new Date()): AccountingData {
  const start = range.from + 'T05:00:00.000Z';
  const end = dayAfter(range.to) + 'T05:00:00.000Z';
  const asOf = now.toISOString();
  const cutoff = asOf < end ? new Date(now.getTime() + 1).toISOString() : end;
  const salesEvents = `
    SELECT s.created_at AS at, s.account_id AS account, s.total AS sales, 0 AS cancellation,
      (NOT EXISTS (SELECT 1 FROM sale_credit_shares WHERE share_sale_id = s.id) AND
       NOT EXISTS (SELECT 1 FROM billiard_charge_moves WHERE replacement_sale_id = s.id)) AS transactions
    FROM sales s WHERE s.created_at < $end
    UNION ALL
    SELECT v.created_at, s.account_id, -s.total, CASE WHEN move.original_sale_id IS NULL THEN s.total ELSE 0 END, 0
    FROM sale_voids v JOIN sales s ON s.id = v.sale_id
    LEFT JOIN billiard_charge_moves move ON move.original_sale_id = v.sale_id WHERE v.created_at < $end
  `;
  const paymentEvents = `
    SELECT created_at AS at, account_id AS account, sale_id AS sale, cash, transfer, tokens, token_value AS rate
      FROM account_payments WHERE created_at < $end
    UNION ALL
    SELECT v.created_at, p.account_id, p.sale_id, -p.cash, -p.transfer, -p.tokens, p.token_value
      FROM sale_voids v JOIN account_payments p ON p.sale_id = v.sale_id WHERE v.created_at < $end
    UNION ALL
    SELECT v.created_at, p.account_id, p.sale_id, -p.cash, -p.transfer, -p.tokens, p.token_value
      FROM account_payment_voids v JOIN account_payments p ON p.id = v.payment_id WHERE v.created_at < $end
  `;
  const rows = database.prepare(`
    WITH events AS (
      SELECT at, account, sales, cancellation AS voidedSales, transactions, 0 AS cash, 0 AS transfer, 0 AS tokens, 0 AS tokenValue,
        0 AS installments, CASE WHEN account IS NULL THEN 0 ELSE sales END AS charges, 0 AS customerPayments FROM (${salesEvents})
      UNION ALL
      SELECT at, account, 0, 0, 0, cash, transfer, tokens, tokens * rate,
        CASE WHEN sale IS NULL THEN cash + transfer + tokens * rate ELSE 0 END, 0,
        CASE WHEN account IS NULL THEN 0 ELSE cash + transfer + tokens * rate END FROM (${paymentEvents})
    )
    SELECT CASE WHEN at < $start THEN '' ELSE date(at, '-5 hours') END AS day, account,
      SUM(sales) AS sales, SUM(voidedSales) AS voidedSales, SUM(transactions) AS transactions, SUM(cash) AS cash, SUM(transfer) AS transfer,
      SUM(tokens) AS tokens, SUM(tokenValue) AS tokenValue, SUM(installments) AS installments,
      SUM(charges) AS charges, SUM(customerPayments) AS customerPayments
    FROM events WHERE at >= $start OR account IS NOT NULL GROUP BY day, account
  `).all({ $start: start, $end: cutoff });
  const days = new Map<string, AccountingDay>();
  const dayAt = (day: string) => {
    let value = days.get(day);
    if (!value) { value = { day, transactions: 0, ...emptyAmounts() }; days.set(day, value); }
    return value;
  };
  const opening = new Map<number, number>();
  const changes: AccountingData['changes'] = [];
  const fields = Object.keys(emptyAmounts()) as (keyof AccountingAmounts)[];
  for (const row of rows) {
    const day = String(row.day);
    const charges = Number(row.charges);
    const payments = Number(row.customerPayments);
    if (day) {
      const value = dayAt(day);
      for (const field of fields) value[field] += Number(row[field] ?? 0);
      value.transactions += Number(row.transactions);
      if (row.account !== null && (charges || payments)) changes.push({ day, id: Number(row.account), charges, payments });
    } else if (row.account !== null) opening.set(Number(row.account), charges - payments);
  }
  const tokens = database.prepare(`
    SELECT date(at, '-5 hours') AS day, SUM(issued) AS issued, SUM(redeemed) AS redeemed FROM (
      SELECT issued_at AS at, 1 AS issued, 0 AS redeemed FROM tejo_benefits WHERE issued_at >= $start AND issued_at < $end
      UNION ALL
      SELECT issued_at, 1, 0 FROM tejo_slot_benefits WHERE issued_at >= $start AND issued_at < $end
      UNION ALL
      SELECT created_at, 0, tokens FROM tejo_redemptions WHERE round_id IS NULL AND created_at >= $start AND created_at < $end
      UNION ALL
      SELECT v.created_at, 0, -r.tokens FROM tejo_redemption_voids v JOIN tejo_redemptions r ON r.id = v.redemption_id
        WHERE r.round_id IS NULL AND v.created_at >= $start AND v.created_at < $end
    ) GROUP BY day
  `).all({ $start: start, $end: cutoff });
  for (const token of tokens) Object.assign(dayAt(String(token.day)), { issued: Number(token.issued), redeemed: Number(token.redeemed) });

  const movements = database.prepare(`
    SELECT id, shift_id AS shiftId, created_at AS date, kind, category, reason, amount,
      sales_delta AS salesDelta, purchases_delta AS purchasesDelta, original_amount AS originalAmount,
      corrected_at AS correctedAt, correction_reason AS correctionReason, compensation_id AS compensationId,
      compensates_payment_id AS compensatesPaymentId
    FROM effective_cash_movements WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id
  `).all(start, cutoff) as unknown as AccountingMovement[];
  const closes = database.prepare(`
    SELECT id, cashier, closed_at AS date, closing_note AS note, opening_base AS openingBase, next_base AS nextBase,
      sales_expected AS salesExpected, sales_counted AS salesCounted, purchases_expected AS purchasesExpected,
      purchases_counted AS purchasesCounted, transfer_expected AS transferExpected, transfer_confirmed AS transferConfirmed,
      expected_tokens AS expectedTokens, counted_tokens AS countedTokens
    FROM cash_shifts WHERE closed_at >= ? AND closed_at < ? ORDER BY closed_at, id
  `).all(start, cutoff) as unknown as AccountingClose[];
  const relevant = new Set(changes.map(({ id }) => id));
  for (const [id, balance] of opening) if (balance) relevant.add(id);
  const customers = database.prepare('SELECT id, name FROM customer_accounts ORDER BY name COLLATE NOCASE, id').all()
    .filter(({ id }) => relevant.has(Number(id)))
    .map(({ id, name }) => ({ id: Number(id), name: String(name), opening: opening.get(Number(id)) ?? 0 }));
  return { ...range, asOf, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), movements, closes, customers, changes };
}

export function mobileAccountingRange(now: Date): AccountingRange {
  const day = colombianDay.format(now);
  const [year, month] = day.split('-').map(Number);
  return { from: new Date(Date.UTC(year, month - 4, 1)).toISOString().slice(0, 10), to: day };
}
