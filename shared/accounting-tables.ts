import { cashMovementCorrectionText, cashMovements, type CashMovementKind } from './cash.js';
import type { AccountingReport } from './accounting.js';

const number = new Intl.NumberFormat('es-CO');
const clock = new Intl.DateTimeFormat('es-CO', { timeZone: 'America/Bogota', dateStyle: 'short', timeStyle: 'short' });
export const accountingMoney = (value: number) => (value < 0 ? '-$' : '$') + number.format(Math.abs(value));
export const accountingDate = (value: string) => clock.format(new Date(value)).replace(/[\u00a0\u202f]/g, ' ');
const dayLabel = (day: string) => day.split('-').reverse().join('/');

export function accountingTotals(report: AccountingReport) {
  const { amounts, accounts, movements } = report;
  const kinds = new Map<string, number>();
  for (const entry of movements) kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + entry.amount);
  return [
    ['Ventas y cargos netos', accountingMoney(amounts.sales)],
    ['Ventas y cargos anulados', accountingMoney(amounts.voidedSales)],
    ['Cobros netos en efectivo', accountingMoney(amounts.cash)],
    ['Cobros netos por transferencia', accountingMoney(amounts.transfer)],
    ['Valor de fichas en pagos', accountingMoney(amounts.tokenValue)],
    ['Abonos a cuentas', accountingMoney(amounts.installments)],
    ['Aportes en efectivo para compras', accountingMoney(kinds.get('purchase_in') ?? 0)],
    ['Pagos desde el fondo para compras', accountingMoney(kinds.get('purchase_expense') ?? 0)],
    ['Gastos pagados con caja de ventas', accountingMoney(kinds.get('sales_expense') ?? 0)],
    ['Pagos diarios al personal', accountingMoney(kinds.get('staff_payment') ?? 0)],
    ['Otros retiros de caja de ventas', accountingMoney(kinds.get('sales_withdrawal') ?? 0)],
    ['Saldo de clientes al inicio', accountingMoney(accounts.reduce((sum, account) => sum + account.opening, 0))],
    ['Saldo de clientes al corte', accountingMoney(accounts.reduce((sum, account) => sum + account.closing, 0))],
    ['Fichas entregadas en tejo', number.format(amounts.issued)],
    ['Fichas recibidas como pago', number.format(amounts.tokens)],
    ['Fichas recibidas en canjes', number.format(amounts.redeemed)],
    ['Turnos cerrados', number.format(report.closes.length)],
  ];
}

function closeDifferences(report: AccountingReport) {
  const metrics = [
    ['Caja de ventas', 'salesExpected', 'salesCounted', accountingMoney],
    ['Fondo para compras', 'purchasesExpected', 'purchasesCounted', accountingMoney],
    ['Transferencias', 'transferExpected', 'transferConfirmed', accountingMoney],
    ['Fichas físicas', 'expectedTokens', 'countedTokens', (value: number) => number.format(value)],
  ] as const;
  return metrics.map(([name, expected, counted, format]) => {
    let missing = 0, excess = 0, withoutCount = 0;
    for (const close of report.closes) {
      const actual = close[counted];
      const target = close[expected];
      if (actual === null || target === null) { withoutCount++; continue; }
      missing += Math.max(target - actual, 0);
      excess += Math.max(actual - target, 0);
    }
    return [name, format(missing), format(excess), number.format(withoutCount)];
  });
}

function comparison(expected: number | null, actual: number | null, format: (value: number) => string) {
  if (expected === null || actual === null) return 'Sin datos';
  const difference = actual - expected;
  return format(expected) + ' / ' + format(actual) + '\n' +
    (difference ? (difference > 0 ? 'Sobran ' : 'Faltan ') + format(Math.abs(difference)) : 'Cuadrado');
}

export type AccountingTable = {
  title: string; headers: string[]; widths: number[]; rows: string[][]; right?: number[];
};

