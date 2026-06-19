"use client";

// ShelfList — the off-chain household essentials catalog UI (plan 006, Phase B).
//
// This is the operational surface of the shelf: it loads every `ShelfProduct`
// from IndexedDB and renders them as a scannable list with edit + delete
// affordances, plus an "Add product" toggle that swaps in a
// `<ProductOnboardingForm />` for create/edit. The list owns all IO
// (load/upsert/delete) and refreshes itself after every mutation so the UI is
// always a faithful view of what's persisted on this device.
//
// No Solana, no wallet, no React context — the shelf is strictly off-chain
// (plan 006 §2). The parent `/shelf` route renders this inside a shell with a
// back link; this component just renders the catalog itself.
//
// Three states drive the layout:
//   - `loading`   → first-load skeleton (avoids an empty-state flash on mount).
//   - `loadError` → IndexedDB was unavailable (e.g. private mode, SSR). Show
//                   a calm error with the message; the user can retry.
//   - `products`  → the list. Empty list → a friendly empty state with a
//                   single call-to-action ("Add your first product").
//
// Create/edit share the same form component; only one is open at a time
// (`mode` is `'idle' | 'create' | 'edit'`), and opening one closes the other.

import { useCallback, useEffect, useState } from "react";
import {
  deleteProduct,
  listProducts,
  upsertProduct,
  type ProductInput,
  type ShelfProduct,
} from "@/lib/shelf";
import { extractErrorMessage, formatSol } from "@/lib/format";
import { Panel } from "@/components/ui/Panel";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ProductOnboardingForm } from "./ProductOnboardingForm";

/** Which form (if any) is currently open over the list. */
type Mode =
  | { kind: "idle" }
  | { kind: "create" }
  | { kind: "edit"; product: ShelfProduct };

/**
 * Render the shelf catalog: list + add/edit form + delete flow.
 *
 * Loads products on mount and after every mutation. Owns the create/edit
 * toggle and the per-row delete confirmation.
 */
