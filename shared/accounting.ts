import type { CashMovementCorrection } from './cash.js';

export type AccountingRange = { from: string; to: string };
export type AccountingAmounts = {
  sales: number; voidedSales: number; cash: number; transfer: number; tokens: number; tokenValue: number;
  installments: number; charges: number; customerPayments: number; issued: number; redeemed: number;
};
export type AccountingDay = AccountingAmounts & { day: string; transactions: number };
export type AccountingMovement = CashMovementCorrection & {
  id: number; shiftId: number; date: string; kind: string; category: string; reason: string;
  amount: number; salesDelta: number; purchasesDelta: number;
};
export type AccountingClose = {
  id: number; cashier: string; date: string; note: string; openingBase: number; nextBase: number | null;
  salesExpected: number | null; salesCounted: number | null; purchasesExpected: number | null; purchasesCounted: number | null;
  transferExpected: number | null; transferConfirmed: number | null; expectedTokens: number | null; countedTokens: number | null;
};
type AccountChange = { day: string; id: number; charges: number; payments: number };
export type AccountingData = AccountingRange & {
  asOf: string; days: AccountingDay[]; movements: AccountingMovement[]; closes: AccountingClose[];
  customers: { id: number; name: string; opening: number }[]; changes: AccountChange[];
};

const dayMs = 86_400_000;
const isoDay = (date: Date) => date.toISOString().slice(0, 10);
export const dayAfter = (day: string) => isoDay(new Date(Date.parse(day + 'T00:00:00Z') + dayMs));
export const colombianDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
});

function parseDay(input: string | null) {
  if (!input || !/^20\d\d-\d\d-\d\d$/.test(input)) return null;
  const date = new Date(input + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && isoDay(date) === input ? date : null;
}

export function accountingDateRange(from: string | null, to: string | null): AccountingRange | null {
  if (!from || !to || from > to || !parseDay(from) || !parseDay(to)) return null;
  return { from, to };
}

export function accountingPeriod(kind: string | null, anchor: string | null): AccountingRange | null {
  const date = parseDay(kind === 'month' && anchor?.length === 7 ? anchor + '-01' : anchor);
  if (!date) return null;
  if (kind === 'month') {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    return { from: isoDay(new Date(Date.UTC(year, month, 1))), to: isoDay(new Date(Date.UTC(year, month + 1, 0))) };
  }
  if (kind !== 'week') return null;
  const monday = date.getTime() - ((date.getUTCDay() + 6) % 7) * dayMs;
  return { from: isoDay(new Date(monday)), to: isoDay(new Date(monday + 6 * dayMs)) };
}

export function emptyAmounts(): AccountingAmounts {
  return { sales: 0, voidedSales: 0, cash: 0, transfer: 0, tokens: 0, tokenValue: 0, installments: 0,
    charges: 0, customerPayments: 0, issued: 0, redeemed: 0 };
}

export function accountingReport(data: AccountingData, period: AccountingRange) {
  const inPeriod = (day: string) => day >= period.from && day <= period.to;
  const localDay = (date: string) => colombianDay.format(new Date(date));
  const days = data.days.filter(({ day }) => inPeriod(day));
  const amounts = emptyAmounts();
  const fields = Object.keys(amounts) as (keyof AccountingAmounts)[];
  for (const day of days) for (const field of fields) amounts[field] += day[field];
  const customers = new Map(data.customers.map((entry) => [entry.id, { ...entry, charges: 0, payments: 0 }]));
  for (const entry of data.changes) {
    const customer = customers.get(entry.id);
    if (!customer) continue;
    if (entry.day < period.from) customer.opening += entry.charges - entry.payments;
    else if (inPeriod(entry.day)) {
      customer.charges += entry.charges;
      customer.payments += entry.payments;
    }
  }
  const accounts = [...customers.values()].filter(({ opening, charges, payments }) => opening || charges || payments)
    .map((account) => ({ ...account, closing: account.opening + account.charges - account.payments }));
  const movements = data.movements.filter(({ date }) => inPeriod(localDay(date)));
  const closes = data.closes.filter(({ date }) => inPeriod(localDay(date)));
  const clientChanges = data.changes.filter(({ day }) => inPeriod(day))
    .sort((a, b) => a.day.localeCompare(b.day) || a.id - b.id)
    .map((entry) => ({ ...entry, name: customers.get(entry.id)?.name ?? '' }));
  return { ...period, asOf: data.asOf, days, amounts, accounts, clientChanges, movements, closes };
}

export type AccountingReport = ReturnType<typeof accountingReport>;
