// IndexedDB wrapper for the Stocksie off-chain shelf.
//
// The shelf is a per-device, client-side catalog of household essentials
// (name, pack size, unit weight) used to drive the best-value comparison and
// to prefill purchase requests. It is strictly OFF-CHAIN: per docs/PRIVACY.md
// and docs/ROADMAP.md §4, item names/prices never go to the chain — only their
// blake3 hashes do. See plan 006 §2 (scope) and §4.1 (schema).
//
// `idb` (a tiny Promise wrapper over the raw IndexedDB API) keeps this file
// small and awaitable. SSR-safe: every entry point rejects on the server,
// where `indexedDB` is undefined — callers are expected to be client-side.

import { openDB, type DBSchema, type IDBPDatabase } from "idb";

const DB_NAME = "stocksie-shelf";
const DB_VERSION = 1;
export const STORE_PRODUCTS = "products";

/** A household essential cataloged on the shelf. Keyed by barcode. */
export interface ShelfProduct {
  /** EAN/UPC, or `manual-<uuid>` for camera-less entry. */
  barcode: string;
  name: string;
  brand?: string;
  /** Number of units in the pack (1, 2, 6, ...). */
  packUnits: number;
  /** Weight/volume of ONE unit, in grams (ml treated as grams). */
  unitGrams: number;
  /** Last-known SOL price in lamports; prefill convenience only. */
  defaultPriceLamports?: bigint;
  category?: string;
  /** Epoch ms, set on first insert. */
  createdAt: number;
  /** Epoch ms, refreshed on every write. */
  updatedAt: number;
}

/** Typed schema so `idb`'s helpers return `ShelfProduct`, not `any`. */
interface StocksieShelfDB extends DBSchema {
  products: {
    key: string;
    value: ShelfProduct;
    indexes: { "by-name": string };
  };
}

let dbPromise: Promise<IDBPDatabase<StocksieShelfDB>> | null = null;

/**
 * Open (and lazily create/migrate) the shelf DB. Cached as a singleton so the
 * whole app shares one connection. Rejects on the server (no `indexedDB`).
 *
 * Callers should treat a rejection as "shelf unavailable" and degrade to the
 * manual-entry path — never let it crash a server render.
 */
export function getDb(): Promise<IDBPDatabase<StocksieShelfDB>> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(
      new Error(
        "IndexedDB is not available (SSR or unsupported browser). The shelf is client-side only.",
      ),
    );
  }
  if (!dbPromise) {
    dbPromise = openDB<StocksieShelfDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore(STORE_PRODUCTS, {
          keyPath: "barcode",
        });
        store.createIndex("by-name", "name");
      },
    });
  }
  return dbPromise;
}
