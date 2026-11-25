export const cashDenominations = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50] as const;
export const accountTokenValue = 3000;

export function mixedCreditPlan(remaining: number, input: string) {
  const credit = input === '' ? Math.max(0, remaining) : Number(input);
  const difference = remaining - credit;
  return { credit, difference, valid: Number.isSafeInteger(credit) && credit >= 0 && difference === 0 };
}

export function cashChange(due: number, received: string): number | null {
  return received.trim() === '' ? null : Number(received) - due;
}
