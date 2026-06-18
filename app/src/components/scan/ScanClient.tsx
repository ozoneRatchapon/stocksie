"use client";

// ScanClient — orchestrator for the `/scan` route (plan 006, Phase C).
//
// This is the client-only body of the page. It owns the off-chain scan flow:
//
//   scan ──── findByBarcode(code) ──── found product ──→ product card
//     ▲                                   │                 │
//     │                                   └── unknown ──→ onboarding form
//     │                                                     │ (prefilled barcode)
//     │                                                     │
//     └────────────────── "Scan another" ◀─────────────────┘
//
// Two ways to produce a code:
//   1. Camera: <BarcodeScanner onScan={...} /> (the heavy `html5-qrcode` dep
//      is dynamically imported by the route shell, so this whole client tree
//      is client-only and absent from the `/` and `/shelf` First Load).
//   2. Manual entry: a typed code is treated identically to a scan — same
//      lookup, same outcome branches. This is the always-available path for
//      desktops, denied cameras, and insecure contexts (see Q5 graceful
//      fallback in plan 006 §5 Phase C).
//
// The shelf is strictly off-chain (plan 006 §2): scanning and lookup touch
// only IndexedDB. No wallet connection is required to scan or onboard a
// product. When a known product is shown, the CTA routes to `/` (Dashboard),
// where the wallet prompt lives for actually starting a purchase.

import { useCallback, useState } from "react";
import Link from "next/link";
import {
  findByBarcode,
  upsertProduct,
  type ProductInput,
  type ShelfProduct,
} from "@/lib/shelf";
import { extractErrorMessage, formatSol } from "@/lib/format";
import { BarcodeScanner } from "./BarcodeScanner";
import { ProductOnboardingForm } from "@/components/shelf/ProductOnboardingForm";
import { Field } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";

/**
 * The page's phase. Two phases:
 *   - `scan`   — scanner + manual entry; no outcome yet.
 *   - `result` — we resolved a code to either a known product (show the card)
 *                or to an unknown code (show the onboarding form prefilled).
 *
 * After a successful onboarding submit, we flip the unknown branch to a known
 * product card so the user sees the just-created record.
 */
type Phase =
  | { kind: "scan" }
  | { kind: "result"; code: string; product: ShelfProduct | null };