export function ShelfList() {
  const [products, setProducts] = useState<ShelfProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [actionError, setActionError] = useState<string | null>(null);
  // Barcode of the row whose delete is awaiting confirmation, or null. Keeps
  // the confirm UX inline (no native dialog) and scoped to one row at a time.
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Load + refresh. `refresh` is stable (useCallback) so the mount effect
  // doesn't re-run, and so create/edit/delete handlers can call it after
  // their mutation lands.
  // -----------------------------------------------------------------------
  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const list = await listProducts();
      list.sort(byDisplayName);
      setProducts(list);
    } catch (err) {
      setLoadError(extractErrorMessage(err));
      setProducts([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // -----------------------------------------------------------------------
  // Mutations. Each clears `actionError` optimistically, runs the IO, and
  // refreshes the list on success. Errors are surfaced via the panel-level
  // banner rather than per-row so a failure doesn't get lost in the layout.
  // -----------------------------------------------------------------------
  const handleCreate = useCallback(
    async (input: ProductInput) => {
      setActionError(null);
      try {
        await upsertProduct(input);
        setMode({ kind: "idle" });
        await refresh();
      } catch (err) {
        // Re-throw so the form can show the error in its own ResultBanner
        // (the form is the action's surface; the list banner is for list ops).
        throw err;
      }
    },
    [refresh]
  );

  const handleUpdate = useCallback(
    async (input: ProductInput) => {
      setActionError(null);
      try {
        await upsertProduct(input);
        setMode({ kind: "idle" });
        await refresh();
      } catch (err) {
        throw err;
      }
    },
    [refresh]
  );

  const handleDelete = useCallback(
    async (barcode: string) => {
      setActionError(null);
      setConfirmingDelete(null);
      try {
        await deleteProduct(barcode);
        // If the deleted row was open for editing, close the form too.
        setMode((prev) =>
          prev.kind === "edit" && prev.product.barcode === barcode
            ? { kind: "idle" }
            : prev
        );
        await refresh();
      } catch (err) {
        setActionError(extractErrorMessage(err));
      }
    },
    [refresh]
  );

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <Panel
      title="Your shelf"
      description="The essentials your household restocks. Adding them here once means future purchase requests can be prefilled and compared across pack sizes for the best per-unit price."
      actions={
        <Button
          variant={mode.kind === "create" ? "secondary" : "primary"}
          onClick={() => setMode({ kind: "create" })}
          disabled={mode.kind === "create"}
        >
          <span aria-hidden="true">＋</span>
          Add product
        </Button>
      }
    >
      {/* Create form (above the list when open). */}
      {mode.kind === "create" && (
        <ProductOnboardingForm
          onSubmit={handleCreate}
          onCancel={() => setMode({ kind: "idle" })}
        />
      )}

      {/* Edit form (replaces the row being edited; shown above the list). */}
      {mode.kind === "edit" && (
        <ProductOnboardingForm
          initial={mode.product}
          onSubmit={handleUpdate}
          onCancel={() => setMode({ kind: "idle" })}
        />
      )}

      {/* List-level error banner (delete failures, etc.). */}
      {actionError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-50 dark:bg-rose-500/10 px-3 py-2.5 text-sm text-rose-700 dark:text-rose-200"
        >
          <p className="flex-1 break-words text-xs text-rose-700/90 dark:text-rose-200/90">
            {actionError}
          </p>
          <button
            type="button"
            onClick={() => setActionError(null)}
            aria-label="Dismiss"
            className="-mr-1 -mt-1 flex-shrink-0 rounded p-1 text-rose-700/70 dark:text-rose-200/70 transition hover:bg-white/10 hover:text-rose-800 dark:hover:text-rose-100"
          >
            ✕
          </button>
        </div>
      )}

      {/* First-load skeleton. Avoids flashing the empty state before
          IndexedDB resolves on a warm device. */}
      {loading && <ListSkeleton />}

      {/* Load failure (IndexedDB unavailable). */}
      {!loading && loadError && (
        <div className="rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 p-5 text-sm text-stone-600 dark:text-slate-300">
          <p className="font-medium text-stone-700 dark:text-slate-200">Couldn't open the shelf</p>
          <p className="mt-1 text-xs text-stone-500 dark:text-slate-400">{loadError}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => void refresh()}
          >
            Try again
          </Button>
        </div>
      )}

      {/* Empty state. Shown only on a successful load with zero products. */}
      {!loading &&
        !loadError &&
        products.length === 0 &&
        mode.kind === "idle" && (
          <EmptyState onAdd={() => setMode({ kind: "create" })} />
        )}

      {/* The list itself. */}
      {!loading && !loadError && products.length > 0 && (
        <ul className="flex flex-col gap-2">
          {products.map((product) => (
            <li key={product.barcode}>
              <ProductRow
                product={product}
                isEditing={
                  mode.kind === "edit" &&
                  mode.product.barcode === product.barcode
                }
                isConfirmingDelete={confirmingDelete === product.barcode}
                onEdit={() => setMode({ kind: "edit", product })}
                onCancelEdit={() => setMode({ kind: "idle" })}
                onAskDelete={() => setConfirmingDelete(product.barcode)}
                onCancelDelete={() => setConfirmingDelete(null)}
                onConfirmDelete={() => void handleDelete(product.barcode)}
              />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// ProductRow — one essentials row
// ---------------------------------------------------------------------------

type ProductRowProps = {
  product: ShelfProduct;
  isEditing: boolean;
  isConfirmingDelete: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
};

/**
 * A single shelf row: product identity + pack math on the left, actions on
 * the right. When its delete is confirming, the action slot swaps to a
 * two-button confirm so the user never destroys a record by mis-clicking.
 *
 * The row stays visible (just dimmed) while it's being edited, so the user
 * retains context for which record the open form is mutating.
 */
function ProductRow({
  product,
  isEditing,
  isConfirmingDelete,
  onEdit,
  onCancelEdit,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: ProductRowProps) {
  return (
    <div
      className={
        "flex flex-wrap items-center justify-between gap-3 rounded-lg border border-stone-200 dark:border-slate-800 bg-stone-50/60 dark:bg-slate-950/40 px-4 py-3 transition-opacity" +
        (isEditing ? " opacity-50" : "")
      }
    >
      {/* Identity + metadata. */}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium text-stone-800 dark:text-slate-100">
            {product.name}
          </span>
          {product.brand && (
            <span className="truncate text-xs text-stone-500 dark:text-slate-400">
              {product.brand}
            </span>
          )}
          {product.category && (
            <Badge className="bg-stone-200 dark:bg-slate-500/15 text-stone-600 dark:text-slate-300 ring-stone-400/30 dark:ring-slate-400/30">
              {product.category}
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-slate-500">
          <span>
            <span className="text-stone-600 dark:text-slate-300">{product.packUnits}</span>
            <span className="ml-1">
              {product.packUnits === 1 ? "unit" : "units"}
            </span>
            <span className="mx-1 text-stone-300 dark:text-slate-700">·</span>
            <span className="text-stone-600 dark:text-slate-300">
              {formatGrams(product.unitGrams)}
            </span>
            <span className="ml-1">per unit</span>
          </span>
          {product.defaultPriceLamports !== undefined && (
            <span>
              last{" "}
              <span className="text-stone-600 dark:text-slate-300">
                {formatSol(product.defaultPriceLamports)}
              </span>
            </span>
          )}
          <code
            className="font-mono text-[10px] text-stone-400 dark:text-slate-600"
            title="barcode / shelf id"
          >
            {product.barcode}
          </code>
        </div>
      </div>

      {/* Actions. */}
      <div className="flex shrink-0 items-center gap-2">
        {isConfirmingDelete ? (
          <>
            <span className="text-xs text-rose-600 dark:text-rose-300">Delete?</span>
            <Button variant="danger" size="sm" onClick={onConfirmDelete}>
              Delete
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelDelete}>
              Keep
            </Button>
          </>
        ) : isEditing ? (
          <Button variant="ghost" size="sm" onClick={onCancelEdit}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="sm" onClick={onEdit}>
              Edit
            </Button>
            <Button variant="ghost" size="sm" onClick={onAskDelete}>
              Delete
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// EmptyState + ListSkeleton
// ---------------------------------------------------------------------------

/** Friendly first-run state. One clear CTA; no clutter. */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed border-stone-300 dark:border-slate-700 bg-stone-50/50 dark:bg-slate-950/30 p-6">
      <p className="text-sm font-medium text-stone-700 dark:text-slate-200">Your shelf is empty</p>
      <p className="max-w-prose text-xs leading-relaxed text-stone-500 dark:text-slate-500">
        Add the things your household restocks — dish soap, rice, laundry pods,
        anything. Once they're on the shelf, future purchase requests can be
        prefilled and compared across pack sizes for the best per-unit price.
        The shelf lives on this device only.
      </p>
      <Button onClick={onAdd}>
        <span aria-hidden="true">＋</span>
        Add your first product
      </Button>
    </div>
  );
}

/** Three muted row placeholders shown during the first load. */
function ListSkeleton() {
  return (
    <ul className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <li
          key={i}
          className="h-[68px] animate-pulse rounded-lg border border-stone-200 dark:border-slate-800/70 bg-stone-50/50 dark:bg-slate-950/30"
        />
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Sort + display helpers
// ---------------------------------------------------------------------------

/**
 * Sort products by display name (case-insensitive), falling back to creation
 * order so two items with the same name stay stable.
 */
function byDisplayName(a: ShelfProduct, b: ShelfProduct): number {
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  if (aName < bName) return -1;
  if (aName > bName) return 1;
  return a.createdAt - b.createdAt;
}

/**
 * Render a unit weight for display. Whole numbers drop the decimal; fractions
 * keep up to two places (e.g. `500 g`, `12.5 g`).
 */
function formatGrams(unitGrams: number): string {
  // Round to 2 decimals to absorb float noise (e.g. 12.5 → 12.5, 500.0001 → 500),
  // then let Number→string drop trailing zeros (12.50 → "12.5", 500 → "500").
  const rounded = Math.round(unitGrams * 100) / 100;
  return `${rounded} g`;
}
