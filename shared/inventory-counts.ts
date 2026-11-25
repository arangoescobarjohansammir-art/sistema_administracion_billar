export const inventoryCountLimit = 200;
export const inventoryUnitLimit = 1_000_000;

export type CountProduct = {
  id: number; name: string; brand: string; presentation: string;
  packageName: string; unitsPerPackage: number; version: number;
};

export type InventoryCountSummary = {
  id: number; countedBy: string; createdAt: string; note: string; lines: number; differences: number;
  adjustedBy: string | null; adjustedAt: string | null; adjustmentNote: string | null;
};

export type InventoryCountLine = {
  productId: number; label: string; expected: number; counted: number; changed: boolean;
};

export type InventoryCount = InventoryCountSummary & { items: InventoryCountLine[] };