export function accountingTables(report: AccountingReport): AccountingTable[] {
  const staff = new Map<string, { name: string; payments: number; total: number }>();
  for (const movement of report.movements) {
    if (movement.kind !== 'staff_payment' || movement.amount === 0) continue;
    const key = movement.category.toLocaleLowerCase('es-CO').replace(/\s+/g, ' ');
    const entry = staff.get(key) ?? { name: movement.category, payments: 0, total: 0 };
    entry.payments++;
    entry.total += movement.amount;
    staff.set(key, entry);
  }
  return [
    {
      title: 'Diferencias acumuladas de cierres',
      headers: ['Fondo o medio', 'Faltantes', 'Sobrantes', 'Turnos sin datos'],
      widths: [184, 112, 112, 112], right: [1, 2, 3],
      rows: report.closes.length ? closeDifferences(report) : [],
    },
    {
      title: 'Ventas y cobros por día',
      headers: ['Fecha', 'Ventas netas', 'Efectivo', 'Transferencias', 'Fichas (COP)', 'Abonos'],
      widths: [75, 89, 89, 89, 89, 89], right: [1, 2, 3, 4, 5],
      rows: report.days.map((row) => [dayLabel(row.day), accountingMoney(row.sales), accountingMoney(row.cash),
        accountingMoney(row.transfer), accountingMoney(row.tokenValue), accountingMoney(row.installments)]),
    },
    {
      title: 'Cuadre por turno cerrado',
      headers: ['Cierre y cajero', 'Caja de ventas', 'Fondo compras', 'Transferencias', 'Fichas'],
      widths: [135, 102, 102, 102, 79],
      rows: report.closes.map((row) => [
        '#' + row.id + ' · ' + accountingDate(row.date) + '\n' + row.cashier,
        comparison(row.salesExpected, row.salesCounted, accountingMoney),
        comparison(row.purchasesExpected, row.purchasesCounted, accountingMoney),
        comparison(row.transferExpected, row.transferConfirmed, accountingMoney),
        comparison(row.expectedTokens, row.countedTokens, (value) => number.format(value)),
      ]),
    },
    {
      title: 'Entrega y observaciones de los cierres',
      headers: ['Cierre', 'Base inicial', 'Base dejada', 'Efectivo entregado¹', 'Observación'],
      widths: [100, 74, 74, 126, 146], right: [1, 2],
      rows: report.closes.map((row) => [
        '#' + row.id + '\n' + accountingDate(row.date), accountingMoney(row.openingBase),
        row.nextBase === null ? 'Sin dato' : accountingMoney(row.nextBase),
        'Ventas: ' + (row.salesCounted === null || row.nextBase === null ? 'Sin dato' : accountingMoney(row.salesCounted - row.nextBase)) +
          '\nCompras: ' + (row.purchasesCounted === null ? 'Sin dato' : accountingMoney(row.purchasesCounted)), row.note || '—',
      ]),
    },
    {
      title: 'Movimientos de los fondos',
      headers: ['Fecha y turno', 'Movimiento y motivo', 'Importe', 'Caja ventas', 'Fondo compras'],
      widths: [107, 185, 76, 76, 76], right: [2, 3, 4],
      rows: report.movements.map((row) => [
        accountingDate(row.date) + '\nMov. #' + row.id + ' · turno #' + row.shiftId,
        (cashMovements[row.kind as CashMovementKind]?.label ?? row.kind) + '\n' + row.category + ' · ' + row.reason +
          (row.correctedAt ? '\nCorregido el ' + accountingDate(row.correctedAt) + '\n' + cashMovementCorrectionText(row, accountingMoney) : ''),
        accountingMoney(row.amount), accountingMoney(row.salesDelta), accountingMoney(row.purchasesDelta),
      ]),
    },
    {
      title: 'Saldos por cliente',
      headers: ['Cliente', 'Saldo inicial', 'Cargos netos', 'Pagos netos', 'Saldo al corte'],
      widths: [164, 89, 89, 89, 89], right: [1, 2, 3, 4],
      rows: report.accounts.map((row) => [row.name, accountingMoney(row.opening), accountingMoney(row.charges),
        accountingMoney(row.payments), accountingMoney(row.closing)]),
    },
    {
      title: 'Pagos diarios por empleado',
      headers: ['Empleado', 'Pagos registrados', 'Total pagado'],
      widths: [260, 130, 130], right: [1, 2],
      rows: [...staff.values()].sort((a, b) => a.name.localeCompare(b.name, 'es-CO'))
        .map(({ name, payments, total }) => [name, number.format(payments), accountingMoney(total)]),
    },
    {
      title: 'Cargos y pagos por cliente y día',
      headers: ['Fecha', 'Cliente', 'Cargos netos', 'Pagos netos'],
      widths: [95, 225, 100, 100], right: [2, 3],
      rows: report.clientChanges.map((row) => [dayLabel(row.day), row.name, accountingMoney(row.charges), accountingMoney(row.payments)]),
    },
  ];
}

export function accountingFilename(report: AccountingReport) {
  return 'patio-bonito-reporte-' + report.from + '-a-' + report.to + '.pdf';
}