export function ScanClient() {
  const [phase, setPhase] = useState<Phase>({ kind: "scan" });
  // Set when the last lookup/onboarding failed, so the user can see what went
  // wrong without losing their place in the flow. Cleared on next scan.
  const [lookupError, setLookupError] = useState<string | null>(null);
  // Manual-entry field state. Treated identically to a camera scan on submit.
  const [manualCode, setManualCode] = useState("");

  // -------------------------------------------------------------------------
  // resolveCode — shared path for camera scans and manual entry. Looks the
  // code up in the shelf; if found, shows the product card; if not, shows the
  // onboarding form prefilled with the code.
  // -------------------------------------------------------------------------
  const resolveCode = useCallback(async (code: string) => {
    const trimmed = code.trim();
    if (trimmed.length === 0) return;
    setLookupError(null);
    try {
      const product = await findByBarcode(trimmed);
      setPhase({ kind: "result", code: trimmed, product: product ?? null });
    } catch (err) {
      // IndexedDB itself was unavailable (private mode, SSR, etc.). Surface
      // it but stay on the scan phase so the user can retry.
      setLookupError(extractErrorMessage(err));
    }
  }, []);

  const handleScan = useCallback(
    (code: string) => {
      void resolveCode(code);
    },
    [resolveCode],
  );

  const handleManualSubmit = useCallback(() => {
    void resolveCode(manualCode);
  }, [manualCode, resolveCode]);

  // -------------------------------------------------------------------------
  // Onboarding submit (unknown-code branch). Persist the new product, then
  // flip to the product-card view for the just-created record so the user
  // sees confirmation. Re-thrown errors stay in the form's own ResultBanner.
  // -------------------------------------------------------------------------
  const handleOnboard = useCallback(
    async (input: ProductInput) => {
      const saved = await upsertProduct(input);
      setPhase({ kind: "result", code: saved.barcode, product: saved });
    },
    [],
  );

  const handleScanAnother = useCallback(() => {
    setPhase({ kind: "scan" });
    setLookupError(null);
    setManualCode("");
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (phase.kind === "result") {
    return (
      <ResultView
        code={phase.code}
        product={phase.product}
        onScanAnother={handleScanAnother}
        onOnboard={handleOnboard}
      />
    );
  }

  return (
    <Panel
      title="Scan a product"
      description="Point your camera at a barcode, or type one by hand. If it's already on your shelf we'll show it; if not, you can add it in a few seconds."
    >
      <div className="flex flex-col gap-6">
        {/* Camera scanner. The whole BarcodeScanner subtree is loaded
            client-side only (see the route shell), so this never runs on the
            server and the html5-qrcode dep stays out of the main bundle. */}
        <BarcodeScanner onScan={handleScan} />

        {/* Manual entry — the always-available fallback for desktops, denied
            cameras, and insecure contexts. A typed code follows the exact
            same lookup path as a camera scan. */}
        <div className="flex flex-col gap-2 border-t border-slate-800 pt-5">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            Or type a barcode
          </p>
          <Field
            label="Barcode"
            value={manualCode}
            onChange={setManualCode}
            placeholder="e.g. 038000138416"
            mono
            onSubmit={handleManualSubmit}
            helpText="EAN/UPC digits from the product's packaging. Treated the same as a camera scan."
          />
          <div>
            <Button
              variant="secondary"
              onClick={handleManualSubmit}
              disabled={manualCode.trim().length === 0}
            >
              Look up
            </Button>
          </div>
        </div>

        {lookupError && (
          <div
            role="alert"
            className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200"
          >
            {lookupError}
          </div>
        )}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// ResultView — what we show after a code is resolved
// ---------------------------------------------------------------------------

type ResultViewProps = {
  code: string;
  product: ShelfProduct | null;
  onScanAnother: () => void;
  onOnboard: (input: ProductInput) => Promise<void>;
};

function ResultView({
  code,
  product,
  onScanAnother,
  onOnboard,
}: ResultViewProps) {
  if (product) {
    return (
      <Panel
        title="On your shelf"
        description="This barcode matches a product you've already cataloged. Start a purchase from the dashboard, or scan another."
        actions={
          <Button variant="secondary" onClick={onScanAnother}>
            <span aria-hidden="true">↺</span>
            Scan another
          </Button>
        }
      >
        <ProductCard product={product} />
      </Panel>
    );
  }

  // Unknown barcode → onboarding form prefilled with the code.
  return (
    <Panel
      title="Not on your shelf yet"
      description={`Barcode ${code} isn't in this device's shelf. Add it now so future scans recognize it and the best-value engine can compare its pack size.`}
      actions={
        <Button variant="ghost" onClick={onScanAnother}>
          <span aria-hidden="true">↺</span>
          Scan a different code
        </Button>
      }
    >
      <ProductOnboardingForm
        initialBarcode={code}
        onSubmit={onOnboard}
        onCancel={onScanAnother}
      />
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// ProductCard — a found product's identity + pack math + dashboard CTA
// ---------------------------------------------------------------------------

function ProductCard({ product }: { product: ShelfProduct }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-slate-800 bg-slate-950/40 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-base font-medium text-slate-100">
              {product.name}
            </span>
            {product.brand && (
              <span className="truncate text-xs text-slate-400">
                {product.brand}
              </span>
            )}
            {product.category && (
              <Badge className="bg-slate-500/15 text-slate-300 ring-slate-400/30">
                {product.category}
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
            <span>
              <span className="text-slate-300">{product.packUnits}</span>
              <span className="ml-1">
                {product.packUnits === 1 ? "unit" : "units"}
              </span>
              <span className="mx-1 text-slate-700">·</span>
              <span className="text-slate-300">
                {formatGrams(product.unitGrams)}
              </span>
              <span className="ml-1">per unit</span>
            </span>
            {product.defaultPriceLamports !== undefined && (
              <span>
                last{" "}
                <span className="text-slate-300">
                  {formatSol(product.defaultPriceLamports)}
                </span>
              </span>
            )}
            <code
              className="font-mono text-[10px] text-slate-600"
              title="barcode / shelf id"
            >
              {product.barcode}
            </code>
          </div>
        </div>
      </div>

      {/* CTA: route to the dashboard, where the purchase form lives. Scanning
          is off-chain, but starting a purchase needs a connected wallet. */}
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/"
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-500 px-4 text-sm font-medium text-slate-950 transition-colors hover:bg-emerald-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400"
        >
          <span aria-hidden="true">🛒</span>
          Start a purchase
        </Link>
        <p className="text-xs text-slate-500">
          Opens your dashboard — sign in there to spend against the household
          budget.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a unit weight for display. Whole numbers drop the decimal; fractions
 * keep up to two places (e.g. `500 g`, `12.5 g`). Mirrors the helper in
 * ShelfList so the shelf and the scanner render weights identically.
 */
function formatGrams(unitGrams: number): string {
  const rounded = Math.round(unitGrams * 100) / 100;
  return `${rounded} g`;
}
