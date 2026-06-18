"use client";

// ProductOnboardingForm — create or edit a `ShelfProduct` (plan 006, Phase B).
//
// The shelf is the household's off-chain catalog of essentials. Every product
// needs at least three things to be useful for the best-value engine: a
// `name` (what it is), `packUnits` (how many units come in the pack), and
// `unitGrams` (the weight/volume of ONE unit, so two differently-sized packs
// can be compared on a per-gram basis — see `bestValue.ts`). Everything else
// (brand, category, default price, barcode) is optional metadata.
//
// Two modes over the same component:
//   - **Create**: every field editable, including an optional manual barcode
//     (B.4). If the barcode field is left blank on submit, a synthetic
//     `manual-<uuid>` is generated, so the shelf is fully usable on a desktop
//     with no camera. Phase C (camera) is deliberately not wired here.
//   - **Edit**: keyed off an existing `ShelfProduct`. The barcode is the
//     IndexedDB keyPath and is therefore read-only (changing it would orphan
//     the record); every other field is editable.
//
// Validation follows the calm-UX convention used by every instruction panel:
// empty required fields produce *no* error text (they just disable submit),
// while non-empty-but-invalid fields show a specific error. This avoids a red
// error flash the moment the form mounts.

import { useMemo, useState } from "react";
import { type ProductInput, type ShelfProduct } from "@/lib/shelf";
import { lamportsToSol, solToLamports } from "@/lib/format";
import { extractErrorMessage } from "@/lib/format";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { ResultBanner } from "@/components/ui/ResultBanner";

export type ProductOnboardingFormProps = {
  /**
   * When present, the form edits this product. When absent, the form creates
   * a new one. The presence/absence of this prop is fixed for the form's
   * lifetime — switching modes is the parent's job (it remounts the form).
   */
  initial?: ShelfProduct;
  /**
   * Prefill the barcode field in **create** mode (ignored when `initial` is
   * set). Used by the `/scan` flow (plan 006 Phase C): an unknown code is
   * scanned, then this form mounts with the code already filled in so the
   * user can finish onboarding without retyping it. Edit mode ignores this —
   * the barcode is the IndexedDB keyPath and is fixed once a product exists.
   */
  initialBarcode?: string;
  /**
   * Called with a validated {@link ProductInput} on submit. The parent owns
   * the actual `upsertProduct` call + list refresh so this component stays
   * focused on field state and validation. May throw; the error is surfaced
   * via the in-form {@link ResultBanner} and the form stays open.
   */
  onSubmit: (input: ProductInput) => Promise<void> | void;
  /** Abort the create/edit flow. The parent hides the form. */
  onCancel: () => void;
};

/**
 * Render the onboarding form. See {@link ProductOnboardingFormProps} for mode
 * semantics; the rest is field state, validation, and submit wiring.
 */
