import type { DatabaseSync } from 'node:sqlite';

export function activeShiftId(database: DatabaseSync) {
  const shift = database.prepare('SELECT id FROM cash_shifts WHERE closed_at IS NULL').get();
  return shift ? Number(shift.id) : null;
}

export function shiftTokenTotals(database: DatabaseSync, shiftId: number, openingTokens: number | null) {
  const row = database.prepare(`
    SELECT
      (SELECT COALESCE(SUM(tokens), 0) FROM cash_shift_payments
        JOIN valid_account_payments ON valid_account_payments.id = payment_id WHERE shift_id = $shiftId) AS received,
      (SELECT COALESCE(SUM(tokens), 0) FROM cash_shift_redemptions
        JOIN tejo_redemptions ON tejo_redemptions.id = redemption_id
        WHERE shift_id = $shiftId AND redemption_id NOT IN (SELECT redemption_id FROM tejo_redemption_voids)) AS redeemed,
      (SELECT COUNT(*) FROM cash_shift_tokens WHERE shift_id = $shiftId) +
        (SELECT COUNT(*) FROM cash_shift_slot_tokens WHERE shift_id = $shiftId) AS issued
  `).get({ $shiftId: shiftId });
  const tokensReceived = Number(row?.received);
  const tokensRedeemed = Number(row?.redeemed);
  const tokensIssued = Number(row?.issued);
  return {
    tokensReceived, tokensRedeemed, tokensIssued,
    expectedTokens: openingTokens === null ? null : openingTokens + tokensReceived + tokensRedeemed - tokensIssued,
  };
}
