import type { DatabaseSync } from 'node:sqlite';
import { courtLabel, tejoCourtsPerType, tejoPlayerTeam, tejoProductValue, tejoShare, type TejoTeam, type TejoType } from '../shared/tejo.js';
import { type createAccounts, paymentFields, paymentTotal, record, saleItems, ValidationError, whole } from './accounts.js';
import { findProduct, recordInventoryMovement } from './inventory.js';

type Accounts = ReturnType<typeof createAccounts>;
const isId = (value: unknown): value is number => whole(value, 1, Number.MAX_SAFE_INTEGER);

export function flexibleTejo(database: DatabaseSync, accounts: Accounts, availableTokens: () => number | null) {
  database.exec([
    'CREATE TABLE IF NOT EXISTS tejo_slots (',
    '  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES tejo_sessions(id),',
    '  number INTEGER NOT NULL, account_id INTEGER REFERENCES customer_accounts(id),',
    '  UNIQUE(session_id, number), UNIQUE(session_id, account_id)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_played (',
    '  id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES tejo_sessions(id), number INTEGER NOT NULL,',
    '  rate INTEGER NOT NULL, player_count INTEGER NOT NULL, created_at TEXT NOT NULL,',
    '  loser_slot INTEGER REFERENCES tejo_slots(id), sale_id INTEGER UNIQUE REFERENCES sales(id),',
    '  UNIQUE(session_id, number), CHECK ((loser_slot IS NULL) = (sale_id IS NULL))',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_slot_benefits (',
    '  id INTEGER PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES tejo_played(id), slot_id INTEGER NOT NULL REFERENCES tejo_slots(id),',
    '  issued_at TEXT, redeemed_at TEXT, redemption_total INTEGER, extra INTEGER,',
    '  UNIQUE(round_id, slot_id), CHECK (issued_at IS NULL OR redeemed_at IS NULL)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_slot_consumptions (',
    '  id INTEGER PRIMARY KEY, benefit_id INTEGER NOT NULL REFERENCES tejo_slot_benefits(id),',
    '  label TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL,',
    '  movement_id INTEGER NOT NULL UNIQUE REFERENCES inventory_movements(id)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS consumptions_by_benefit ON tejo_slot_consumptions(benefit_id, id);',
    'CREATE TABLE IF NOT EXISTS tejo_team_groups (',
    '  session_id INTEGER PRIMARY KEY REFERENCES tejo_sessions(id),',
    '  team_size INTEGER NOT NULL CHECK (team_size BETWEEN 2 AND 4)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_team_results (',
    '  round_id INTEGER PRIMARY KEY REFERENCES tejo_played(id),',
    "  losing_team TEXT NOT NULL CHECK (losing_team IN ('A', 'B'))",
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_team_charges (',
    '  round_id INTEGER NOT NULL REFERENCES tejo_team_results(round_id),',
    '  slot_id INTEGER NOT NULL REFERENCES tejo_slots(id), sale_id INTEGER NOT NULL UNIQUE REFERENCES sales(id),',
    '  PRIMARY KEY (round_id, slot_id)',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS tejo_round_products (',
    '  round_id INTEGER NOT NULL REFERENCES tejo_played(id), product_id INTEGER NOT NULL REFERENCES products(id),',
    '  label TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0),',
    '  units_per_input INTEGER NOT NULL CHECK (units_per_input > 0), input_unit TEXT NOT NULL,',
    '  unit_price INTEGER NOT NULL CHECK (unit_price >= 0), movement_id INTEGER UNIQUE REFERENCES inventory_movements(id),',
    '  PRIMARY KEY (round_id, product_id)',
    ') STRICT;',
  ].join('\n'));

  const openLegacy = database.prepare([
    'SELECT id FROM tejo_sessions WHERE closed_at IS NULL',
    'AND EXISTS (SELECT 1 FROM tejo_players WHERE session_id = tejo_sessions.id)',
    'AND NOT EXISTS (SELECT 1 FROM tejo_slots WHERE session_id = tejo_sessions.id)',
  ].join(' ')).all();
  if (openLegacy.length) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const copy = database.prepare([
        'INSERT INTO tejo_slots (session_id, number, account_id)',
        'SELECT session_id, ROW_NUMBER() OVER (ORDER BY account_id), account_id FROM tejo_players WHERE session_id = ?',
      ].join(' '));
      for (const session of openLegacy) copy.run(Number(session.id));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  function open(sessionId: number) {
    const session = database.prepare([
      'SELECT id, court_type AS courtType, court_number AS courtNumber FROM tejo_sessions',
      'WHERE id = ? AND closed_at IS NULL AND EXISTS(SELECT 1 FROM tejo_slots WHERE session_id = tejo_sessions.id)',
    ].join(' ')).get(sessionId);
    if (!session) throw new ValidationError(409, 'Este grupo ya no está abierto.');
    return session;
  }

  function roster(sessionId: number) {
    return database.prepare([
      "SELECT tejo_slots.id, number, account_id AS accountId, COALESCE(name, 'Jugador ' || number) AS name",
      'FROM tejo_slots LEFT JOIN customer_accounts ON customer_accounts.id = account_id',
      'WHERE session_id = ? ORDER BY number',
    ].join(' ')).all(sessionId);
  }

  function teamSizeFor(sessionId: number) {
    return Number(database.prepare('SELECT team_size FROM tejo_team_groups WHERE session_id = ?').get(sessionId)?.team_size ?? 0);
  }

  function start(fields: Record<string, unknown>) {
    const { courtType, courtNumber, playerCount, teamSize } = fields;
    if ((courtType !== 'maxi' && courtType !== 'largo') || !whole(courtNumber, 1, tejoCourtsPerType) ||
      !whole(playerCount, 2, 20)) throw new ValidationError(400, 'Elige una cancha y registra entre 2 y 20 jugadores.');
    if (teamSize !== undefined && (!whole(teamSize, 2, 4) || playerCount !== teamSize * 2)) {
      throw new ValidationError(400, 'Elige dos equipos del mismo tamaño, de 2 a 4 jugadores por equipo.');
    }
    if (database.prepare('SELECT id FROM tejo_sessions WHERE court_type = ? AND court_number = ? AND closed_at IS NULL')
      .get(courtType, courtNumber)) throw new ValidationError(409, 'La cancha ya tiene un grupo jugando.');
    const session = Number(database.prepare('INSERT INTO tejo_sessions (court_type, court_number, opened_at) VALUES (?, ?, ?)')
      .run(courtType, courtNumber, new Date().toISOString()).lastInsertRowid);
    if (typeof teamSize === 'number') {
      database.prepare('INSERT INTO tejo_team_groups (session_id, team_size) VALUES (?, ?)').run(session, teamSize);
    }
    const add = database.prepare('INSERT INTO tejo_slots (session_id, number) VALUES (?, ?)');
    for (let number = 1; number <= playerCount; number++) add.run(session, number);
    return session;
  }

  function addPlayer(session: number) {
    open(session);
    if (teamSizeFor(session)) throw new ValidationError(409, 'Los equipos conservan su tamaño hasta cerrar el grupo.');
    const number = roster(session).length + 1;
    if (number > 20) throw new ValidationError(400, 'El grupo admite hasta 20 jugadores.');
    return Number(database.prepare('INSERT INTO tejo_slots (session_id, number) VALUES (?, ?)').run(session, number).lastInsertRowid);
  }

  function stakeProducts(value: unknown) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 50) throw new ValidationError(400, 'Revisa los productos de la apuesta.');
    const seen = new Set<number>();
    return value.map((entry) => {
      const { productId, quantity, unit, unitPrice, unitsPerInput } = record(entry) ?? {};
      if (!isId(productId) || seen.has(productId) || !whole(quantity, 1, 1_000_000) || (unit !== 'unit' && unit !== 'package')) {
        throw new ValidationError(400, 'Elige cada producto una vez e indica su cantidad.');
      }
      seen.add(productId);
      const product = findProduct(database, productId);
      const multiplier = unit === 'package' ? Number(product?.unitsPerPackage) : 1;
      if (!product?.active || (unit === 'package' && !product.packageName) || multiplier !== unitsPerInput || product.price !== unitPrice) {
        throw new ValidationError(409, 'Cambió el precio, el empaque o la disponibilidad. Actualiza los productos de la apuesta.');
      }
      if (quantity * multiplier > Number(product.stock)) throw new ValidationError(409, 'No hay existencias suficientes para ' + product.name + '.');
      return {
        productId, quantity, unitsPerInput: multiplier, unitPrice: Number(product.price),
        inputUnit: unit === 'package' ? String(product.packageName) : 'unidad',
        label: [product.name, product.brand, product.presentation].filter(Boolean).join(' · '),
      };
    });
  }

  function play(session: number, fields: Record<string, unknown>) {
    open(session);
    accounts.requireShift();
    if (typeof fields.issueAll !== 'boolean') throw new ValidationError(400, 'Indica si las fichas se entregaron.');
    const withTokens = fields.withTokens === undefined ? true : fields.withTokens;
    if (typeof withTokens !== 'boolean' || (!withTokens && fields.issueAll)) {
      throw new ValidationError(400, 'Indica si el chico incluye fichas.');
    }
    const players = roster(session);
    const items = stakeProducts(fields.products);
    const rate = withTokens ? tejoProductValue : 0;
    const total = items.reduce((sum, item) => sum + item.quantity * item.unitsPerInput * item.unitPrice, players.length * rate);
    if (total < Math.max(1, teamSizeFor(session)) || total > 1_000_000_000) {
      throw new ValidationError(400, 'La apuesta debe tener un valor suficiente para cada perdedor y estar dentro del límite.');
    }
    const now = new Date().toISOString();
    const round = Number(database.prepare([
      'INSERT INTO tejo_played (session_id, number, rate, player_count, created_at)',
      'VALUES (?, MAX(COALESCE((SELECT MAX(number) FROM tejo_played WHERE session_id = ?), 0),',
      'COALESCE((SELECT MAX(number) FROM tejo_rounds WHERE session_id = ?), 0)) + 1, ?, ?, ?)',
    ].join(' ')).run(session, session, session, rate, players.length, now).lastInsertRowid);
    const insertItem = database.prepare([
      'INSERT INTO tejo_round_products (round_id, product_id, label, quantity, units_per_input, input_unit, unit_price)',
      'VALUES (?, ?, ?, ?, ?, ?, ?)',
    ].join(' '));
    for (const item of items) insertItem.run(round, item.productId, item.label, item.quantity, item.unitsPerInput, item.inputUnit, item.unitPrice);
    if (withTokens) {
      const benefit = database.prepare('INSERT INTO tejo_slot_benefits (round_id, slot_id, issued_at) VALUES (?, ?, ?)');
      const issuedAt = fields.issueAll && (availableTokens() ?? 0) >= players.length ? now : null;
      for (const player of players) benefit.run(round, Number(player.id), issuedAt);
    }
    return round;
  }

  const productsByRound = database.prepare([
    'SELECT product_id AS productId, label, quantity, units_per_input AS unitsPerInput, input_unit AS inputUnit,',
    'unit_price AS unitPrice, movement_id AS movementId FROM tejo_round_products WHERE round_id = ? ORDER BY rowid',
  ].join(' '));
  function stakeDescription(roundId: number | null) {
    if (roundId === null) return '';
    const parts = productsByRound.all(roundId).map(({ quantity, inputUnit, label }) => quantity + ' ' + inputUnit + ' de ' + label);
    return ' · apuesta: ' + parts.join(', ');
  }

  function deliverStake(session: number, fields: Record<string, unknown>) {
    open(session);
    accounts.requireShift();
    const { roundId } = fields;
    if (!isId(roundId)) throw new ValidationError(400, 'Selecciona un chico.');
    const round = database.prepare('SELECT number FROM tejo_played WHERE id = ? AND session_id = ?').get(roundId, session);
    if (!round) throw new ValidationError(404, 'No se encontró ese chico en la cancha.');
    const products = productsByRound.all(roundId);
    if (!products.length || products.some(({ movementId }) => movementId !== null)) {
      throw new ValidationError(409, 'Este chico no tiene productos pendientes de entregar.');
    }
    const now = new Date().toISOString();
    const delivered = database.prepare('UPDATE tejo_round_products SET movement_id = ? WHERE round_id = ? AND product_id = ?');
    for (const item of products) {
      const productId = Number(item.productId);
      const units = Number(item.quantity) * Number(item.unitsPerInput);
      if (Number(findProduct(database, productId)?.stock) < units) {
        throw new ValidationError(409, 'No hay existencias suficientes para entregar ' + item.label + '.');
      }
      const movementId = recordInventoryMovement(database, {
        productId, units: -units, quantity: Number(item.quantity), unitsPerInput: Number(item.unitsPerInput),
        inputUnit: String(item.inputUnit), reason: 'Tejo · apuesta · chico ' + round.number + ' · grupo #' + session, createdAt: now,
      });
      delivered.run(movementId, roundId, productId);
    }
    return roundId;
  }

  function assignOwner(sessionId: number, player: ReturnType<typeof roster>[number], name: unknown, accountId: unknown) {
    if (player.accountId !== null) return Number(player.accountId);
    const owner = Number((isId(accountId) ? accounts.accountById(accountId) : accounts.accountForName(name, true)).id);
    if (database.prepare('SELECT id FROM tejo_slots WHERE session_id = ? AND account_id = ? AND id <> ?')
      .get(sessionId, owner, Number(player.id))) {
      throw new ValidationError(409, 'El nombre ya corresponde a otro jugador de esta cancha.');
    }
    database.prepare('UPDATE tejo_slots SET account_id = ? WHERE id = ?').run(owner, Number(player.id));
    return owner;
  }

  const pendingRounds = [
    'FROM tejo_played played LEFT JOIN tejo_team_results result ON result.round_id = played.id',
    'WHERE played.session_id = ? AND played.loser_slot IS NULL AND result.round_id IS NULL',
  ].join(' ');
  const hasProducts = 'EXISTS (SELECT 1 FROM tejo_round_products WHERE round_id = played.id)';
  const assignmentScope = ' AND ((? IS NULL AND NOT ' + hasProducts + ') OR (played.id = ? AND ' + hasProducts + '))';
  const roundTotal = 'played.rate * played.player_count + COALESCE((' +
    'SELECT SUM(quantity * units_per_input * unit_price) FROM tejo_round_products WHERE round_id = played.id), 0)';

  function assignTeams(sessionId: number, teamSize: number, heading: string, fields: Record<string, unknown>, roundId: number | null) {
    if (!Array.isArray(fields.losses) || !fields.losses.length || fields.losses.length > 2) {
      throw new ValidationError(400, 'Indica cuántos chicos perdió al menos un equipo.');
    }
    const players = roster(sessionId);
    const rounds = database.prepare('SELECT played.id, played.number, ' + roundTotal + ' AS total ' +
      pendingRounds + assignmentScope + ' ORDER BY played.number').all(sessionId, roundId, roundId);
    const seen = new Set<TejoTeam>();
    const losses = fields.losses.map((value) => {
      const { team, count, players: names } = record(value) ?? {};
      if ((team !== 'A' && team !== 'B') || seen.has(team) || !whole(count, 1, rounds.length) || !Array.isArray(names)) {
        throw new ValidationError(400, 'Revisa los chicos perdidos y los jugadores de cada equipo.');
      }
      seen.add(team);
      const members = players.filter(({ number }) => tejoPlayerTeam(Number(number), teamSize) === team);
      const namesByPlayer = new Map<number, { name: unknown; accountId: unknown }>();
      for (const entry of names) {
        const { playerId, name, accountId } = record(entry) ?? {};
        if (!isId(playerId) || namesByPlayer.has(playerId) || !members.some(({ id }) => id === playerId)) {
          throw new ValidationError(400, 'Elige solo jugadores del equipo que perdió.');
        }
        namesByPlayer.set(playerId, { name, accountId });
      }
      return { team, count, members, namesByPlayer };
    }).sort((first, second) => first.team.localeCompare(second.team));
    if (losses.reduce((sum, { count }) => sum + count, 0) > rounds.length) {
      throw new ValidationError(400, 'La suma de chicos perdidos supera los chicos pendientes.');
    }

    accounts.requireShift();
    const result = database.prepare('INSERT INTO tejo_team_results (round_id, losing_team) VALUES (?, ?)');
    const charge = database.prepare('INSERT INTO tejo_team_charges (round_id, slot_id, sale_id) VALUES (?, ?, ?)');
    const now = new Date().toISOString();
    const description = stakeDescription(roundId);
    let offset = 0;
    for (const { team, count, members, namesByPlayer } of losses) {
      const owners = members.map((player) => {
        const info = namesByPlayer.get(Number(player.id));
        return { slotId: Number(player.id), owner: assignOwner(sessionId, player, info?.name, info?.accountId) };
      });
      for (const round of rounds.slice(offset, offset + count)) {
        const id = Number(round.id);
        const total = Number(round.total);
        result.run(id, team);
        for (const [index, { slotId, owner }] of owners.entries()) {
          const amount = tejoShare(total, teamSize, index);
          const saleId = accounts.insertSale(owner, amount, now);
          accounts.insertAllocatedLine(saleId, heading + ' · chico ' + round.number + ' · equipo ' + team + ' · grupo #' + sessionId + description, amount);
          charge.run(id, slotId, saleId);
        }
      }
      offset += count;
    }
    return sessionId;
  }

  function assign(sessionId: number, fields: Record<string, unknown>) {
    const session = open(sessionId);
    const { roundId = null } = fields;
    if (roundId !== null && !isId(roundId)) throw new ValidationError(400, 'Selecciona un chico.');
    const heading = courtLabel(session.courtType as TejoType, Number(session.courtNumber));
    const teamSize = teamSizeFor(sessionId);
    if (teamSize) return assignTeams(sessionId, teamSize, heading, fields, roundId);
    const players = roster(sessionId);
    if (!Array.isArray(fields.losses) || !fields.losses.length || fields.losses.length > players.length) {
      throw new ValidationError(400, 'Indica cuántos chicos perdió al menos un jugador.');
    }
    const available = database.prepare('SELECT played.id, played.number, ' + roundTotal + ' AS total ' +
      pendingRounds + assignmentScope + ' AND played.player_count >= ? ORDER BY played.number LIMIT ?');
    const seen = new Set<number>();
    const description = stakeDescription(roundId);
    const losses = fields.losses.map((entry) => {
      const { playerId, count, name, accountId } = record(entry) ?? {};
      const player = players.find((item) => item.id === playerId);
      if (!isId(playerId) || !player || seen.has(playerId) || !whole(count, 1, 10_000)) {
        throw new ValidationError(400, 'Revisa las cantidades de chicos perdidos.');
      }
      seen.add(playerId);
      return { player, playerId, count, name, accountId };
    }).sort((a, b) => Number(b.player.number) - Number(a.player.number));

    for (const entry of losses) {
      const rounds = available.all(sessionId, roundId, roundId, Number(entry.player.number), entry.count);
      if (rounds.length !== entry.count) throw new ValidationError(400, 'No quedan suficientes chicos pendientes en los que participó ' + entry.player.name + '.');
      const owner = assignOwner(sessionId, entry.player, entry.name, entry.accountId);
      const now = new Date().toISOString();
      for (const round of rounds) {
        const total = Number(round.total);
        const saleId = accounts.insertSale(owner, total, now);
        accounts.insertAllocatedLine(saleId, heading + ' · chico ' + round.number + ' · grupo #' + sessionId + description, total);
        database.prepare('UPDATE tejo_played SET loser_slot = ?, sale_id = ? WHERE id = ?')
          .run(entry.playerId, saleId, Number(round.id));
      }
    }
    return sessionId;
  }

  function fulfill(session: number, fields: Record<string, unknown>) {
    open(session);
    accounts.requireShift();
    const { roundId, playerId, choice } = fields;
    if (!isId(roundId) || !isId(playerId) || (choice !== 'token' && choice !== 'products')) {
      throw new ValidationError(400, 'Elige cómo usa su derecho el jugador.');
    }
    const benefit = database.prepare([
      'SELECT tejo_slot_benefits.id, issued_at AS issuedAt, redeemed_at AS redeemedAt, rate, tejo_slots.account_id AS accountId',
      'FROM tejo_slot_benefits JOIN tejo_played ON tejo_played.id = round_id JOIN tejo_slots ON tejo_slots.id = slot_id',
      'WHERE tejo_played.session_id = ? AND round_id = ? AND slot_id = ?',
    ].join(' ')).get(session, roundId, playerId);
    if (!benefit) throw new ValidationError(404, 'Este jugador no participó en ese chico.');
    if (benefit.issuedAt !== null || benefit.redeemedAt !== null) throw new ValidationError(409, 'El jugador ya usó su derecho.');
    const benefitId = Number(benefit.id);
    const now = new Date().toISOString();
    if (choice === 'token') {
      if (!availableTokens()) throw new ValidationError(409, 'No hay fichas disponibles en caja. La entrega sigue pendiente.');
      database.prepare('UPDATE tejo_slot_benefits SET issued_at = ? WHERE id = ?').run(now, benefitId);
      return benefitId;
    }
    const items = saleItems(fields.items);
    const payment = paymentFields(fields.payment);
    if (!items || !payment) throw new ValidationError(400, 'Revisa los productos y el pago.');
    const ordered = items.map((item) => {
      const product = findProduct(database, item.productId);
      if (!product?.active || product.price !== item.unitPrice || Number(product.stock) < item.quantity) {
        throw new ValidationError(409, 'Cambió el precio o la disponibilidad de un producto. Actualiza antes de confirmar.');
      }
      return { ...item, label: [product.name, product.brand, product.presentation].filter(Boolean).join(' · ') };
    });
    const subtotal = ordered.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    const extra = Math.max(0, subtotal - Number(benefit.rate));
    const paid = paymentTotal(payment);
    const owner = benefit.accountId === null
      ? isId(fields.accountId) ? Number(accounts.accountById(fields.accountId).id) : null
      : Number(benefit.accountId);
    if (subtotal > 1_000_000_000 || paid > extra || (owner === null && paid !== extra)) {
      throw new ValidationError(400, 'Cobra solo el excedente. Para dejar saldo, elige una cuenta por nombre.');
    }
    if (extra > 0) {
      const sale = accounts.insertSale(owner, extra, now);
      accounts.insertAllocatedLine(sale, 'Excedente de chico de tejo · grupo #' + session + ' · ' +
        ordered.map((item) => item.quantity + ' × ' + item.label).join(', '), extra);
      if (paid > 0) accounts.insertPayment(owner, sale, payment, now);
    }
    for (const item of ordered) {
      const movement = recordInventoryMovement(database, { productId: item.productId, units: -item.quantity,
        reason: 'Tejo · consumo del grupo #' + session + ' · chico #' + roundId, createdAt: now,
        quantity: item.quantity, inputUnit: 'unidad', unitsPerInput: 1 });
      database.prepare('INSERT INTO tejo_slot_consumptions (benefit_id, label, quantity, unit_price, movement_id) VALUES (?, ?, ?, ?, ?)')
        .run(benefitId, item.label, item.quantity, item.unitPrice, movement);
    }
    database.prepare('UPDATE tejo_slot_benefits SET redeemed_at = ?, redemption_total = ?, extra = ? WHERE id = ?')
      .run(now, subtotal, extra, benefitId);
    return benefitId;
  }

  function close(session: number) {
    open(session);
    if (database.prepare('SELECT 1 ' + pendingRounds + ' LIMIT 1').get(session)) {
      throw new ValidationError(409, 'Asigna los chicos perdidos antes de liberar la cancha.');
    }
    if (database.prepare([
      'SELECT 1 FROM tejo_slot_benefits JOIN tejo_played ON tejo_played.id = round_id',
      'WHERE session_id = ? AND issued_at IS NULL AND redeemed_at IS NULL LIMIT 1',
    ].join(' ')).get(session)) throw new ValidationError(409, 'Registra las fichas o los consumos pendientes antes de liberar la cancha.');
    if (database.prepare([
      'SELECT 1 FROM tejo_round_products product JOIN tejo_played played ON played.id = product.round_id',
      'WHERE played.session_id = ? AND product.movement_id IS NULL LIMIT 1',
    ].join(' ')).get(session)) throw new ValidationError(409, 'Registra la entrega de los productos apostados antes de liberar la cancha.');
    database.prepare('UPDATE tejo_sessions SET closed_at = ? WHERE id = ?').run(new Date().toISOString(), session);
    return session;
  }

  function describe(sessionId: number) {
    const players = roster(sessionId);
    if (!players.length) return null;
    const teamSize = teamSizeFor(sessionId);
    const rows = database.prepare([
      'SELECT played.id, played.number, loser_slot AS loserId, customer_accounts.name AS loser,',
      'rate, player_count AS playerCount, ' + roundTotal + ' AS total, played.sale_id AS saleId, billed_to.name AS chargedTo,',
      'played.created_at AS createdAt, result.losing_team AS losingTeam',
      'FROM tejo_played played LEFT JOIN tejo_team_results result ON result.round_id = played.id',
      'LEFT JOIN tejo_slots ON tejo_slots.id = loser_slot LEFT JOIN customer_accounts ON customer_accounts.id = tejo_slots.account_id',
      'LEFT JOIN sales billed ON billed.id = played.sale_id LEFT JOIN customer_accounts billed_to ON billed_to.id = billed.account_id',
      'WHERE played.session_id = ? ORDER BY played.number DESC',
    ].join(' ')).all(sessionId);
    const benefits = database.prepare([
      "SELECT benefit.id, slot_id AS accountId, COALESCE(name, 'Jugador ' || slot.number) AS name,",
      'slot.account_id AS customerId, issued_at AS issuedAt, redeemed_at AS redeemedAt, redemption_total AS subtotal, extra',
      'FROM tejo_slot_benefits benefit JOIN tejo_slots slot ON slot.id = slot_id',
      'LEFT JOIN customer_accounts ON customer_accounts.id = slot.account_id WHERE round_id = ? ORDER BY slot.number',
    ].join(' '));
    const products = database.prepare('SELECT label, quantity, unit_price AS unitPrice FROM tejo_slot_consumptions WHERE benefit_id = ? ORDER BY id');
    const charges = database.prepare([
      'SELECT charge.slot_id AS playerId, name, sales.total AS amount FROM tejo_team_charges charge',
      'JOIN sales ON sales.id = charge.sale_id JOIN customer_accounts ON customer_accounts.id = sales.account_id',
      'JOIN tejo_slots ON tejo_slots.id = charge.slot_id WHERE charge.round_id = ? ORDER BY tejo_slots.number',
    ].join(' '));
    return { flexible: true, teamSize, players, rounds: rows.map((round) => ({
      ...round, number: Number(round.number), flexible: true,
      charges: round.losingTeam ? charges.all(Number(round.id)) : [], stake: productsByRound.all(Number(round.id)),
      benefits: benefits.all(Number(round.id)).map((item) => ({
        accountId: item.accountId, customerId: item.customerId, name: item.name, issuedAt: item.issuedAt,
        redemption: item.redeemedAt === null ? null : {
          id: item.id, name: item.name, tokens: 0, allowance: round.rate, subtotal: item.subtotal, extra: item.extra,
          createdAt: item.redeemedAt, items: products.all(Number(item.id)),
        },
      })),
    })) };
  }

  const hasSlots = (session: number) => Boolean(database.prepare('SELECT 1 FROM tejo_slots WHERE session_id = ? LIMIT 1').get(session));
  return { start, addPlayer, play, assign, fulfill, deliverStake, close, describe, hasSlots };
}
