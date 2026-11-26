import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { elapsedSeconds, timeCharge } from '../shared/billiard.js';
import type { PendingGames } from '../shared/pending-games.js';

export function createPendingGames(database: DatabaseSync) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS cash_close_pending_games (
      shift_id INTEGER PRIMARY KEY REFERENCES cash_shifts(id),
      snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
    ) STRICT;
  `);
  const tables = database.prepare(`
    SELECT s.id, s.table_number, s.rate, s.started_at, s.stopped_at, s.paused_ms,
      COALESCE(SUM(i.quantity * i.unit_price), 0) AS products, COALESCE(MAX(i.id), 0) AS last_item
    FROM billiard_sessions s LEFT JOIN billiard_items i ON i.session_id = s.id
    WHERE s.closed_at IS NULL GROUP BY s.id ORDER BY s.table_number
  `);
  const rounds = database.prepare(`
    SELECT p.id, p.number, s.court_type, s.court_number,
      p.rate * p.player_count + COALESCE(SUM(i.quantity * i.units_per_input * i.unit_price), 0) AS amount
    FROM tejo_played p JOIN tejo_sessions s ON s.id = p.session_id
    LEFT JOIN tejo_round_products i ON i.round_id = p.id
    WHERE s.closed_at IS NULL AND p.loser_slot IS NULL AND p.sale_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM tejo_team_results r WHERE r.round_id = p.id)
    GROUP BY p.id ORDER BY s.court_type, s.court_number, p.number
  `);
  const stored = database.prepare('SELECT snapshot FROM cash_close_pending_games WHERE shift_id = ?');
  const insert = database.prepare('INSERT INTO cash_close_pending_games (shift_id, snapshot) VALUES (?, ?)');

  function live(now = Date.now()) {
    const openTables = tables.all();
    const unassigned = rounds.all();
    const games: PendingGames = {
      capturedAt: new Date(now).toISOString(),
      billiards: openTables.map((row) => ({
        sessionId: Number(row.id), table: Number(row.table_number), products: Number(row.products),
        running: row.stopped_at === null,
        time: timeCharge(elapsedSeconds(Number(row.started_at), Number(row.stopped_at ?? now), Number(row.paused_ms)), Number(row.rate)),
      })),
      tejo: unassigned.map((row) => ({
        roundId: Number(row.id), courtType: row.court_type === 'maxi' ? 'maxi' : 'largo',
        court: Number(row.court_number), round: Number(row.number), amount: Number(row.amount),
      })),
    };
    // El reloj puede seguir corriendo entre la revisión y el cierre. El importe se fija al guardar.
    const revision = createHash('sha256').update(JSON.stringify([openTables, unassigned])).digest('hex');
    return { games, revision };
  }

  function read(shiftId: number): PendingGames | null {
    const row = stored.get(shiftId);
    return row ? JSON.parse(String(row.snapshot)) as PendingGames : null;
  }

  function save(shiftId: number, games: PendingGames) {
    insert.run(shiftId, JSON.stringify(games));
  }

  return { live, read, save };
}
