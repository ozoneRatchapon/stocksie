# Plan 006 — Off-chain Inventory Layer + Best-Value Engine

> **Status:** DRAFT — awaiting PO approval. Not started. Per the cross-phase rule
> "plan leads, code follows," no code is written until this plan is approved.

## 1. Context

This plan exists for two converging reasons:

1. **The landing reframe (plan 005 §4c) exposed an honesty gap.** The "Smart
   buying" card is shown with a `Coming soon` badge because the cheap-vs-expensive
   comparison engine — the PO's stated headline feature (#3 of 5 in the README) —
   is **not built**. Only the on-chain hook exists: two `unit_cost_hash` (blake3)
   capture points + a reserved `REWARD_COST_SAVING` (50 pts) constant with no
   handler. See `docs/INSTRUCTIONS.md` "Honest note." This was Path B of the
   recommended Path C (A now → B next); Path A landed in commit `f957bef`.

2. **Presenter requirements added an off-chain inventory layer.** A presenter
   proposed: (a) a barcode scanner + household "shelf" DB, (b) a new-product
   onboarding form for unknown barcodes, (c) a price-per-unit comparison tool.
   These are **net-new** — they appear in no existing doc. The presenter summary
   referenced a `system_flows.md` file; **that file does not exist** in the repo
   (verified via `fd`), so these requirements are captured here for the first
   time.

Items (1) and (2) are the same product story: the off-chain shelf DB feeds the
best-value engine, which surfaces a recommendation in the purchase flow and
rewards the buyer when a saving is realized. Building them together removes the
landing's "Coming soon" badge honestly.

## 2. Scope & boundaries (NON-NEGOTIABLE)

### What this plan IS
- **100% off-chain / client-side.** No Rust program changes. No new on-chain
  instruction, no account resize, no migration.
- **Privacy-boundary-respecting.** Per `docs/ROADMAP.md` §4 and
  `docs/PRIVACY.md`, **on-chain item catalogs are explicitly out of scope.** All
  item names, weights, barcodes, and prices stay in **IndexedDB on the client**.
  The chain only ever receives the existing `blake3` hashes via the existing
  capture points — it never learns *what* you buy or *how much* it costs in
  cleartext.
- **Reads existing hooks, doesn't move them.** The `unit_cost_hash` capture
  points in `create_purchase_request` ("Best-value snapshot") and
  `confirm_restock` ("Actual unit cost") already exist in
  `app/src/components/panels/PurchasePanel.tsx`. This plan consumes their
  off-chain cleartext; it does not alter the on-chain call signatures.

### What this plan is NOT (explicitly out of scope)
- ❌ Any on-chain item/price catalog (privacy violation — `ROADMAP.md` §4).
- ❌ Cross-device sync of the shelf DB (a server / sync layer is a later
  horizon; this plan is per-device IndexedDB only).
- ❌ Buyer self-claim of `REWARD_COST_SAVING`. The existing `award_reward` is
  Owner/Parent-only (manual grant). Auto-granting on the buyer's own signature
  would need a new on-chain instruction — deferred (see §6 open question Q3).
- ❌ SMS, Blinks/Actions, AI receipt OCR, predictive refill — these are
  `ROADMAP.md` §2, separate and larger scope.

## 3. Key design fact (must be understood before reading §4)

**The on-chain `unit_cost_hash` is a tamper-evidence PIN, not the data source.**

The chain stores `blake3(priceText)` — a 32-byte hash that cannot be reversed.
Therefore the best-value engine **cannot read prices from the chain**. It reads
the **off-chain cleartext** that the client already holds at the moment of entry
(the same cleartext that was hashed before sending). The hashes exist so that,
later, anyone can re-hash the off-chain record and prove it matches what was
committed — they are an audit trail, not a database.

Consequence: the comparison logic runs **client-side, in JavaScript**, against
data in IndexedDB and in-memory form state. No RPC round-trip is needed to score
a saving.

## 4. Architecture

### 4.1 Data model (IndexedDB, per-device)

Database `stocksie-shelf`, version 1, one object store:

```
products  (keyPath: "barcode")
  barcode:           string            // EAN/UPC, or synthetic for manual entry
  name:              string            // "Dish soap"
  brand?:            string            // "Seventh Generation"
  packUnits:         number            // number of items in the pack (1, 2, 6...)
  unitGrams:         number            // weight/volume of ONE unit, in grams (or ml-as-grams)
  defaultPriceLamports?: bigint        // last-known SOL price, for prefill
  category?:         string            // free tag for grouping
  createdAt:         number            // epoch ms
  updatedAt:         number            // epoch ms
```

