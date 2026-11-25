export type AccountMovement = {
  id: number;
  kind: 'sale' | 'payment' | 'void';
  sourceId: number;
  createdAt: string;
  amount: number;
  balanceAfter: number;
  reason?: string;
};

export type AccountCycle = {
  id: number;
  openedAt: string;
  closedAt: string | null;
  movements: AccountMovement[];
};

export type AccountHistory = { current: AccountCycle | null; closed: AccountCycle[] };
