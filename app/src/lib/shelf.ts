// Shelf-domain CRUD over the IndexedDB wrapper in `db.ts`.
//
// Thin async helpers used by the UI (ShelfList, ProductOnboardingForm, the
// scanner page). Each opens the DB via `getDb()` and returns plain
// `ShelfProduct` values — no React, no Solana. SSR-safe (rejects on the
// server), so callers can `try/catch` and fall back to manual entry.

import { getDb, type ShelfProduct } from "./db";

export type { ShelfProduct } from "./db";

export async function getProduct(
  barcode: string,
): Promise<ShelfProduct | undefined> {
  const db = await getDb();
  return db.get("products", barcode);
}

/** Alias of `getProduct`; reads better at scan-time ("find by the code I just scanned"). */
export async function findByBarcode(
  barcode: string,
): Promise<ShelfProduct | undefined> {
  return getProduct(barcode);
}

export async function listProducts(): Promise<ShelfProduct[]> {
  const db = await getDb();
  return db.getAll("products");
}

/** Input shape for creating/updating a product (no timestamps — those are managed). */
export interface ProductInput {
  barcode: string;
  name: string;
  brand?: string;
  packUnits: number;
  unitGrams: number;
  defaultPriceLamports?: bigint;
  category?: string;
}

/**
 * Insert or overwrite a product by barcode. `createdAt` is preserved on
 * overwrite (set once on first insert); `updatedAt` always refreshes.
 */
export async function upsertProduct(
  input: ProductInput,
): Promise<ShelfProduct> {
  const db = await getDb();
  const now = Date.now();
  const existing = await db.get("products", input.barcode);
  const product: ShelfProduct = {
    barcode: input.barcode,
    name: input.name,
    packUnits: input.packUnits,
    unitGrams: input.unitGrams,
    brand: input.brand,
    defaultPriceLamports: input.defaultPriceLamports,
    category: input.category,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await db.put("products", product);
  return product;
}

export async function deleteProduct(barcode: string): Promise<void> {
  const db = await getDb();
  await db.delete("products", barcode);
}
