import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { adminSnapshotId, alertPeriodStart, clubDay, dashboardRefreshMs, type AdminSnapshot,
  type PurchaseFunding, type PurchaseFundingResult, type RegisterSummary } from '../shared/admin.js';
import type { createCash } from './cash.js';
import { type createAccounts, ValidationError } from './accounts.js';
import { mobileAccountingRange, readAccounting } from './accounting.js';

type Row = Record<string, SQLOutputValue>;
type Cash = ReturnType<typeof createCash>;
type Accounts = ReturnType<typeof createAccounts>;

function registerSummary(shift: Row, totals: ReturnType<Cash['adminOverview']>['closures'][number]['totals']): RegisterSummary {
  return {
    id: Number(shift.id), cashier: String(shift.cashier), openedAt: String(shift.openedAt),
    closedAt: shift.closedAt === null ? null : String(shift.closedAt),
    salesTotal: totals.salesTotal, salesCount: totals.salesCount, cashReceived: totals.cashReceived,
    transferExpected: totals.transferExpected, salesExpected: totals.salesExpected,
    purchasesExpected: totals.purchasesExpected, expectedTokens: totals.expectedTokens,
    salesDifference: totals.salesDifference, purchasesDifference: totals.purchasesDifference,
    transferDifference: totals.transferDifference, tokenDifference: totals.tokenDifference,
    salesDelivery: totals.salesDelivery, nextBase: shift.nextBase === null ? null : Number(shift.nextBase),
    closingNote: shift.closingNote === null ? '' : String(shift.closingNote),
  };
}

export function createAdminSnapshot(database: DatabaseSync, cash: Cash, accounts: Accounts, now = new Date()): AdminSnapshot {
  const day = clubDay(now);
  // Bogotá uses UTC−5. Bound the queries by local calendar days and exclude earlier data.
  const start = new Date(new Date(day + 'T05:00:00.000Z').getTime() - 29 * 86_400_000);
  const daily = Array.from({ length: 30 }, (_, index) => ({
    day: clubDay(new Date(start.getTime() + index * 86_400_000)),
    sales: 0, transactions: 0, cash: 0, transfer: 0, tokens: 0, tokenAmount: 0,
  }));
  const byDay = new Map(daily.map((item) => [item.day, item]));
  for (const row of database.prepare(`
    SELECT date(created_at, '-5 hours') AS day,
      COUNT(CASE WHEN NOT EXISTS (SELECT 1 FROM sale_credit_shares WHERE share_sale_id = valid_sales.id) THEN 1 END) AS transactions,
      SUM(total) AS amount
    FROM valid_sales WHERE created_at >= ? GROUP BY day
  `).all(start.toISOString())) {
    const target = byDay.get(String(row.day));
    if (target) Object.assign(target, { sales: Number(row.amount), transactions: Number(row.transactions) });
  }
  for (const row of database.prepare(`
    SELECT date(created_at, '-5 hours') AS day, SUM(cash) AS cash, SUM(transfer) AS transfer,
      SUM(tokens) AS tokens, SUM(tokens * token_value) AS tokenAmount
    FROM valid_account_payments WHERE created_at >= ? GROUP BY day
  `).all(start.toISOString())) {
    const target = byDay.get(String(row.day));
    if (target) Object.assign(target, {
      cash: Number(row.cash), transfer: Number(row.transfer), tokens: Number(row.tokens), tokenAmount: Number(row.tokenAmount),
    });
  }
  const { active, closures, pendingBalance } = cash.adminOverview();
  return {
    version: 1, purchaseFundingEnabled: true, day, daily, pendingBalance, openBalances: accounts.openBalances(),
    accounting: readAccounting(database, mobileAccountingRange(now), now),
    active: active && registerSummary(active.shift, active.totals),
    closures: closures.map(({ shift, totals }) => registerSummary(shift, totals)),
    unexpectedWithdrawals: database.prepare(`
      SELECT id, shift_id AS shiftId, kind, amount, category, reason, created_at AS createdAt
      FROM cash_movements WHERE kind IN ('sales_expense', 'sales_withdrawal') AND created_at >= ? AND created_at <= ?
      ORDER BY created_at DESC, id DESC
    `).all(alertPeriodStart(day).toISOString(), now.toISOString()).map((row) => ({
      id: Number(row.id), shiftId: Number(row.shiftId),
      kind: row.kind === 'sales_expense' ? 'sales_expense' : 'sales_withdrawal', amount: Number(row.amount),
      category: String(row.category), reason: String(row.reason), createdAt: String(row.createdAt),
    })),
    inventory: database.prepare(`
      SELECT id, name, brand, presentation,
        COALESCE((SELECT SUM(units) FROM inventory_movements WHERE product_id = products.id), 0) AS stock
      FROM products WHERE active = 1 ORDER BY name COLLATE NOCASE, id
    `).all().map((row) => ({
      id: Number(row.id), name: String(row.name), brand: String(row.brand),
      presentation: String(row.presentation), stock: Number(row.stock),
    })),
    play: {
      billiard: database.prepare(`
        SELECT table_number AS number, stopped_at IS NOT NULL AS paused
        FROM billiard_sessions WHERE closed_at IS NULL ORDER BY table_number
      `).all().map((row) => ({ table: Number(row.number), paused: Boolean(row.paused) })),
      tejo: database.prepare(`
        SELECT id, court_type AS type, court_number AS number,
          (SELECT COUNT(*) FROM tejo_rounds WHERE session_id = tejo_sessions.id) +
          (SELECT COUNT(*) FROM tejo_played WHERE session_id = tejo_sessions.id) AS rounds
        FROM tejo_sessions WHERE closed_at IS NULL ORDER BY court_type, court_number
      `).all().map((row) => ({ type: row.type === 'maxi' ? 'maxi' : 'largo', court: Number(row.number), rounds: Number(row.rounds) })),
    },
  };
}

