import type { PaymentInput } from './Accounts';

export type AccountPaymentDraft = { requestId: string; payment: PaymentInput; receiptId?: number };

export const accountPaymentKey = (accountId: number, accountCreatedAt: string) => 'caja.abono.v1.' + accountId + ':' + accountCreatedAt;

export function readAccountPayment(key: string): AccountPaymentDraft | null {
  const stored = localStorage.getItem(key);
  return stored === null ? null : JSON.parse(stored) as AccountPaymentDraft;
}

export async function updateAccountPayment(key: string, update: (current: AccountPaymentDraft | null) => AccountPaymentDraft | null) {
  const write = () => {
    const current = readAccountPayment(key);
    const next = update(current);
    if (next === null) localStorage.removeItem(key);
    else if (next !== current) localStorage.setItem(key, JSON.stringify(next));
    return next;
  };
  return navigator.locks ? navigator.locks.request(key, write) : write();
}
