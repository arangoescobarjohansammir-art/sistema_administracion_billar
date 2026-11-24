import type { DatabaseSync } from 'node:sqlite';

export const productSelect = [
  'SELECT p.id, name, brand, presentation, price, package_name AS packageName,',
  '  units_per_package AS unitsPerPackage, active, photo IS NOT NULL AS hasPhoto,',
  '  COALESCE((SELECT SUM(units) FROM inventory_movements WHERE product_id = p.id), 0) AS stock',
  'FROM products p',
].join(' ');

export function findProduct(database: DatabaseSync, id: number) {
  return database.prepare(productSelect + ' WHERE p.id = ?').get(id);
}

export function recordInventoryMovement(database: DatabaseSync, movement: {
  productId: number; units: number; reason: string; createdAt: string;
  quantity: number; inputUnit: string; unitsPerInput: number;
}) {
  return database.prepare(
    'INSERT INTO inventory_movements (product_id, units, reason, created_at, quantity, input_unit, units_per_input) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(movement.productId, movement.units, movement.reason, movement.createdAt,
    movement.quantity, movement.inputUnit, movement.unitsPerInput).lastInsertRowid;
}
