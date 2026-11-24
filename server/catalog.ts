import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { readJson, sendJson } from './http.js';

const photoLimit = 2 * 1024 * 1024;
const nameLimit = 100;
const quantityLimit = 1_000_000;
const priceLimit = 1_000_000_000;

function stringField(value: unknown, limit: number) {
  if (typeof value !== 'string' || value.trim().length > limit) return null;
  return value.trim();
}

function integerField(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}

function parsePhoto(value: unknown) {
  if (typeof value !== 'string') return null;
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return null;
  const [, mime, encoded] = match;
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > photoLimit || bytes.toString('base64') !== encoded) return null;
  const valid = mime === 'image/jpeg'
    ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    : mime === 'image/png'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  return valid ? { bytes, mime } : null;
}

export function createCatalog(database: DatabaseSync) {
  database.exec([
    'PRAGMA foreign_keys = ON;',
    'CREATE TABLE IF NOT EXISTS products (',
    '  id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL, presentation TEXT NOT NULL,',
    '  price INTEGER NOT NULL CHECK (price >= 0), package_name TEXT NOT NULL,',
    '  units_per_package INTEGER NOT NULL CHECK (units_per_package >= 1),',
    '  active INTEGER NOT NULL CHECK (active IN (0, 1)), photo BLOB, photo_mime TEXT',
    ') STRICT;',
    'CREATE TABLE IF NOT EXISTS inventory_movements (',
    '  id INTEGER PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id),',
    '  units INTEGER NOT NULL CHECK (units <> 0), reason TEXT NOT NULL,',
    '  created_at TEXT NOT NULL, quantity INTEGER NOT NULL CHECK (quantity > 0),',
    '  input_unit TEXT NOT NULL, units_per_input INTEGER NOT NULL CHECK (units_per_input >= 1)',
    ') STRICT;',
    'CREATE INDEX IF NOT EXISTS inventory_by_product ON inventory_movements(product_id, id);',
  ].join('\n'));

  const select = [
    'SELECT p.id, name, brand, presentation, price, package_name AS packageName,',
    '  units_per_package AS unitsPerPackage, active, photo IS NOT NULL AS hasPhoto,',
    '  COALESCE((SELECT SUM(units) FROM inventory_movements WHERE product_id = p.id), 0) AS stock',
    'FROM products p',
  ].join(' ');

  function productById(id: number) {
    return database.prepare(select + ' WHERE p.id = ?').get(id);
  }

  async function saveProduct(request: IncomingMessage, response: ServerResponse, id?: number) {
    const input = await readJson(request, Math.ceil(photoLimit / 3) * 4 + 4096);
    if (!input) return sendJson(response, 400, { error: 'Revisa los datos. La foto admite hasta 2 MB.' });
    const name = stringField(input.name, nameLimit);
    const brand = stringField(input.brand, nameLimit);
    const presentation = stringField(input.presentation, nameLimit);
    const packageName = stringField(input.packageName, 50);
    const { price, unitsPerPackage, active } = input;
    if (!name || brand === null || !presentation || packageName === null ||
      !integerField(price, 0, priceLimit) || !integerField(unitsPerPackage, 1, 10_000) ||
      (!packageName && unitsPerPackage !== 1) || typeof active !== 'boolean') {
      return sendJson(response, 400, { error: 'Revisa nombre, presentación, precio y unidades por empaque.' });
    }
    const updatePhoto = input.photo !== undefined;
    const photo = updatePhoto && input.photo !== null ? parsePhoto(input.photo) : null;
    if (updatePhoto && input.photo !== null && !photo) {
      return sendJson(response, 400, { error: 'Selecciona una foto JPG, PNG o WebP de hasta 2 MB.' });
    }
    const fields = [name, brand, presentation, price, packageName, unitsPerPackage, Number(active)] as const;
    if (id === undefined) {
      const result = database.prepare(
        'INSERT INTO products (name, brand, presentation, price, package_name, units_per_package, active, photo, photo_mime) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(...fields, photo?.bytes ?? null, photo?.mime ?? null);
      return sendJson(response, 201, productById(Number(result.lastInsertRowid)));
    }
    const result = database.prepare(
      'UPDATE products SET name = ?, brand = ?, presentation = ?, price = ?, package_name = ?, units_per_package = ?, active = ?' +
      (updatePhoto ? ', photo = ?, photo_mime = ?' : '') + ' WHERE id = ?',
    ).run(...fields, ...(updatePhoto ? [photo?.bytes ?? null, photo?.mime ?? null] : []), id);
    if (!result.changes) return sendJson(response, 404, { error: 'Producto no encontrado.' });
    return sendJson(response, 200, productById(id));
  }

  async function addMovement(request: IncomingMessage, response: ServerResponse, id: number) {
    const input = await readJson(request);
    const reason = stringField(input?.reason, 240);
    const { quantity, direction, unit } = input ?? {};
    if (!reason || !integerField(quantity, 1, quantityLimit) ||
      (direction !== 'in' && direction !== 'out') || (unit !== 'unit' && unit !== 'package')) {
      return sendJson(response, 400, { error: 'Indica un motivo y una cantidad entera mayor que cero.' });
    }

    database.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const product = productById(id);
      if (!product) return sendJson(response, 404, { error: 'Producto no encontrado.' });
      if (!product.active) return sendJson(response, 409, { error: 'Reactiva el producto antes de mover sus existencias.' });
      if (unit === 'package' && !product.packageName) {
        return sendJson(response, 400, { error: 'Este producto no tiene empaque configurado.' });
      }
      const unitsPerInput = unit === 'package' ? Number(product.unitsPerPackage) : 1;
      const units = (direction === 'in' ? 1 : -1) * unitsPerInput * quantity;
      const newStock = Number(product.stock) + units;
      if (newStock < 0 || newStock > quantityLimit) {
        return sendJson(response, 409, { error: newStock < 0 ? 'No hay suficientes unidades.' : 'Se excede el límite de existencias.' });
      }
      database.prepare(
        'INSERT INTO inventory_movements (product_id, units, reason, created_at, quantity, input_unit, units_per_input) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(id, units, reason, new Date().toISOString(), quantity,
        unit === 'package' ? String(product.packageName) : 'unidad', unitsPerInput);
      const updated = productById(id);
      database.exec('COMMIT');
      committed = true;
      return sendJson(response, 201, updated);
    } finally {
      if (!committed) database.exec('ROLLBACK');
    }
  }

  return async function handleCatalog(request: IncomingMessage, response: ServerResponse, path: string) {
    const match = /^\/api\/products(?:\/([1-9]\d*)(?:\/(photo|movements))?)?$/.exec(path);
    if (!match) return sendJson(response, 404, { error: 'Ruta de catálogo no encontrada.' });
    const [, rawId, action] = match;
    const id = Number(rawId);
    if (rawId && !Number.isSafeInteger(id)) return sendJson(response, 404, { error: 'Producto no encontrado.' });
    if (!rawId && request.method === 'GET') {
      return sendJson(response, 200, database.prepare(select + ' ORDER BY active DESC, name COLLATE NOCASE, id').all());
    }
    if (!rawId && request.method === 'POST') return saveProduct(request, response);
    if (rawId && !action && request.method === 'PUT') return saveProduct(request, response, id);
    if (action === 'movements' && request.method === 'POST') return addMovement(request, response, id);
    if (action === 'movements' && request.method === 'GET') {
      if (!productById(id)) return sendJson(response, 404, { error: 'Producto no encontrado.' });
      const rows = database.prepare(
        'SELECT id, units, reason, created_at AS createdAt, quantity, input_unit AS inputUnit, units_per_input AS unitsPerInput ' +
        'FROM inventory_movements WHERE product_id = ? ORDER BY id DESC',
      ).all(id);
      return sendJson(response, 200, rows);
    }
    if (action === 'photo' && request.method === 'GET') {
      const row = database.prepare('SELECT photo, photo_mime AS mime FROM products WHERE id = ?').get(id);
      if (!(row?.photo instanceof Uint8Array) || typeof row.mime !== 'string') {
        return sendJson(response, 404, { error: 'Foto no encontrada.' });
      }
      response.writeHead(200, { 'Content-Type': row.mime, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return response.end(row.photo);
    }
    return sendJson(response, 405, { error: 'Método no permitido.' });
  };
}
