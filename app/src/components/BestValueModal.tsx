"use client";

// BestValueModal — compare 2+ offers for an essential and pick one (plan 006, D.1).
//
// This is the user-facing surface of the best-value engine: the user assembles
// a few offers (pulled from the shelf, or typed by hand), the modal ranks them
// live by price-per-unit via `compareOffers`, and the user picks one with "Use
// this". The choice is returned to the parent as a {@link BestValueChoice},
// which carries BOTH:
//
//   - `text` — a human-readable, deterministic summary that the parent writes
//     into the "Best-value snapshot" / "Actual unit cost" field. That field is
//     then hashed via `toHash32` and sent on-chain, exactly as before (the
//     hash-to-chain path is unchanged — D.2).
//   - structured fields (`priceLamports`, `perUnitLamports`, …) that the parent
//     stashes client-side via `pendingSnapshots` so Phase E can score a saving
//     after restock without ever reading prices off the chain (D.3 / §4.5).
//
// Why off-chain (plan 006 §3): the chain stores only `blake3(snapshotText)`,
// not the cleartext, so the chain cannot compare prices. The ranking runs here
// in JS against the cleartext the user just typed.
//
// The modal is self-contained: it loads the shelf on open, manages its own
// offer drafts, and resets them on each open so a fresh compare starts clean.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compareOffers, type Offer, type RankedOffer } from "@/lib/bestValue";
import { listProducts, type ShelfProduct } from "@/lib/shelf";
import { lamportsToSol, solToLamports, formatSol } from "@/lib/format";
import { extractErrorMessage } from "@/lib/format";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/cn";

/** The chosen offer, handed back to the parent. See file header for semantics. */
export type BestValueChoice = {
  /** Deterministic, human-readable summary. The parent hashes this on-chain. */
  text: string;
  /** Short label of the chosen offer (e.g. the product name + pack). */
  label: string;
  /** Total price of the chosen offer, in lamports. */
  priceLamports: bigint;
  /** Lamports per gram — the exact ranking basis from `compareOffers`. */
  perUnitLamports: bigint;
  /** Pack size of the chosen offer. */
  packUnits: number;
  /** Unit weight of the chosen offer. */
  unitGrams: number;
};

export type BestValueModalProps = {
  open: boolean;
  onClose: () => void;
  /** Called with the chosen offer. The parent back-fills its snapshot field
   *  and stashes the structured data for later scoring. */
  onChoose: (choice: BestValueChoice) => void;
};

/** One editable offer being assembled. Identified by `id` for stable keys. */
type Draft = {
  id: string;
  /** Shelf product FK when this draft was seeded from the shelf. */
  productId?: string;
  label: string;
  /** SOL amount as typed. Parsed via `solToLamports`. */
  priceInput: string;
  /** Pack count as typed. Parsed to a positive integer. */
  packInput: string;
  /** Unit weight as typed. Parsed to a positive number. */
  gramsInput: string;
};

/** A draft parsed into a valid `Offer`, paired with its source draft id. */
type ParsedDraft = {
  draftId: string;
  offer: Offer;
  priceLamports: bigint;
  packUnits: number;
  unitGrams: number;
};

