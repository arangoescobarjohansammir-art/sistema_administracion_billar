export type Operator = { id: number; name: string; username: string; role: 'admin' | 'cashier'; active: boolean };

export const auditLabels = {
  sale: 'Venta de productos',
  sale_void: 'Anulación de venta',
  account_payment: 'Abono de cliente',
  cash_movement: 'Movimiento de caja',
  inventory_movement: 'Ajuste de inventario',
} as const;
export type AuditKind = keyof typeof auditLabels;
export type AuditEntry = {
  id: number; actorName: string; shiftId: number | null; kind: AuditKind;
  targetId: number; reason: string; createdAt: string;
};
