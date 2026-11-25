import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync, SQLOutputValue } from 'node:sqlite';
import { inventoryCountLimit, inventoryUnitLimit, type InventoryCount, type InventoryCountSummary } from '../shared/inventory-counts.js';
import { record, type createAccounts, ValidationError, whole } from './accounts.js';
import type { Audit } from './audit.js';
import { readJson, sendJson } from './http.js';
import { recordInventoryMovement } from './inventory.js';
import { requestOperator } from './operators.js';

type Accounts = ReturnType<typeof createAccounts>;
const maxId = Number.MAX_SAFE_INTEGER;
const noteText = (value: unknown) => typeof value === 'string' && value.trim().length <= 300 ? value.trim() : null;
const productLabel = (product: { name: unknown; brand: unknown; presentation: unknown }) =>
  [product.name, product.brand, product.presentation].filter(Boolean).join(' · ');

function countSummary(row: Record<string, SQLOutputValue>): InventoryCountSummary {
  return {
    id: Number(row.id), countedBy: String(row.countedBy), createdAt: String(row.createdAt), note: String(row.note),
    lines: Number(row.lines), differences: Number(row.differences),
    adjustedBy: typeof row.adjustedBy === 'string' ? row.adjustedBy : null,
    adjustedAt: typeof row.adjustedAt === 'string' ? row.adjustedAt : null,
    adjustmentNote: typeof row.adjustmentNote === 'string' ? row.adjustmentNote : null,
  };
}