Design notes:
- `unitGrams` + `packUnits` are what make price-per-unit possible. Both required
  at onboarding (the form blocks otherwise).
- Prices are **not** stored long-term on the product by default (they vary by
  store/date). `defaultPriceLamports` is a prefill convenience only. The two
  prices that matter for scoring live on the **purchase request** in client
  state, not on the product.
- `barcode` may be synthetic (`manual-<uuid>`) for items without a scannable
  code, so the shelf works without a camera.

### 4.2 New modules (`app/src/lib/`)

| File | Responsibility | Purity |
|---|---|---|
| `db.ts` | Open IndexedDB (`idb` wrapper), expose `getDb()`. Object-store schema + migration headroom (bump version). | Side-effectful (IO), but single entry point. |
| `shelf.ts` | Domain CRUD over `db.ts`: `getProduct`, `upsertProduct`, `listProducts`, `deleteProduct`, `findByBarcode`. | Calls `db.ts`. |
| `bestValue.ts` | **Pure** price-per-unit engine: `compareOffers(offers) → RankedOffer[]`. No IO. Fully unit-testable. | Pure. |

`bestValue.ts` core type (pure, no React, no Anchor):

```ts
export type Offer = {
  productId: string;            // shelf FK
  label: string;                // "2-pack, 500ml"
  priceLamports: bigint;
  packUnits: number;            // from the product
  unitGrams: number;            // from the product
};

export type RankedOffer = Offer & {
  perUnitLamports: bigint;      // priceLamports / (packUnits * unitGrams) ... see §4.4
  perUnitLamportsRounded: number;
  rank: number;                 // 1 = cheapest per unit
  savingsPctVsBest: number;     // 0 for the best; >0 for the rest
  isBest: boolean;
};

export function compareOffers(offers: Offer[]): RankedOffer[];
```

### 4.3 New UI (`app/src/`)

| File | Responsibility |
|---|---|
| `app/scan/page.tsx` | Route `/scan`. Camera scanner (`html5-qrcode`) with a manual-entry fallback for desktop / no-camera / permission-denied. On a hit → lookup in shelf → branch (known: add-to-list / unknown: onboarding form). |
| `components/shelf/ShelfList.tsx` | Browse/edit the shelf DB. |
| `components/shelf/ProductOnboardingForm.tsx` | The form for an unknown barcode (name, brand, packUnits, unitGrams, category). Blocks until required fields are valid. |
| `components/BestValueModal.tsx` | Compare two+ offers for the same essential. Shows per-unit price, ranks them, marks the best, shows savings %. Feeds the chosen offer's snapshot into the purchase form. |

### 4.4 Price-per-unit arithmetic

`perUnitLamports = priceLamports / (packUnits × unitGrams)`. Lamports are
integers; we keep `perUnitLamports` as a `bigint` floor for exact comparison,
and expose `perUnitLamportsRounded` (number, for display). Ties broken by lower
absolute price. **No floating point in the ranking** — only in display layer.

### 4.5 `REWARD_COST_SAVING` wiring (the honest part)

The reserved constant `REWARD_COST_SAVING = 50` (defined in Rust
`constants.rs`; mirror in `app/src/lib/constants.ts` — **verify the TS side has
it, add if missing**). The scoring flow:

1. At `create_purchase_request`: user enters "Best-value snapshot" text → hashed
   on chain via `toHash32`; **cleartext kept in client state** (the offer they
   picked as the benchmark).
2. At `confirm_restock`: buyer enters actual unit cost → hashed on chain;
   **cleartext kept in client state**.
3. Immediately after a successful `confirm_restock`, the **observer's client**
   (whoever is online — typically the Owner/Parent in the loop for
   reimbursement) computes:
   - `saving = snapshotPerUnit - actualPerUnit` (off-chain, off the cleartext).
   - If `saving > 0` (buyer beat or matched the snapshot), fire the **existing**
     `award_reward(buyerMember, REWARD_COST_SAVING, reasonHash)` instruction.
   - `reasonHash = toHash32("cost-saving:<productId>:<savingLamports>")` for
     audit.
4. This requires **no Rust change** — `award_reward` already exists and is
   Owner/Parent-callable. The limitation (Q3): the buyer cannot self-trigger
   this; an approver must be in the loop. That's acceptable for MVP and is
   documented as a follow-up.

