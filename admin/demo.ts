import { clubDay, type AdminSnapshot, type RegisterSummary } from '../shared/admin';

export function demoSnapshot(now = new Date()): AdminSnapshot {
  const day = clubDay(now);
  const today = new Date(day + 'T05:00:00.000Z');
  const days = Array.from({ length: 30 }, (_, index) => {
    const date = new Date(today.getTime() - (29 - index) * 86_400_000);
    const sales = [412_000, 238_000, 328_000, 392_000, 465_000, 708_000, 786_000][(index + 5) % 7];
    return {
      day: clubDay(date), sales, transactions: Math.round(sales / 16_000),
      cash: Math.round(sales * 0.60), transfer: Math.round(sales * 0.26), tokens: 5, tokenAmount: 18_000,
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
  return {
    version: 1, day, daily: days, active: shift(18, 0, false),
    closures: [shift(17, 1, true, -1500), shift(16, 2, true), shift(15, 3, true)],
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