export function createInventoryCounts(database: DatabaseSync, accounts: Accounts, audit: Audit) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS inventory_counts (
      id INTEGER PRIMARY KEY, operator_id INTEGER NOT NULL REFERENCES cash_operators(id), counted_by TEXT NOT NULL,
      created_at TEXT NOT NULL, note TEXT NOT NULL, adjusted_by TEXT, adjusted_at TEXT, adjustment_note TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS inventory_count_lines (
      count_id INTEGER NOT NULL REFERENCES inventory_counts(id), product_id INTEGER NOT NULL REFERENCES products(id),
      label TEXT NOT NULL, expected INTEGER NOT NULL, counted INTEGER NOT NULL CHECK (counted >= 0),
      movement_version INTEGER NOT NULL CHECK (movement_version >= 0),
      PRIMARY KEY (count_id, product_id)
    ) STRICT;
  `);

  const current = database.prepare(`
    SELECT p.id, p.name, p.brand, p.presentation, p.active,
      COALESCE(SUM(m.units), 0) AS expected, COALESCE(MAX(m.id), 0) AS version
    FROM products p LEFT JOIN inventory_movements m ON m.product_id = p.id WHERE p.id = ? GROUP BY p.id
  `);
  const insertLine = database.prepare('INSERT INTO inventory_count_lines VALUES (?, ?, ?, ?, ?, ?)');
  const summary = `
    SELECT c.id, c.counted_by AS countedBy, c.created_at AS createdAt, c.note,
      c.adjusted_by AS adjustedBy, c.adjusted_at AS adjustedAt, c.adjustment_note AS adjustmentNote,
      (SELECT COUNT(*) FROM inventory_count_lines WHERE count_id = c.id) AS lines,
      (SELECT COUNT(*) FROM inventory_count_lines WHERE count_id = c.id AND counted <> expected) AS differences
    FROM inventory_counts c
  `;
  const rawLines = database.prepare('SELECT * FROM inventory_count_lines WHERE count_id = ? ORDER BY label COLLATE NOCASE, product_id');

  function detail(id: number): InventoryCount {
    const saved = database.prepare(summary + ' WHERE c.id = ?').get(id);
    if (!saved) throw new ValidationError(404, 'Conteo no encontrado.');
    return { ...countSummary(saved), items: rawLines.all(id).map((line) => {
      const product = current.get(Number(line.product_id));
      return {
        productId: Number(line.product_id), label: String(line.label), expected: Number(line.expected), counted: Number(line.counted),
        changed: !saved.adjustedAt && line.expected !== line.counted &&
          (!product?.active || product.version !== line.movement_version),
      };
    }) };
  }

  function register(request: IncomingMessage, input: Record<string, unknown>) {
    const note = noteText(input.note);
    const actor = requestOperator(request)!;
    if (note === null || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > inventoryCountLimit) {
      throw new ValidationError(400, 'Indica entre 1 y ' + inventoryCountLimit + ' productos contados.');
    }
    const seen = new Set<number>();
    const items = input.items.map((value) => {
      const { productId, counted, version } = record(value) ?? {};
      if (!whole(productId, 1, maxId) || !whole(counted, 0, inventoryUnitLimit) || !whole(version, 0, maxId) || seen.has(productId)) {
        throw new ValidationError(400, 'Revisa las cantidades y evita repetir productos.');
      }
      seen.add(productId);
      return { productId, counted, version };
    });

    return accounts.writeOnce(input.requestId, JSON.stringify(['inventory-count', items, note]), () => {
      const createdAt = new Date().toISOString();
      const id = Number(database.prepare('INSERT INTO inventory_counts (operator_id, counted_by, created_at, note) VALUES (?, ?, ?, ?)')
        .run(actor.id, actor.name, createdAt, note).lastInsertRowid);
      let differences = 0;
      for (const item of items) {
        const product = current.get(item.productId);
        const label = product ? productLabel({ name: product.name, brand: product.brand, presentation: product.presentation }) : '';
        if (!product?.active || product.version !== item.version) {
          throw new ValidationError(409, 'Cambió el inventario' + (label ? ' de ' + label : '') + '. Actualiza la lista y vuelve a contar los productos que cambiaron.');
        }
        if (product.expected !== item.counted) differences++;
        insertLine.run(id, item.productId, label, product.expected, item.counted, item.version);
      }
      audit.record(request, 'inventory_count', id, items.length + ' productos · ' + differences + ' con diferencia' + (note ? ' · ' + note : ''));
      return id;
    });
  }

  function apply(request: IncomingMessage, id: number, input: Record<string, unknown>) {
    const actor = requestOperator(request)!;
    if (actor.role !== 'admin') throw new ValidationError(403, 'El administrador debe aprobar el ajuste de existencias.');
    const note = noteText(input.note);
    if (!note) throw new ValidationError(400, 'Explica por qué se aplicará el ajuste.');
    return accounts.writeOnce(input.requestId, JSON.stringify(['inventory-count-apply', id, note]), () => {
      const saved = detail(id);
      if (saved.adjustedAt) throw new ValidationError(409, 'El ajuste ya está registrado.');
      const differences = saved.items.filter((line) => line.expected !== line.counted);
      if (!differences.length) throw new ValidationError(409, 'El conteo no tiene diferencias para ajustar.');
      if (differences.some((line) => line.changed)) {
        throw new ValidationError(409, 'Hay productos con movimientos posteriores a este conteo. Registra un conteo nuevo antes de ajustar.');
      }
      const createdAt = new Date().toISOString();
      for (const line of differences) {
        const units = line.counted - line.expected;
        recordInventoryMovement(database, { productId: line.productId, units, quantity: Math.abs(units), unitsPerInput: 1,
          inputUnit: 'unidad', reason: 'Conteo físico #' + id + ' · ' + note, createdAt });
      }
      database.prepare('UPDATE inventory_counts SET adjusted_by = ?, adjusted_at = ?, adjustment_note = ? WHERE id = ?')
        .run(actor.name, createdAt, note, id);
      audit.record(request, 'inventory_count_adjustment', id, differences.length + ' productos ajustados · ' + note);
      return id;
    });
  }

  return async function handle(request: IncomingMessage, response: ServerResponse, path: string) {
    try {
      if (request.method === 'GET' && path === '/api/inventory-counts/products') {
        const list = database.prepare(`
          SELECT p.id, p.name, p.brand, p.presentation, p.package_name AS packageName, p.units_per_package AS unitsPerPackage,
            COALESCE((SELECT MAX(id) FROM inventory_movements WHERE product_id = p.id), 0) AS version
          FROM products p WHERE p.active = 1 ORDER BY p.name COLLATE NOCASE, p.id
        `).all();
        return sendJson(response, 200, list);
      }
      if (request.method === 'GET' && path === '/api/inventory-counts') {
        const before = Number(new URL(request.url ?? '/', 'http://localhost').searchParams.get('before') ?? maxId);
        return sendJson(response, 200, database.prepare(summary + ' WHERE c.id < ? ORDER BY c.id DESC LIMIT 40')
          .all(whole(before, 1, maxId) ? before : maxId).map(countSummary));
      }
      if (request.method === 'POST' && path === '/api/inventory-counts') {
        const input = await readJson(request, 25_000);
        if (!input) throw new ValidationError(400, 'Revisa los productos y las cantidades del conteo.');
        const result = register(request, input);
        return sendJson(response, result.repeated ? 200 : 201, result);
      }
      const match = /^\/api\/inventory-counts\/([1-9]\d*)(\/apply)?$/.exec(path);
      const id = Number(match?.[1]);
      if (!match || !whole(id, 1, maxId)) throw new ValidationError(404, 'Ruta de conteo no encontrada.');
      if (!match[2] && request.method === 'GET') return sendJson(response, 200, detail(id));
      if (match[2] && request.method === 'POST') {
        const input = await readJson(request);
        if (!input) throw new ValidationError(400, 'Explica por qué se aplicará el ajuste.');
        const result = apply(request, id, input);
        return sendJson(response, result.repeated ? 200 : 201, result);
      }
      return sendJson(response, 405, { error: 'Método no permitido.' });
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return sendJson(response, error.status, { error: error.message });
    }
  };
}