export function BestValueModal({
  open,
  onClose,
  onChoose,
}: BestValueModalProps) {
  // Shelf products (for the "add from shelf" picker). Loaded on open.
  const [shelf, setShelf] = useState<ShelfProduct[]>([]);
  const [shelfLoading, setShelfLoading] = useState(false);
  const [shelfError, setShelfError] = useState<string | null>(null);

  // Offer drafts. Seeded with a single blank manual draft on open so the user
  // has somewhere to start. `nextIdRef` hands out stable ids for React keys.
  const [drafts, setDrafts] = useState<Draft[]>([blankDraft("d0")]);
  const nextIdRef = useRef(1);

  // Reset to a clean compare every time the modal opens, and load the shelf.
  useEffect(() => {
    if (!open) return;
    nextIdRef.current = 1;
    setDrafts([blankDraft("d0")]);
    setShelfLoading(true);
    setShelfError(null);
    listProducts()
      .then((list) => {
        list.sort(byName);
        setShelf(list);
      })
      .catch((err) => setShelfError(extractErrorMessage(err)))
      .finally(() => setShelfLoading(false));
  }, [open]);

  // -----------------------------------------------------------------------
  // Parse + rank. `parsed` holds the valid drafts; `ranked` is their ordering
  // by per-unit price. Both are memoized over `drafts` so typing recomputes
  // once per change. compareOffers is safe to call here because every offer in
  // `parsed` has already been validated to have positive price/pack/grams.
  // -----------------------------------------------------------------------
  const parsed = useMemo<ParsedDraft[]>(
    () => drafts.map(parseDraft).filter((p): p is ParsedDraft => p !== null),
    [drafts]
  );
  const rankedByDraftId = useMemo<Map<string, RankedOffer>>(() => {
    const map = new Map<string, RankedOffer>();
    if (parsed.length === 0) return map;
    const ranked = compareOffers(parsed.map((p) => p.offer));
    for (const r of ranked) {
      // `offer.productId` carries the draft id (see parseDraft); reuse it to
      // map each ranked result back to its source draft.
      map.set(r.productId, r);
    }
    return map;
  }, [parsed]);

  // -----------------------------------------------------------------------
  // Draft mutations
  // -----------------------------------------------------------------------
  const updateDraft = useCallback((id: string, patch: Partial<Draft>) => {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, ...patch } : d))
    );
  }, []);

  const removeDraft = useCallback((id: string) => {
    setDrafts((prev) =>
      prev.length > 1 ? prev.filter((d) => d.id !== id) : prev
    );
  }, []);

  const addManualDraft = useCallback(() => {
    const id = `d${nextIdRef.current++}`;
    setDrafts((prev) => [...prev, blankDraft(id)]);
  }, []);

  const addFromShelf = useCallback((product: ShelfProduct) => {
    const id = `d${nextIdRef.current++}`;
    setDrafts((prev) => [
      ...prev,
      {
        id,
        productId: product.barcode,
        label: productLabel(product),
        priceInput: product.defaultPriceLamports
          ? lamportsToSol(product.defaultPriceLamports)
          : "",
        packInput: String(product.packUnits),
        gramsInput: String(product.unitGrams),
      },
    ]);
  }, []);

  const handleChoose = useCallback(
    (draftId: string) => {
      const ranked = rankedByDraftId.get(draftId);
      const p = parsed.find((x) => x.draftId === draftId);
      if (!ranked || !p) return;
      onChoose({
        text: snapshotText(
          p.offer.label,
          p.priceLamports,
          p.packUnits,
          p.unitGrams
        ),
        label: p.offer.label,
        priceLamports: p.priceLamports,
        perUnitLamports: ranked.perUnitLamports,
        packUnits: p.packUnits,
        unitGrams: p.unitGrams,
      });
    },
    [onChoose, parsed, rankedByDraftId]
  );

  const validCount = rankedByDraftId.size;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Compare prices"
      description="Add two or more offers — from your shelf or typed in — and we'll rank them by price per unit so you can pick the real best value. Nothing here leaves this device."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </>
      }
    >
      {/* ----------------------------------------------------------------- */}
      {/* Add-offer controls                                                */}
      {/* ----------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <AddFromShelf
          shelf={shelf}
          loading={shelfLoading}
          error={shelfError}
          onPick={addFromShelf}
        />
        <Button variant="secondary" size="sm" onClick={addManualDraft}>
          <span aria-hidden="true">＋</span>
          Add manual offer
        </Button>
      </div>

      {validCount < 2 && (
        <p className="mt-3 text-xs text-stone-500 dark:text-slate-500">
          {validCount === 0
            ? "Enter a label, a price, and the pack size + unit weight for each offer. The best value is the cheapest per unit, not per pack."
            : "Add at least one more valid offer to see the ranking."}
        </p>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* Offer drafts (ranked inline when comparable)                      */}
      {/* ----------------------------------------------------------------- */}
      <ul className="mt-4 flex flex-col gap-3">
        {drafts.map((draft) => {
          const ranked = rankedByDraftId.get(draft.id);
          return (
            <li key={draft.id}>
              <DraftRow
                draft={draft}
                ranked={ranked}
                rankedCount={validCount}
                onChange={(patch) => updateDraft(draft.id, patch)}
                onRemove={() => removeDraft(draft.id)}
                canRemove={drafts.length > 1}
                onChoose={() => handleChoose(draft.id)}
              />
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// DraftRow — one editable offer, with its live rank/per-unit if valid
// ---------------------------------------------------------------------------

type DraftRowProps = {
  draft: Draft;
  ranked: RankedOffer | undefined;
  rankedCount: number;
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
  canRemove: boolean;
  onChoose: () => void;
};

function DraftRow({
  draft,
  ranked,
  rankedCount,
  onChange,
  onRemove,
  canRemove,
  onChoose,
}: DraftRowProps) {
  const isValid = Boolean(ranked);
  return (
    <div
      className={cn(
        "rounded-lg border bg-stone-50/60 dark:bg-slate-950/40 p-3",
        ranked?.isBest ? "border-emerald-500/50" : "border-stone-200 dark:border-slate-800"
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {ranked && rankedCount >= 2 && (
            <Badge
              className={cn(
                ranked.isBest
                  ? "bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300 ring-emerald-500/30"
                  : "bg-stone-300/40 dark:bg-slate-600/20 text-stone-600 dark:text-slate-300 ring-stone-400/30 dark:ring-slate-500/30"
              )}
            >
              {ranked.isBest ? "Best value" : `#${ranked.rank}`}
            </Badge>
          )}
          {draft.productId && (
            <Badge className="bg-sky-50 dark:bg-sky-500/15 text-sky-600 dark:text-sky-300 ring-sky-500/30">
              from shelf
            </Badge>
          )}
        </div>
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label="Remove offer"
            className="rounded p-1 text-stone-500 dark:text-slate-500 transition hover:bg-white dark:hover:bg-slate-800 hover:text-stone-600 dark:hover:text-slate-300"
          >
            ✕
          </button>
        )}
      </div>

      <div className="mt-2 grid gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-slate-500">
            Label
          </span>
          <input
            type="text"
            value={draft.label}
            onChange={(e) => onChange({ label: e.target.value })}
            placeholder='e.g. "Dish soap, 2-pack"'
            spellCheck={false}
            className="w-full rounded-lg border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 px-3 py-2 text-sm text-stone-800 dark:text-slate-100 outline-none transition placeholder:text-stone-400 dark:placeholder:text-slate-600 focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-slate-500">
            Price
          </span>
          <input
            type="number"
            value={draft.priceInput}
            onChange={(e) => onChange({ priceInput: e.target.value })}
            placeholder="0.05"
            min={0}
            step={0.0001}
            className="w-full rounded-lg border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 px-3 py-2 text-sm text-stone-800 dark:text-slate-100 outline-none transition placeholder:text-stone-400 dark:placeholder:text-slate-600 focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-slate-500">
              Pack
            </span>
            <input
              type="number"
              value={draft.packInput}
              onChange={(e) => onChange({ packInput: e.target.value })}
              placeholder="2"
              min={1}
              step={1}
              className="w-full rounded-lg border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 px-3 py-2 text-sm text-stone-800 dark:text-slate-100 outline-none transition placeholder:text-stone-400 dark:placeholder:text-slate-600 focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium uppercase tracking-wide text-stone-500 dark:text-slate-500">
              g / unit
            </span>
            <input
              type="number"
              value={draft.gramsInput}
              onChange={(e) => onChange({ gramsInput: e.target.value })}
              placeholder="500"
              min={0}
              step={0.1}
              className="w-full rounded-lg border border-stone-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 px-3 py-2 text-sm text-stone-800 dark:text-slate-100 outline-none transition placeholder:text-stone-500 dark:placeholder:text-slate-500 focus:border-emerald-500/70 focus:ring-1 focus:ring-emerald-500/40"
            />
          </label>
        </div>
      </div>

      {/* Computed per-unit + actions, shown once the draft is a valid offer. */}
      {isValid && ranked && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-stone-200 dark:border-slate-800/70 pt-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500 dark:text-slate-400">
            <span>
              <span className="text-stone-500 dark:text-slate-500">total</span>{" "}
              <span className="text-stone-700 dark:text-slate-200">
                {formatSol(ranked.priceLamports)}
              </span>
            </span>
            <span>
              <span className="text-stone-500 dark:text-slate-500">per unit</span>{" "}
              <span className="text-stone-700 dark:text-slate-200">
                {ranked.perUnitLamportsRounded.toLocaleString()} lamports/g
              </span>
            </span>
            {rankedCount >= 2 && !ranked.isBest && (
              <span className="text-amber-600/90 dark:text-amber-300/90">
                {ranked.savingsPctVsBest.toFixed(0)}% pricier than best
              </span>
            )}
          </div>
          <Button size="sm" onClick={onChoose}>
            Use this
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AddFromShelf — pick a shelf product to seed a draft
// ---------------------------------------------------------------------------

function AddFromShelf({
  shelf,
  loading,
  error,
  onPick,
}: {
  shelf: ShelfProduct[];
  loading: boolean;
  error: string | null;
  onPick: (product: ShelfProduct) => void;
}) {
  if (loading) {
    return <span className="text-xs text-stone-500 dark:text-slate-500">Loading your shelf…</span>;
  }
  if (error) {
    return (
      <span className="text-xs text-rose-600/80 dark:text-rose-400/80" title={error}>
        Shelf unavailable — use manual offers.
      </span>
    );
  }
  if (shelf.length === 0) {
    return (
      <span className="text-xs text-stone-500 dark:text-slate-500">
        Your shelf is empty — add products on the{" "}
        <span className="text-stone-500 dark:text-slate-400">Shelf</span> page to compare them here.
      </span>
    );
  }
  return (
    <label className="flex items-center gap-2 text-xs text-stone-500 dark:text-slate-400">
      <span className="font-medium uppercase tracking-wide text-stone-500 dark:text-slate-500">
        From shelf
      </span>
      <select
        // Value is reset to "" after onChange so the same product can be picked
        // twice (e.g. to enter two store prices for one product).
        value=""
        onChange={(e) => {
          const barcode = e.target.value;
          const product = shelf.find((p) => p.barcode === barcode);
          if (product) onPick(product);
        }}
        className="h-8 rounded-md border border-stone-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-2 text-xs text-stone-800 dark:text-slate-100 outline-none transition focus:border-emerald-500/70"
      >
        <option value="">Add a product…</option>
        {shelf.map((p) => (
          <option key={p.barcode} value={p.barcode}>
            {productLabel(p)}
          </option>
        ))}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A blank manual draft. */
function blankDraft(id: string): Draft {
  return { id, label: "", priceInput: "", packInput: "", gramsInput: "" };
}

/**
 * Parse a draft into a valid `Offer` (with its draft id as `productId`), or
 * `null` if any field is missing/invalid. Mirrors the validation in the
 * onboarding form: positive integer pack, positive (possibly fractional)
 * unit weight, positive SOL price.
 */
function parseDraft(draft: Draft): ParsedDraft | null {
  const label = draft.label.trim();
  if (label.length === 0) return null;

  const priceLamports = solToLamports(draft.priceInput);
  if (priceLamports === null || priceLamports <= 0n) return null;

  const packUnits = parsePackUnits(draft.packInput);
  if (packUnits === null) return null;

  const unitGrams = parseUnitGrams(draft.gramsInput);
  if (unitGrams === null) return null;

  return {
    draftId: draft.id,
    offer: { productId: draft.id, label, priceLamports, packUnits, unitGrams },
    priceLamports,
    packUnits,
    unitGrams,
  };
}

/** Positive integer (≥ 1). `null` on empty / non-numeric / decimal / zero. */
function parsePackUnits(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/** Positive number (> 0), decimals allowed. `null` on empty / invalid / zero. */
function parseUnitGrams(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/** Human-readable label for a shelf product (name + brand if present). */
function productLabel(p: ShelfProduct): string {
  return p.brand ? `${p.name} — ${p.brand}` : p.name;
}

/** Deterministic snapshot text that gets hashed on-chain. */
function snapshotText(
  label: string,
  priceLamports: bigint,
  packUnits: number,
  unitGrams: number
): string {
  return `${label} · ${lamportsToSol(
    priceLamports
  )} SOL · ${packUnits}×${unitGrams}g`;
}

/** Case-insensitive name sort for the shelf picker. */
function byName(a: ShelfProduct, b: ShelfProduct): number {
  const aName = a.name.toLowerCase();
  const bName = b.name.toLowerCase();
  return aName < bName ? -1 : aName > bName ? 1 : 0;
}