## 5. Phased tasks

Branch: `feature/offchain-inventory` off `develop` (gitflow). Trunk state was
reconciled this session (`develop` fast-forwarded to `main` at `f957bef`).

### Phase A — Pure engine + data model (no UI, fully testable)
- [x] **A.1** Add deps. **`idb ^8.0.3`** added (runtime). **`vitest ^4.1.9`**
  added (devDep — no frontend test runner existed). **`html5-qrcode` deferred to
  Phase C** (deviation from the original "add now to lock the version" — adding
  an unused dep now would bloat `node_modules` and risk an unused-dep warning;
  it lands with the scanner code that actually imports it). Confirmed
  **`@noble/hashes` already present** (`hashes.ts` uses it) — no new hash dep.
  Confirmed **`REWARD_COST_SAVING = 50n` already in `constants.ts`** — E.1 is
  pre-done.
- [x] **A.2** `lib/db.ts` — opens `stocksie-shelf` v1, `products` store keyed by
  `barcode` with a `by-name` index, version-gated `upgrade()` for migration
  headroom. SSR-safe (`typeof indexedDB === "undefined"` → rejects with a clear
  message). Typed via `idb`'s `DBSchema`. 75 lines.
- [x] **A.3** `lib/shelf.ts` — CRUD over `db.ts`: `getProduct`,
  `findByBarcode`, `listProducts`, `upsertProduct` (preserves `createdAt`,
  refreshes `updatedAt`), `deleteProduct`. 70 lines.
- [x] **A.4** `lib/bestValue.ts` — `compareOffers()` pure impl. Edge cases
  handled: empty → `BestValueError("empty")`; non-positive price / packUnits /
  unitGrams → typed errors; non-finite unitGrams → typed error; single offer →
  valid (rank 1, 0 savings); per-unit ties → lower absolute price, then stable
  input order. **Refinement of §4.4:** to support fractional unit weights
  (e.g. 12.5g) while keeping the ranking float-free, weights are scaled to
  integer milligrams and ranked via bigint cross-products
  (`a/b < c/d ⟺ a·d < c·b`). Float appears only in the display-only
  `savingsPctVsBest`. 171 lines.
- [x] **A.5** Unit tests co-located at `app/src/lib/bestValue.test.ts` (not
  `__tests__/` — vitest's default glob picks up co-located `.test.ts` and it
  reads better next to the module). Added `vitest.config.ts` (node env, minimal).
  **10 tests**, all green: ranking (cheapest-first, bigger-pack, packUnits
  multiply, tie-break-by-price, fractional grams, single offer) + validation
  (empty, non-positive price/packUnits/unitGrams).
- [x] **A.6** Verify: `pnpm -C app test` → **10/10 green**;
  `pnpm -C app typecheck` → **exit 0**; `pnpm -C app build` → **exit 0,
  byte-identical bundle** (main route still 70.8 kB / 259 kB — the new lib
  modules + `idb` are unimported by any route and tree-shake out completely;
  zero First Load bloat until Phase D wires them in). No Rust files touched.

### Phase B — Shelf DB UI + product onboarding (no camera yet)
- [x] **B.1** `components/shelf/ShelfList.tsx` — list of products with edit,
  delete (inline two-step confirm), loading skeleton, load-error retry, and a
  friendly empty state with a single CTA. Sorts by name (case-insensitive),
  stable by `createdAt`.
- [x] **B.2** `components/shelf/ProductOnboardingForm.tsx` — required fields
  (`name`, `packUnits`, `unitGrams`) with submit gated until valid; optional
  (`brand`, `category`, `defaultPriceLamports`). Same component serves create
  + edit (barcode read-only on edit). Calm-UX validation: empty required
  fields disable submit without a red flash; non-empty invalid fields show an
  error.
- [x] **B.3** `/shelf` route wired (`app/shelf/page.tsx`) and reachable from the
  Dashboard header via a "📦 Shelf" link. **Q2 resolved: route chosen** (tabbed
  layout still deferred to plan 005 Layer 3). The route is wallet-agnostic —
  the shelf is off-chain, so it works before connecting.
- [x] **B.4** Manual barcode entry: an optional Barcode field on the create form.
  Left blank → a synthetic `manual-<uuid>` id is generated via
  `crypto.randomUUID()` (with a timestamp fallback). Edit mode shows the
  barcode read-only since it's the IndexedDB keyPath.
