export const cashMovements = {
  sales_in: { label: 'Entrada adicional a caja de ventas', sales: 1, purchases: 0 },
  purchase_in: { label: 'Entrega al fondo para compras', sales: 0, purchases: 1 },
  sales_expense: { label: 'Compra imprevista u otro gasto de ventas', sales: -1, purchases: 0 },
  purchase_expense: { label: 'Pago desde el fondo para compras', sales: 0, purchases: -1 },
  sales_withdrawal: { label: 'Otro retiro de caja de ventas', sales: -1, purchases: 0 },
  sales_to_purchases: { label: 'Traslado de ventas a fondo para compras', sales: -1, purchases: 1 },
  purchases_to_sales: { label: 'Traslado de fondo para compras a ventas', sales: 1, purchases: -1 },
} as const;

export type CashMovementKind = keyof typeof cashMovements;