export function ProductOnboardingForm({
  initial,
  initialBarcode,
  onSubmit,
  onCancel,
}: ProductOnboardingFormProps) {
  const isEdit = Boolean(initial);

  // -----------------------------------------------------------------------
  // Field state. Inputs are strings (the source of truth); parsed numeric
  // values are derived via useMemo so validation and submit share one parse.
  // -----------------------------------------------------------------------
  // Create mode only: prefer an explicit `initialBarcode` (the /scan prefill)
  // over a blank field. Edit mode ignores it (the barcode is fixed below).
  const [barcodeInput, setBarcodeInput] = useState(
    initial?.barcode ?? initialBarcode ?? ""
  );
  const [name, setName] = useState(initial?.name ?? "");
  const [brand, setBrand] = useState(initial?.brand ?? "");
  const [packUnitsInput, setPackUnitsInput] = useState(
    initial ? String(initial.packUnits) : ""
  );
  const [unitGramsInput, setUnitGramsInput] = useState(
    initial ? String(initial.unitGrams) : ""
  );
  const [category, setCategory] = useState(initial?.category ?? "");
  const [defaultPriceInput, setDefaultPriceInput] = useState(
    initial?.defaultPriceLamports !== undefined
      ? lamportsToSol(initial.defaultPriceLamports)
      : ""
  );

  // Submit-side state.
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // -----------------------------------------------------------------------
  // Derived validation. Each memo returns `null` for "no error to show" —
  // either because the field is empty (required-ness is enforced via
  // `canSubmit`, not via red text) or because it parses cleanly.
  // -----------------------------------------------------------------------
  const packUnits = useMemo(
    () => parsePackUnits(packUnitsInput),
    [packUnitsInput]
  );
  const unitGrams = useMemo(
    () => parseUnitGrams(unitGramsInput),
    [unitGramsInput]
  );
  const defaultPriceLamports = useMemo<bigint | undefined>(() => {
    const trimmed = defaultPriceInput.trim();
    if (trimmed.length === 0) return undefined;
    const lamports = solToLamports(trimmed);
    return lamports ?? undefined;
  }, [defaultPriceInput]);

  const nameError = useMemo<string | null>(() => {
    // Name is required, but we only surface an error once the user has typed
    // something (and then cleared it to whitespace) — empty-on-mount stays
    // calm. The disabled submit covers the "still empty" case.
    if (name.trim().length === 0 && name.length > 0) return "Enter a name";
    return null;
  }, [name]);

  const packUnitsError = useMemo<string | null>(() => {
    if (packUnitsInput.trim().length === 0) return null;
    return packUnits === null ? "Enter a whole number of 1 or more" : null;
  }, [packUnitsInput, packUnits]);

  const unitGramsError = useMemo<string | null>(() => {
    if (unitGramsInput.trim().length === 0) return null;
    return unitGrams === null
      ? "Enter a weight greater than 0 (e.g. 500)"
      : null;
  }, [unitGramsInput, unitGrams]);

  const defaultPriceError = useMemo<string | null>(() => {
    if (defaultPriceInput.trim().length === 0) return null;
    return defaultPriceLamports === undefined
      ? "Enter a valid SOL amount (e.g. 0.05)"
      : null;
  }, [defaultPriceInput, defaultPriceLamports]);

  // -----------------------------------------------------------------------
  // Submit gating. Required fields must be present and valid; optional
  // fields, when filled, must be valid. `submitting` blocks re-entry.
  // -----------------------------------------------------------------------
  const canSubmit =
    name.trim().length > 0 &&
    packUnits !== null &&
    unitGrams !== null &&
    !nameError &&
    !packUnitsError &&
    !unitGramsError &&
    !defaultPriceError &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    // Barcode: on edit, fixed (it's the keyPath). On create, use the typed
    // value or fall back to a synthetic id so the shelf works with no camera.
    const barcode = isEdit
      ? initial!.barcode
      : barcodeInput.trim() || `manual-${generateId()}`;

    const input: ProductInput = {
      barcode,
      name: name.trim(),
      brand: brand.trim() || undefined,
      packUnits: packUnits!,
      unitGrams: unitGrams!,
      category: category.trim() || undefined,
      defaultPriceLamports,
    };

    setSubmitting(true);
    setSubmitError(null);
    try {
      await onSubmit(input);
      // Parent closes the form on success; nothing to do here.
    } catch (err) {
      setSubmitError(extractErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/40 p-4">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
          {isEdit ? "Edit product" : "Add a product to your shelf"}
        </h3>
        <p className="text-xs leading-relaxed text-slate-500">
          {isEdit
            ? "Update the details for this product. The barcode is fixed (it identifies the record)."
            : "Catalog an essential so the best-value engine can compare packs later. Name, pack size, and unit weight are required; everything else is optional."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Name"
          value={name}
          onChange={setName}
          placeholder="e.g. Dish soap"
          required
          autoFocus={!isEdit}
          error={nameError}
          onSubmit={handleSubmit}
          helpText="What the essential is — something your household restocks."
          className="sm:col-span-2"
        />

        <Field
          label="Brand"
          value={brand}
          onChange={setBrand}
          placeholder="e.g. Seventh Generation"
          helpText="Optional. Helps tell two similar items apart."
        />
        <Field
          label="Category"
          value={category}
          onChange={setCategory}
          placeholder="e.g. Cleaning"
          helpText="Optional free-text tag for grouping."
        />

        <Field
          label="Pack size"
          value={packUnitsInput}
          onChange={setPackUnitsInput}
          type="number"
          placeholder="e.g. 2"
          min={1}
          step={1}
          required
          error={packUnitsError}
          onSubmit={handleSubmit}
          helpText="How many units come in the pack (1, 2, 6, …)."
          suffix="units"
        />
        <Field
          label="Unit weight"
          value={unitGramsInput}
          onChange={setUnitGramsInput}
          type="number"
          placeholder="e.g. 500"
          min={0}
          step={0.1}
          required
          error={unitGramsError}
          onSubmit={handleSubmit}
          helpText="Weight or volume of ONE unit. Milliliters count as grams."
          suffix="g"
        />

        <Field
          label="Default price"
          value={defaultPriceInput}
          onChange={setDefaultPriceInput}
          type="number"
          placeholder="e.g. 0.05"
          min={0}
          step={0.0001}
          error={defaultPriceError}
          onSubmit={handleSubmit}
          helpText="Optional. Last-known price, used to prefill purchase requests."
          suffix="SOL"
        />

        {isEdit ? (
          <Field
            label="Barcode"
            value={initial!.barcode}
            onChange={() => {
              /* read-only: barcode is the keyPath */
            }}
            mono
            readOnly
            helpText="The barcode is fixed once a product exists."
          />
        ) : (
          <Field
            label="Barcode"
            value={barcodeInput}
            onChange={setBarcodeInput}
            placeholder="leave blank to auto-generate"
            mono
            onSubmit={handleSubmit}
            helpText="Optional. Type an EAN/UPC if you know it; otherwise a synthetic id is created so the shelf works with no camera."
          />
        )}
      </div>

      <ResultBanner
        pending={submitting}
        error={submitError}
        onDismiss={() => setSubmitError(null)}
      />

      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button
          onClick={handleSubmit}
          loading={submitting}
          disabled={!canSubmit}
        >
          {isEdit ? "Save changes" : "Add to shelf"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local parsers
//
// These are shelf-specific (positive integer for pack counts, positive
// decimal for unit weight) and return `null` for *both* empty and invalid
// input. The error-display memos above distinguish the two by checking the
// raw string length, matching the calm-UX pattern used across the panels.
// ---------------------------------------------------------------------------

/**
 * Parse a positive integer (≥ 1) from a trimmed string.
 *
 * Returns `null` for empty, non-numeric, decimal, zero, or negative input.
 * Pack counts are whole numbers; rejecting decimals here avoids a confusing
 * failure later when the best-value engine multiplies by it.
 */
function parsePackUnits(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/**
 * Parse a positive number (> 0) from a trimmed string. Decimals are allowed
 * (e.g. `12.5`), matching how `bestValue.ts` handles fractional unit weights
 * via milligram scaling.
 *
 * Returns `null` for empty, non-numeric, zero, or negative input.
 */
function parseUnitGrams(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Generate a synthetic barcode id for camera-less entry.
 *
 * Uses `crypto.randomUUID()` (available in modern browsers and the Node 22
 * runtime Next 15 targets) and prefixes it with `manual-` so manual entries
 * are distinguishable from real EAN/UPC scans at a glance.
 */
function generateId(): string {
  // `crypto` is global in the browser; guard for the unlikely case of an
  // older context so the form degrades (falls back to a timestamp-based id)
  // rather than throwing on submit.
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") {
    return `manual-${c.randomUUID()}`;
  }
  return `manual-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}
