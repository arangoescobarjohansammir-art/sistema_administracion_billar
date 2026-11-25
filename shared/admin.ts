export const adminSnapshotId = 'club-patio-bonito';
export const dashboardRefreshMs = 60_000;
export const clubTimeZone = 'America/Bogota';

export type DailySales = {
  day: string; sales: number; transactions: number;
  cash: number; transfer: number; tokens: number; tokenAmount: number;
};

export type RegisterSummary = {
  id: number; cashier: string; openedAt: string; closedAt: string | null;
  salesTotal: number; salesCount: number; cashReceived: number; transferExpected: number;
  salesExpected: number; purchasesExpected: number; expectedTokens: number | null;
  salesDifference: number | null; purchasesDifference: number | null;
  transferDifference: number | null; tokenDifference: number | null;
  salesDelivery: number | null; nextBase: number | null; closingNote: string;
};

export type AdminSnapshot = {
  version: 1;
  day: string;
  daily: DailySales[];
  active: RegisterSummary | null;
  closures: RegisterSummary[];
  pendingBalance: number;
  openBalances: { id: number; name: string; balance: number }[];
  inventory: { id: number; name: string; brand: string; presentation: string; stock: number }[];
  play: {
    billiard: { table: number; paused: boolean }[];
    tejo: { type: 'maxi' | 'largo'; court: number; rounds: number }[];
  };
};

const dateInColombia = new Intl.DateTimeFormat('en-CA', {
  timeZone: clubTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function clubDay(date: Date) {
  return dateInColombia.format(date);
}