export function startAdminSync(database: DatabaseSync, cash: Cash, accounts: Accounts) {
  const url = process.env.CAJA_SUPABASE_URL;
  const key = process.env.CAJA_SUPABASE_SECRET_KEY;
  if (!url && !key) return;
  if (!url || !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || !key?.startsWith('sb_secret_')) {
    console.warn('Sincronización desactivada. Revisa CAJA_SUPABASE_URL y CAJA_SUPABASE_SECRET_KEY.');
    return;
  }

  const api = url + '/rest/v1/';
  const endpoint = api + 'admin_snapshots?on_conflict=id';
  const fundingEndpoint = api + 'purchase_funding';
  const secret = key;
  let failureReported = false;
  let fundingFailureReported = false;

  async function receiveFunding() {
    const response = await fetch(fundingEndpoint + '?status=eq.pending&order=created_at.asc,id.asc&limit=50', {
      headers: { apikey: secret }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(String(response.status));
    const pending: PurchaseFunding[] = await response.json();
    for (const funding of pending) {
      let result: PurchaseFundingResult;
      try {
        result = { status: 'applied', movement_id: cash.applyRemotePurchaseFunding(funding), result_note: '' };
      } catch (error) {
        if (!(error instanceof ValidationError)) throw error;
        result = { status: 'rejected', movement_id: null, result_note: error.message };
      }
      const saved = await fetch(fundingEndpoint + '?id=eq.' + encodeURIComponent(funding.id) + '&status=eq.pending', {
        method: 'PATCH', headers: { apikey: secret, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ ...result, processed_at: new Date().toISOString() }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!saved.ok) throw new Error(String(saved.status));
    }
  }

  async function send() {
    try {
      await receiveFunding();
      if (fundingFailureReported) console.info('Recepción de aportes para compras restablecida.');
      fundingFailureReported = false;
    } catch {
      if (!fundingFailureReported) console.warn('No se pudieron sincronizar los aportes para compras. La caja volverá a intentarlo.');
      fundingFailureReported = true;
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST', headers: {
          apikey: secret, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify({ id: adminSnapshotId, payload: createAdminSnapshot(database, cash, accounts) }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(String(response.status));
      if (failureReported) console.info('Sincronización con Supabase restablecida.');
      failureReported = false;
    } catch {
      if (!failureReported) console.warn('No se pudo sincronizar con Supabase. La caja seguirá funcionando y volverá a intentarlo.');
      failureReported = true;
    } finally {
      setTimeout(() => void send(), dashboardRefreshMs).unref();
    }
  }

  void send();
}
