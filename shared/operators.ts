export type Operator = { id: number; name: string; username: string; role: 'admin' | 'cashier'; active: boolean };

export const auditLabels = {
  sale: 'Venta de productos',
  sale_void: 'Anulación de venta',
  account_payment: 'Abono de cliente',
  account_payment_void: 'Anulación de abono',
  tejo_charge_move: 'Cambio de cuenta de un chico',
  cash_movement: 'Movimiento de caja',
  inventory_movement: 'Ajuste de inventario',
  inventory_count: 'Conteo físico',
  inventory_count_adjustment: 'Ajuste por conteo físico',
} as const;
export type AuditKind = keyof typeof auditLabels;
export type AuditEntry = {
  id: number; actorName: string; shiftId: number | null; kind: AuditKind;
  targetId: number; reason: string; createdAt: string;
};
