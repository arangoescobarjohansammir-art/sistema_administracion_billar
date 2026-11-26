export const maxPurchaseFunding = 1_000_000_000;
export const purchaseFundingCategory = 'Aporte del administrador';

export const cashMovements = {
  sales_in: { label: 'Entrada adicional a caja de ventas', sales: 1, purchases: 0 },
  purchase_in: { label: 'Entrega al fondo para compras', sales: 0, purchases: 1 },
  sales_expense: { label: 'Compra imprevista u otro gasto de ventas', sales: -1, purchases: 0 },
  staff_payment: { label: 'Pago diario al personal', sales: -1, purchases: 0 },
  purchase_expense: { label: 'Pago desde el fondo para compras', sales: 0, purchases: -1 },
  sales_withdrawal: { label: 'Otro retiro de caja de ventas', sales: -1, purchases: 0 },
  sales_to_purchases: { label: 'Traslado de ventas a fondo para compras', sales: -1, purchases: 1 },
  purchases_to_sales: { label: 'Traslado de fondo para compras a ventas', sales: 1, purchases: -1 },
} as const;

export type CashMovementKind = keyof typeof cashMovements;

export type CashCount = {
  salesCounted: number; purchasesCounted: number; transferConfirmed: number; countedTokens: number;
};

export type SavedCashCount = CashCount & { id: number; createdAt: string; reason: string };

export function expectedCashCounts(totals: {
  salesExpected: number; purchasesExpected: number; transferExpected: number; expectedTokens: number | null;
}) {
  return {
    salesExpected: totals.salesExpected, purchasesExpected: totals.purchasesExpected,
    transferExpected: totals.transferExpected, expectedTokens: totals.expectedTokens,
  };
}