- [x] **B.5** Verify: `typecheck` → exit 0; `build` → exit 0 (`/shelf` = 117 kB
  First Load, `/` = 264 kB); `vitest` → 10/10 (no regression). IndexedDB
  persistence is structural (survives reload by design — `getDb()` is a
  cached singleton over `idb`).

### Phase C — Barcode scanner (camera)
- [ ] **C.1** `app/scan/page.tsx` using `html5-qrcode`. Permission flow with
  clear copy. Graceful fallback to manual entry on: no camera, permission
  denied, non-HTTPS dev (document `next dev` localhost caveat), or user
  preference.
- [ ] **C.2** On scan: `shelf.findByBarcode(code)` → known: show product + "add
  to shopping list" / "start purchase"; unknown: route to
  `ProductOnboardingForm` prefilled with the barcode.
- [ ] **C.3** Desktop / SSR safety: scanner only mounts client-side
  (`'use client'` + dynamic import with `ssr: false` where needed).
- [ ] **C.4** Verify: build; manual smoke on `pnpm -C app dev` (camera + manual
  fallback + unknown→onboarding→shelf round-trip).

### Phase D — Best-value modal + PurchasePanel integration
- [ ] **D.1** `components/BestValueModal.tsx` — pick 2+ offers (from shelf
  matches or manual entry), call `compareOffers`, render ranked list with
  per-unit price + savings % + "Use this" on the best.
- [ ] **D.2** Wire into `PurchasePanel.tsx` near the existing "Best-value
  snapshot" `Field` (L200-207): a "Compare prices" button opens the modal; the
  chosen offer's snapshot text back-fills the field (the existing `toHash32`
  hash-to-chain path is unchanged).
- [ ] **D.3** Persist the chosen offer's cleartext in client state keyed by the
  in-flight `requestId` so §4.5 step 3 can score after restock. (In-memory or
  IndexedDB `pendingSnapshots` store — pick the simpler one in implementation.)
- [ ] **D.4** Verify: typecheck + build; manual: create request with a compared
  snapshot → snapshot text round-trips into the hash → chain still receives a
  32-byte hash (no cleartext leak — re-confirm via the existing
  `test_privacy_invariant` reasoning).

### Phase E — `REWARD_COST_SAVING` trigger
- [ ] **E.1** Confirm `REWARD_COST_SAVING` exists in `app/src/lib/constants.ts`;
  add if missing (mirror Rust value 50).
- [ ] **E.2** After a successful `confirm_restock`, in the observer's client:
  compute `saving = snapshotPerUnit - actualPerUnit`. If `> 0`, fire
  `award_reward(buyerMember, REWARD_COST_SAVING, reasonHash)` using the existing
  `useTransaction` hook.
- [ ] **E.3** UX copy: surface "Smart saving — buyer earned 50 pts" via the
  existing `ResultBanner`.
- [ ] **E.4** Verify: end-to-end on localnet (Surfpool) — create with snapshot,
  approve, confirm with a cheaper actual, observe `RewardEarned` event with
  `REWARD_COST_SAVING` + balance delta.

### Phase F — Tests, docs, landing badge
- [ ] **F.1** bestValue unit tests (A.5) green; add a Shelf DB integration test
  (in-memory fake-indexeddb if available, else smoke-only).
- [ ] **F.2** Privacy re-audit: `rg` for any cleartext price/name reaching a
  program method call — must be zero outside `toHash32`.
- [ ] **F.3** Update `docs/INSTRUCTIONS.md` "Honest note": remove the "not
  granted by any MVP handler" caveat for `REWARD_COST_SAVING` (it now is).
