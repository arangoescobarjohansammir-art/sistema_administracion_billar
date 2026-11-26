import { clubDay, type AdminSnapshot, type RegisterSummary } from '../shared/admin';
import { accountingPeriod, emptyAmounts } from '../shared/accounting';

export function demoSnapshot(now = new Date()): AdminSnapshot {
  const day = clubDay(now);
  const today = new Date(day + 'T05:00:00.000Z');
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today.getTime() - (29 - index) * 86_400_000);
    if (index === 23 || index === 24) {
      const amount = index === 23 ? 8000 : -8000;
      return { day: clubDay(date), sales: amount, transactions: index === 23 ? 1 : 0, cash: amount,
        transfer: 0, tokens: 0, tokenAmount: 0, voidedSales: index === 24 ? 8000 : 0 };
    }
    const sales = [412_000, 238_000, 328_000, 392_000, 465_000, 708_000, 786_000][(index + 5) % 7];
    return {
      day: clubDay(date), sales, transactions: Math.round(sales / 16_000),
      cash: Math.round(sales * 0.60), transfer: Math.round(sales * 0.26), tokens: 5, tokenAmount: 18_000, voidedSales: 0,
    };
  });
  function shift(id: number, offset: number, closed: boolean, difference = 0): RegisterSummary {
    const date = days.at(-1 - offset)!;
    return {
      id, cashier: 'Cajera de demostración', openedAt: date.day + 'T17:00:00.000Z',
      closedAt: closed ? date.day + 'T23:35:00.000Z' : null,
      salesTotal: date.sales, salesCount: date.transactions, cashReceived: date.cash,
      transferExpected: date.transfer, salesExpected: date.cash + 100_000, purchasesExpected: 40_000,
      expectedTokens: 106, salesDifference: closed ? difference : null,
      purchasesDifference: closed ? 0 : null, transferDifference: closed ? 0 : null,
      tokenDifference: closed ? 0 : null, salesDelivery: closed ? date.cash + difference : null,
      nextBase: closed ? 100_000 : null,
      closingNote: difference ? 'Al contar el efectivo del turno faltaron $1.500.' : '',
    };
  }
  const closures = [shift(17, 1, true, -1500), shift(16, 2, true), shift(15, 3, true)];
  closures[0].pendingGames = {
    capturedAt: closures[0].closedAt!,
    billiards: [{ sessionId: 1, table: 2, products: 8000, time: 0, running: false }],
    tejo: [{ roundId: 1, courtType: 'maxi', court: 1, round: 1, amount: 8000 }],
  };
  return {
    version: 1, day, daily: days, active: shift(18, 0, false),
    closures,
    accounting: {
      from: accountingPeriod('week', days[0].day)!.from, to: day, asOf: now.toISOString(),
      days: days.map(({ day, sales, cash, transfer, tokens, tokenAmount, transactions, voidedSales }) => ({
        ...emptyAmounts(), day, sales, cash, transfer, tokens, tokenValue: tokenAmount, transactions, voidedSales, issued: 8, redeemed: 4,
      })),
      movements: [
        { id: 1, shiftId: 17, date: closures[0].closedAt!, kind: 'purchase_in', category: 'Compras',
          reason: 'Pedido de cerveza y gaseosas', amount: 40_000, salesDelta: 0, purchasesDelta: 40_000 },
        { id: 2, shiftId: 17, date: closures[0].closedAt!, kind: 'staff_payment', category: 'Empleado ficticio',
          reason: 'Pago de jornada', amount: 5_000, salesDelta: -5_000, purchasesDelta: 0,
          originalAmount: 50_000, correctedAt: closures[0].closedAt!, correctionReason: 'Error al escribir el importe', compensationId: 3 },
        { id: 3, shiftId: 17, date: closures[0].closedAt!, kind: 'sales_in', category: 'Ajuste de ejemplo',
          reason: 'Entrada usada para compensar el error', amount: 0, salesDelta: 0, purchasesDelta: 0,
          originalAmount: 45_000, correctedAt: closures[0].closedAt!, compensatesPaymentId: 2 },
      ],
      closes: closures.map((entry) => ({
        id: entry.id, cashier: entry.cashier, date: entry.closedAt!, note: entry.closingNote, openingBase: 100_000, nextBase: entry.nextBase,
        salesExpected: entry.salesExpected, salesCounted: entry.salesExpected + (entry.salesDifference ?? 0),
        purchasesExpected: entry.purchasesExpected, purchasesCounted: entry.purchasesExpected,
        transferExpected: entry.transferExpected, transferConfirmed: entry.transferExpected,
        expectedTokens: entry.expectedTokens, countedTokens: entry.expectedTokens,
      })),
      customers: [{ id: 1, name: 'Cliente ficticio', opening: 18_000 }],
      changes: [{ day, id: 1, charges: 42_000, payments: 15_000 }],
    },
    unexpectedWithdrawals: [
      { id: 2, shiftId: 18, kind: 'sales_expense', amount: 24_000, category: 'Bebidas', reason: 'Compra imprevista de gaseosas',
        createdAt: new Date(now.getTime() - 35 * 60_000).toISOString() },
      { id: 1, shiftId: 17, kind: 'sales_withdrawal', amount: 12_000, category: 'Mantenimiento', reason: 'Cambio de un bombillo',
        createdAt: days.at(-2)!.day + 'T20:15:00.000Z' },
    ],
    pendingBalance: 78_000,
    openBalances: [
      { id: 1, name: 'Cliente de ejemplo 1', balance: 45_000 },
      { id: 2, name: 'Cliente de ejemplo 2', balance: 33_000 },
    ],
    inventory: [
      { id: 1, name: 'Cerveza rubia', brand: '', presentation: 'Botella', stock: 54 },
      { id: 2, name: 'Aguardiente sin azúcar', brand: '', presentation: 'Botella', stock: 3 },
      { id: 3, name: 'Aguardiente tradicional', brand: '', presentation: 'Media', stock: 8 },
      { id: 4, name: 'Gaseosa cola', brand: '', presentation: 'Personal', stock: 16 },
      { id: 5, name: 'Papas limón', brand: '', presentation: 'Paquete', stock: 0 },
    ],
    play: {
      billiard: [{ table: 1, paused: false }, { table: 3, paused: true }, { table: 5, paused: false }],
      tejo: [{ type: 'maxi', court: 2, rounds: 3 }, { type: 'largo', court: 4, rounds: 5 }],
    },
  };
}
