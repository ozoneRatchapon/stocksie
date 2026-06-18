// Smoke test for the IndexedDB shelf layer (plan 006 §F.1).
//
// The plan calls for an integration test over the shelf DB. Vitest runs in the
// `node` environment (see vitest.config.ts), where `indexedDB` is undefined —
// exactly the SSR / unsupported-browser condition `getDb()` is designed to
// reject. We exercise that contract end-to-end here: every public helper in
// `shelf.ts` must reject (rather than throw synchronously or silently succeed)
// when the underlying DB cannot be opened, so callers can `try/catch` and fall
// back to manual entry without crashing a server render.
//
// A true CRUD round-trip would require `fake-indexeddb`; that dep isn't on the
// project, and the plan permits smoke-only. The SSR-rejection invariant is the
// property that actually protects the Next.js server graph, so it is the right
// thing to pin.

import { describe, expect, it, beforeEach } from "vitest";
import {
  deleteProduct,
  findByBarcode,
  getProduct,
  listProducts,
  upsertProduct,
  type ProductInput,
} from "./shelf";

/** A minimal valid ProductInput — fields not under test default sensibly. */
function input(
  over: Partial<ProductInput> & { barcode: string }
): ProductInput {
  return {
    name: "Dish Soap",
    packUnits: 1,
    unitGrams: 500,
    ...over,
  };
}

describe("shelf — SSR / no-IndexedDB safety", () => {
  // Vitest's node environment has no `indexedDB` global. Belt-and-braces: make
  // sure no test pollution has shimming it in.
  beforeEach(() => {
    // @ts-expect-error — intentionally blowing away the global for the suite.
    delete globalThis.indexedDB;
  });

  it("getDb rejects when indexedDB is undefined (node / SSR)", async () => {
    // Re-import dynamically so the singleton `dbPromise` is freshly evaluated
    // against the (now-undefined) global each time.
    const { getDb } = await import("./db");
    await expect(getDb()).rejects.toThrow(/IndexedDB is not available/);
  });

  it("getProduct rejects (caller can try/catch → manual entry)", async () => {
    await expect(getProduct("123")).rejects.toThrow(
      /IndexedDB is not available/
    );
  });

  it("findByBarcode is an alias of getProduct and rejects identically", async () => {
    await expect(findByBarcode("123")).rejects.toThrow(
      /IndexedDB is not available/
    );
  });

  it("listProducts rejects", async () => {
    await expect(listProducts()).rejects.toThrow(/IndexedDB is not available/);
  });

  it("upsertProduct rejects (no silent success on the server)", async () => {
    await expect(upsertProduct(input({ barcode: "x" }))).rejects.toThrow(
      /IndexedDB is not available/
    );
  });

  it("deleteProduct rejects", async () => {
    await expect(deleteProduct("x")).rejects.toThrow(
      /IndexedDB is not available/
    );
  });
});
