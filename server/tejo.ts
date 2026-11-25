import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { courtLabel, tejoCourtsPerType, tejoProductValue, type TejoType } from '../shared/tejo.js';
import { type createAccounts, creditShares, paymentFields, paymentTotal, saleItems, ValidationError, whole } from './accounts.js';
import { readJson, sendJson } from './http.js';
import { findProduct, recordInventoryMovement } from './inventory.js';
import { flexibleTejo } from './tejo-flex.js';
import { shiftTokenTotals } from './cash-ledger.js';

type Accounts = ReturnType<typeof createAccounts>;
type Payment = NonNullable<ReturnType<typeof paymentFields>>;
type Items = NonNullable<ReturnType<typeof saleItems>>;

function id(value: unknown): value is number {
  return whole(value, 1, Number.MAX_SAFE_INTEGER);
}

function accountId(value: unknown): number | null {
  if (value === null || id(value)) return value;
  throw new ValidationError(400, 'Selecciona una cuenta válida.');
}

function itemsAndPayment(input: Record<string, unknown>) {
  const items = saleItems(input.items);
  const payment = paymentFields(input.payment);
  if (!items || !payment) throw new ValidationError(400, 'Revisa los productos, cantidades y medios de pago.');
  return { items, payment };
}

export function createTejo(database: DatabaseSync, accounts: Accounts) {
  database.exec([
    'CREATE TABLE IF NOT EXISTS tejo_sessions (',
    "  id INTEGER PRIMARY KEY, court_type TEXT NOT NULL CHECK (court_type IN ('maxi', 'largo')),",
    '  court_number INTEGER NOT NULL CHECK (court_number BETWEEN 1 AND 6),',
    '  opened_at TEXT NOT NULL, closed_at TEXT',
    ') STRICT;',
    'CREATE UNIQUE INDEX IF NOT EXISTS tejo_occupied_court ON tejo_sessions(court_type, court_number) WHERE closed_at IS NULL;',
    'CREATE TABLE IF NOT EXISTS tejo_players (',
    '  session_id INTEGER NOT NULL REFERENCES tejo_sessions(id), account_id INTEGER NOT NULL REFERENCES customer_accounts(id),',
    '  PRIMARY KEY (session_id, account_id)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_rounds (',
    '  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES tejo_sessions(id),',
    '  number INTEGER NOT NULL CHECK (number > 0), loser_id INTEGER NOT NULL,',
    '  rate INTEGER NOT NULL CHECK (rate > 0), sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id), created_at TEXT NOT NULL,',
    '  UNIQUE (session_id, number), FOREIGN KEY (session_id, loser_id) REFERENCES tejo_players(session_id, account_id)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_redemptions (',
    '  id INTEGER PRIMARY KEY, round_id INTEGER REFERENCES tejo_rounds(id),',
    '  account_id INTEGER REFERENCES customer_accounts(id), tokens INTEGER NOT NULL CHECK (tokens >= 0),',
    '  allowance INTEGER NOT NULL CHECK (allowance > 0), subtotal INTEGER NOT NULL CHECK (subtotal >= 0),',
    '  extra INTEGER NOT NULL CHECK (extra = MAX(subtotal - allowance, 0)),',
    '  sale_id INTEGER UNIQUE REFERENCES sales(id), created_at TEXT NOT NULL,',
    '  CHECK ((round_id IS NULL AND tokens > 0) OR (round_id IS NOT NULL AND tokens = 0 AND account_id IS NOT NULL))',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_redemption_items (',
    '  id INTEGER PRIMARY KEY, redemption_id INTEGER NOT NULL REFERENCES tejo_redemptions(id),',
    '  product_id INTEGER NOT NULL REFERENCES products(id), label TEXT NOT NULL,',
    '  quantity INTEGER NOT NULL CHECK (quantity > 0), unit_price INTEGER NOT NULL CHECK (unit_price >= 0),',
    '  movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_movements(id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS tejo_items_by_redemption ON tejo_redemption_items(redemption_id, id);',
    'CREATE TABLE IF NOT EXISTS tejo_benefits (',
    '  round_id INTEGER NOT NULL REFERENCES tejo_rounds(id), account_id INTEGER NOT NULL REFERENCES customer_accounts(id),',
    '  issued_at TEXT, redemption_id INTEGER UNIQUE REFERENCES tejo_redemptions(id),',
    '  PRIMARY KEY (round_id, account_id), CHECK (issued_at IS NULL OR redemption_id IS NULL)',
    ') STRICT;',
  ].join('\n'));
  function availableTokens() {
    const shift = database.prepare('SELECT id, opening_tokens AS openingTokens FROM cash_shifts WHERE closed_at IS NULL').get();
    if (!shift || shift.openingTokens === null) return null;
    return Math.max(0, shiftTokenTotals(database, Number(shift.id), Number(shift.openingTokens)).expectedTokens ?? 0);
  }

  const flexible = flexibleTejo(database, accounts, availableTokens);

  const selectSession = 'SELECT id, court_type AS courtType, court_number AS courtNumber, opened_at AS openedAt, closed_at AS closedAt FROM tejo_sessions';

  function openSession(sessionId: number) {
    const session = database.prepare(selectSession + ' WHERE id = ? AND closed_at IS NULL').get(sessionId);
    if (!session) throw new ValidationError(409, 'Este grupo ya no está jugando en la cancha.');
    return session;
  }

  function players(sessionId: number) {
    return database.prepare([
      'SELECT customer_accounts.id, name FROM tejo_players',
      'JOIN customer_accounts ON customer_accounts.id = tejo_players.account_id',
      'WHERE session_id = ? ORDER BY customer_accounts.id',
    ].join(' ')).all(sessionId);
  }

  function start(input: Record<string, unknown>) {
    const { courtType, courtNumber, players: members } = input;
    if ((courtType !== 'maxi' && courtType !== 'largo') || !whole(courtNumber, 1, tejoCourtsPerType)) {
      throw new ValidationError(400, 'Selecciona una cancha de maxitejo o tejo largo.');
    }
    if (!Array.isArray(members) || members.length < 2 || members.length > 20 ||
      !members.every(id) || new Set(members).size !== members.length) {
      throw new ValidationError(400, 'Selecciona de 2 a 20 participantes distintos.');
    }
    if (database.prepare('SELECT id FROM tejo_sessions WHERE court_type = ? AND court_number = ? AND closed_at IS NULL')
      .get(courtType, courtNumber)) throw new ValidationError(409, 'La cancha ya tiene un grupo jugando.');
    for (const member of members) accounts.accountById(member);
    const sessionId = Number(database.prepare('INSERT INTO tejo_sessions (court_type, court_number, opened_at) VALUES (?, ?, ?)')
      .run(courtType, courtNumber, new Date().toISOString()).lastInsertRowid);
    const add = database.prepare('INSERT INTO tejo_players (session_id, account_id) VALUES (?, ?)');
    for (const member of members) add.run(sessionId, member);
    return sessionId;
  }

  function addRound(sessionId: number, input: Record<string, unknown>) {
    const session = openSession(sessionId);
    if (flexible.hasSlots(sessionId)) throw new ValidationError(409, 'Actualiza la página para registrar el chico y asignar el resultado.');
    const members = players(sessionId);
    const { loserId, issueAll } = input;
    const payment = paymentFields(input.payment);
    if (!id(loserId) || !members.some((member) => member.id === loserId) || typeof issueAll !== 'boolean' || !payment) {
      throw new ValidationError(400, 'Selecciona quién perdió e indica cómo se registra el chico.');
    }
    const total = members.length * tejoProductValue;
    const paid = paymentTotal(payment);
    if (paid > total) throw new ValidationError(400, 'El pago supera el valor del chico.');
    const number = Number(database.prepare('SELECT COALESCE(MAX(number), 0) + 1 AS next FROM tejo_rounds WHERE session_id = ?')
      .get(sessionId)?.next);
    const createdAt = new Date().toISOString();
    const saleId = accounts.insertSale(loserId, total, createdAt);
    const heading = courtLabel(session.courtType as TejoType, Number(session.courtNumber));
    accounts.insertAllocatedLine(saleId, heading + ' · chico ' + number + ' · grupo #' + sessionId, total);
    if (paid > 0) accounts.insertPayment(loserId, saleId, payment, createdAt);
    const roundId = Number(database.prepare([
      'INSERT INTO tejo_rounds (session_id, number, loser_id, rate, sale_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ].join(' ')).run(sessionId, number, loserId, tejoProductValue, saleId, createdAt).lastInsertRowid);
    const benefit = database.prepare('INSERT INTO tejo_benefits (round_id, account_id, issued_at) VALUES (?, ?, ?)');
    const issuedAt = issueAll && (availableTokens() ?? 0) >= members.length ? createdAt : null;
    for (const member of members) benefit.run(roundId, Number(member.id), issuedAt);
    return roundId;
  }

  function redeem(owner: number | null, round: number | null, tokens: number, allowance: number, items: Items, payment: Payment,
    split?: unknown) {
    accounts.requireShift();
    if (owner !== null) accounts.accountById(owner);
    const products = items.map((item) => {
      const product = findProduct(database, item.productId);
      if (!product?.active) throw new ValidationError(409, 'Uno de los productos ya no está disponible.');
      const name = [product.name, product.brand, product.presentation].filter(Boolean).join(' · ');
      if (Number(product.stock) < item.quantity) throw new ValidationError(409, 'Existencias insuficientes para ' + name + '.');
      if (product.price !== item.unitPrice) throw new ValidationError(409, 'Cambió el precio de ' + name + '. Recarga los productos antes de confirmar.');
      return { ...item, name };
    });
    const subtotal = products.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    if (subtotal > 1_000_000_000) throw new ValidationError(400, 'El valor de los productos es demasiado alto.');
    const extra = Math.max(0, subtotal - allowance);
    const paid = paymentTotal(payment);
    if (paid > extra) throw new ValidationError(400, 'El pago supera el excedente del canje. La diferencia de la ficha no se devuelve.');
    const shares = creditShares(split, owner, extra - paid);
    if (owner === null && !shares.length && paid !== extra) {
      throw new ValidationError(400, 'Cobra todo el excedente o selecciona una cuenta para anotarlo.');
    }
    const createdAt = new Date().toISOString();
    const saleTotal = shares.length ? paid : extra;
    const saleId = extra ? accounts.insertSale(owner, saleTotal, createdAt) : null;
    if (saleId !== null) {
      const description = 'Excedente de canje · ' + products.map((item) => item.quantity + ' × ' + item.name).join(', ');
      if (saleTotal) accounts.insertAllocatedLine(saleId, description, saleTotal);
      if (paid > 0) accounts.insertPayment(owner, saleId, payment, createdAt);
      if (shares.length) accounts.recordCreditShares(saleId, shares, description, createdAt);
    }
    const redemptionId = Number(database.prepare([
      'INSERT INTO tejo_redemptions (round_id, account_id, tokens, allowance, subtotal, extra, sale_id, created_at)',
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ].join(' ')).run(round, owner, tokens, allowance, subtotal, extra, saleId, createdAt).lastInsertRowid);
    for (const item of products) {
      const movementId = recordInventoryMovement(database, {
        productId: item.productId, units: -item.quantity, quantity: item.quantity,
        inputUnit: 'unidad', unitsPerInput: 1, reason: 'Tejo · canje #' + redemptionId, createdAt,
      });
      database.prepare([
        'INSERT INTO tejo_redemption_items (redemption_id, product_id, label, quantity, unit_price, movement_id)',
        'VALUES (?, ?, ?, ?, ?, ?)',
      ].join(' ')).run(redemptionId, item.productId, item.name, item.quantity, item.unitPrice, movementId);
    }
    return redemptionId;
  }

  function fulfill(sessionId: number, input: Record<string, unknown>) {
    openSession(sessionId);
    const { roundId, playerId, choice } = input;
    if (!id(roundId) || !id(playerId) || (choice !== 'token' && choice !== 'products')) {
      throw new ValidationError(400, 'Elige al participante y cómo usa su derecho.');
    }
    const benefit = database.prepare([
      'SELECT issued_at AS issuedAt, redemption_id AS redemptionId, rate FROM tejo_benefits',
      'JOIN tejo_rounds ON tejo_rounds.id = tejo_benefits.round_id',
      'WHERE session_id = ? AND round_id = ? AND account_id = ?',
    ].join(' ')).get(sessionId, roundId, playerId);
    if (!benefit) throw new ValidationError(404, 'No se encontró ese derecho para el participante.');
    if (benefit.issuedAt !== null || benefit.redemptionId !== null) throw new ValidationError(409, 'El participante ya usó su derecho en ese chico.');
    if (choice === 'token') {
      accounts.requireShift();
      if (!availableTokens()) throw new ValidationError(409, 'No hay fichas disponibles en caja. La entrega sigue pendiente.');
      database.prepare('UPDATE tejo_benefits SET issued_at = ? WHERE round_id = ? AND account_id = ?')
        .run(new Date().toISOString(), roundId, playerId);
      return roundId;
    }
    const { items, payment } = itemsAndPayment(input);
    const redemptionId = redeem(playerId, roundId, 0, Number(benefit.rate), items, payment);
    database.prepare('UPDATE tejo_benefits SET redemption_id = ? WHERE round_id = ? AND account_id = ?')
      .run(redemptionId, roundId, playerId);
    return redemptionId;
  }

  function ensureLegacyFulfilled(sessionId: number) {
    if (database.prepare([
      'SELECT 1 FROM tejo_benefits JOIN tejo_rounds ON tejo_rounds.id = tejo_benefits.round_id',
      'WHERE session_id = ? AND issued_at IS NULL AND redemption_id IS NULL LIMIT 1',
    ].join(' ')).get(sessionId)) throw new ValidationError(409, 'Registra las fichas o los consumos pendientes antes de liberar la cancha.');
  }

  function close(sessionId: number) {
    openSession(sessionId);
    ensureLegacyFulfilled(sessionId);
    if (flexible.hasSlots(sessionId)) return flexible.close(sessionId);
    database.prepare('UPDATE tejo_sessions SET closed_at = ? WHERE id = ?').run(new Date().toISOString(), sessionId);
    return sessionId;
  }

  const redemptionSelect = [
    'SELECT tejo_redemptions.id, tokens, allowance, subtotal, extra, tejo_redemptions.created_at AS createdAt,',
    'customer_accounts.name, sale_id AS saleId FROM tejo_redemptions',
    'LEFT JOIN customer_accounts ON customer_accounts.id = tejo_redemptions.account_id',
  ].join(' ');

  function withItems(redemption: Record<string, unknown>) {
    const items = database.prepare('SELECT label, quantity, unit_price AS unitPrice FROM tejo_redemption_items WHERE redemption_id = ? ORDER BY id')
      .all(Number(redemption.id));
    return { ...redemption, items };
  }

  function physicalRedemptions() {
    return database.prepare(redemptionSelect + ' WHERE round_id IS NULL ORDER BY tejo_redemptions.id DESC LIMIT 20').all()
      .map((redemption) => ({ ...withItems(redemption),
        creditShares: redemption.saleId === null ? [] : accounts.readCreditShares(Number(redemption.saleId)),
      }));
  }

  function overview() {
    const active = database.prepare(selectSession + ' WHERE closed_at IS NULL ORDER BY court_type, court_number').all();
    const roundList = database.prepare([
      'SELECT tejo_rounds.id, number, loser_id AS loserId, customer_accounts.name AS loser, sales.total,',
      'tejo_rounds.sale_id AS saleId, tejo_rounds.created_at AS createdAt, rate',
      'FROM tejo_rounds JOIN customer_accounts ON customer_accounts.id = loser_id JOIN sales ON sales.id = tejo_rounds.sale_id',
      'WHERE session_id = ? ORDER BY number DESC',
    ].join(' '));
    const benefits = database.prepare([
      'SELECT account_id AS accountId, name, issued_at AS issuedAt, redemption_id AS redemptionId',
      'FROM tejo_benefits JOIN customer_accounts ON customer_accounts.id = account_id',
      'WHERE round_id = ? ORDER BY account_id',
    ].join(' '));
    const byRedemption = database.prepare(redemptionSelect + ' WHERE tejo_redemptions.id = ?');
    const recent = database.prepare(selectSession + ' WHERE closed_at IS NOT NULL ORDER BY closed_at DESC, id DESC LIMIT 12').all();
    function describe(session: Record<string, unknown>) {
      const next = flexible.describe(Number(session.id));
      const legacy = roundList.all(Number(session.id)).map((round) => ({
          ...round,
          number: Number(round.number),
          loserId: next ? next.players.find((player) => player.accountId === round.loserId)?.id ?? null : round.loserId,
          benefits: benefits.all(Number(round.id)).map((benefit) => {
            const redemption = benefit.redemptionId === null ? null : byRedemption.get(Number(benefit.redemptionId));
            return { ...benefit, redemption: redemption ? withItems(redemption) : null };
          }),
      }));
      return next ? { ...session, ...next, rounds: [...legacy, ...next.rounds]
        .sort((a, b) => Number(b.number) - Number(a.number)) }
        : { ...session, players: players(Number(session.id)), rounds: legacy };
    }
    return {
      availableTokens: availableTokens(),
      active: active.map(describe),
      recent: recent.map(describe),
      physicalRedemptions: physicalRedemptions(),
      tokenCounts: {
        issued: Number(database.prepare([
          'SELECT (SELECT COUNT(*) FROM tejo_benefits WHERE issued_at IS NOT NULL) +',
          '(SELECT COUNT(*) FROM tejo_slot_benefits WHERE issued_at IS NOT NULL) AS total',
        ].join(' ')).get()?.total),
        redeemed: Number(database.prepare('SELECT COALESCE(SUM(tokens), 0) AS total FROM tejo_redemptions WHERE round_id IS NULL').get()?.total),
        receivedAsPayment: Number(database.prepare('SELECT COALESCE(SUM(tokens), 0) AS total FROM account_payments').get()?.total),
      },
    };
  }

  return async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      if (path === '/api/tejo' && request.method === 'GET') return sendJson(response, 200, overview());
      if (path === '/api/tejo/redemptions' && request.method === 'GET') return sendJson(response, 200, physicalRedemptions());
      if (request.method !== 'POST') throw new ValidationError(405, 'Método no permitido.');
      const input = await readJson(request, 24_000);
      if (!input) throw new ValidationError(400, 'No se recibió una operación válida.');
      const { requestId, ...fields } = input;
      let action: () => number;
      if (path === '/api/tejo') action = () => fields.playerCount === undefined && fields.teamSize === undefined
        ? start(fields) : flexible.start(fields);
      else if (path === '/api/tejo/redemptions') {
        const { items, payment } = itemsAndPayment(fields);
        const owner = accountId(fields.accountId);
        const { tokens } = fields;
        if (!whole(tokens, 1, 1000)) throw new ValidationError(400, 'Indica cuántas fichas físicas recibiste.');
        action = () => redeem(owner, null, tokens, tokens * tejoProductValue, items, payment, fields.creditShares);
      } else {
        const match = /^\/api\/tejo\/([1-9]\d*)\/(rounds|benefits|close|record|assign|guest|flex-benefits|stake-delivery)$/.exec(path);
        if (!match || !id(Number(match[1]))) throw new ValidationError(404, 'Ruta de tejo no encontrada.');
        const sessionId = Number(match[1]);
        switch (match[2]) {
          case 'rounds': action = () => addRound(sessionId, fields); break;
          case 'benefits': action = () => fulfill(sessionId, fields); break;
          case 'record': action = () => flexible.play(sessionId, fields); break;
          case 'assign': action = () => flexible.assign(sessionId, fields); break;
          case 'guest': action = () => flexible.addPlayer(sessionId); break;
          case 'flex-benefits': action = () => flexible.fulfill(sessionId, fields); break;
          case 'stake-delivery': action = () => flexible.deliverStake(sessionId, fields); break;
          default: action = () => close(sessionId);
        }
      }
      const result = accounts.writeOnce(requestId, JSON.stringify([path, fields]), action);
      return sendJson(response, result.repeated ? 200 : 201, result);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  };
}