- [ ] **F.4** Update `docs/ROADMAP.md` §2 if appropriate (the best-value engine
  was implicitly in §1 feature #3; now it ships — reflect honestly).
- [ ] **F.5** Landing: drop the `Coming soon` badge from the "Smart buying" card
  (`app/src/components/Landing.tsx`, `HookCard badge="Coming soon"`) and refresh
  the body copy to "live". This closes plan 005 §4c's Path A→B loop.
- [ ] **F.6** Update plan 005 §9 and this plan §8 status; handover doc.

## 6. Verification gates (definition of done)

- `pnpm -C app typecheck` → exit 0.
- `pnpm -C app build` → exit 0; bundle delta recorded in this plan's §7.
- `bestValue` unit tests → green.
- Privacy re-audit → zero cleartext item/price in any program method call.
- End-to-end localnet smoke (Phase E.4) → `REWARD_COST_SAVING` event observed.
- No Rust files touched (`git diff --stat` shows only `app/` + docs + plan).

## 7. Bundle size tracking (fill in per phase)

| Commit | Page Size | First Load JS | Delta | Notes |
|---|---|---|---|---|
| `f957bef` (baseline, post-reframe) | 70.8 kB | 259 kB | — | Plan 005 §4c landed. |
| Phase A (engine + DB, unimported) | 70.8 kB | 259 kB | 0 / 0 | Byte-identical: the new lib modules + `idb` aren't imported by any route → tree-shaken out. |
| Phase B (shelf UI) | 67.4 kB | 264 kB | −3.4 / +5 | `/` route: small First Load bump from the Dashboard "Shelf" link (chunk reorg). New `/shelf` route is 117 kB First Load — lean, since it doesn't pull Solana/wallet-adapter into its own chunk. |

Watch the scanner dep — `html5-qrcode` is the heaviest add; lazy-load it only on
`/scan` (dynamic import, `ssr: false`) to keep the landing/dashboard First Load
flat.

## 8. Status

**Phases A + B DONE** (on `feature/offchain-inventory`). Phase A: pure
`compareOffers()` engine (float-free bigint cross-products on milligram-scaled
weights) + typed SSR-safe IndexedDB shelf (`db.ts`, `shelf.ts`), 10 vitest
tests green. Phase B: shelf catalog UI — `components/shelf/ShelfList.tsx`
(browse/edit/delete + empty state) and `components/shelf/ProductOnboardingForm.tsx`
(create/edit with validation + manual barcode → synthetic `manual-<uuid>`),
reachable at the `/shelf` route from the Dashboard. No Rust files touched.
Gates: `typecheck` → exit 0; `build` → exit 0 (`/shelf` 117 kB First Load);
`vitest` → 10/10. Q1 (test runner) + Q2 (route vs tab → route) resolved.

Next: **Phase D → E** (best-value modal + `PurchasePanel` integration, then the
`REWARD_COST_SAVING` trigger), then **C** (camera scanner, last — so the product
works fully without a camera), then **F** (tests/docs + drop the landing
"Coming soon" badge). Phases D–E are unblocked; Q3–Q5 can be answered inline.

## 9. Open questions (need PO input before/during build)

- **Q1 — Test runner.** ✅ **Resolved (Phase A):** no runner existed; added
  `vitest ^4.1.9` as a devDep with a minimal `app/vitest.config.ts` (node env).
  10 `bestValue` tests green. Convention: co-located `*.test.ts` next to the
  module.
- **Q2 — Shelf route vs tab.** ✅ **Resolved (Phase B):** `/shelf` as a route,
  linked from the Dashboard header. Plan 005 Layer 3 (tabbed layout) remains
  deferred. The route is wallet-agnostic (the shelf is off-chain, so it works
  before a wallet is connected) — a deliberate web2-friendly choice.
- **Q3 — Buyer self-claim of cost-saving reward.** The no-Rust path requires an
  Owner/Parent to be in the loop to fire `award_reward`. Acceptable for MVP, or
  is buyer-self-claim a hard requirement (which would push a new on-chain
  instruction into scope)?
- **Q4 — Cross-device sync.** Per-device IndexedDB only for this plan. Confirm
  the household is OK re-entering the shelf on a second device for now (sync is
  a later horizon, needs a server).
- **Q5 — `html5-qrcode` vs alternative.** Proposed default. If the PO prefers a
  different scanner lib (e.g. `@zxing/browser`), say so before Phase C.

## 10. Reconciliation note (for the record)

The presenter summary that prompted this plan contained three inaccuracies,
flagged here so they don't propagate:

1. It referenced a branch `develop/feature/01_household_program` — **that branch
   never existed under that name.** Actual work landed on `develop`/
   `feature/frontend` and is now on `main`; `develop` was fast-forwarded to
   `main` (`f957bef`) this session.
2. It claimed designs were "documented in `system_flows.md`" — **that file does
   not exist** in the repo. The presenter features are net-new and are specified
   here for the first time (§4).
3. It listed "add security test: reward overflows handled" as a task — **that
   test already exists** (`test_rewards.rs::award_reward_overflow`, line 234).
   The other item, `aliased_vault_debit_rejected`, is deliberately omitted
   (structurally unreachable from the typed API; see `test_security.rs` lines
   16–18, 808) and is a non-blocking nicety, not a gap.
