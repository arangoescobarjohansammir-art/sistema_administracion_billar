export const cashDenominations = [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50] as const;

export function cashChange(due: number, received: string): number | null {
  return received.trim() === '' ? null : Number(received) - due;
}
