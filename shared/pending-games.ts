import type { TejoType } from './tejo.js';

export type PendingGames = {
  capturedAt: string;
  billiards: { sessionId: number; table: number; products: number; time: number; running: boolean }[];
  tejo: { roundId: number; courtType: TejoType; court: number; round: number; amount: number }[];
};

export function pendingGamesTotal(games: PendingGames) {
  return games.billiards.reduce((sum, item) => sum + item.products + item.time, 0) +
    games.tejo.reduce((sum, item) => sum + item.amount, 0);
}
