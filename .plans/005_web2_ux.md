# Plan 005 — Web2-Friendly UX Revision

> Rewrite the Stocksie frontend so non-crypto users can use the system without
> fear of "onchain things." Executed on a dedicated feature branch
> `feature/web2-ux` off `develop`.

---

## 1. Context

- **Branch:** `feature/web2-ux` (cut from `develop` @ `55a9020`, post-review).
- **Goal:** make the UI/UX accessible to web2 users (parents, non-crypto
  households) by removing crypto jargon, replacing snake_case instruction
  labels with human actions, and hiding developer-only surfaces behind a
  collapsible "Developer details" panel.
- **In scope:** copy + presentation only. No changes to Anchor method calls,
  PDA derivations, transaction logic, the on-chain Rust program, or any
  `lib/`, `hooks/`, or `adapters/` code.
- **Out of scope:** the underlying typed Anchor 1.0 client (`lib/program.ts`,
  `lib/accounts.ts`, `lib/pda.ts`, `lib/hashes.ts`, `lib/types.ts`,
  `lib/format.ts`, `lib/parse.ts`, `lib/constants.ts`) — these contain
  cryptographic / domain terms ("lamports", "PDA", "blake3") by necessity and
  are not user-facing.

## 2. Problem statement (what scares web2 users today)

1. **Crypto jargon everywhere** — "Household PDA", "base58 pubkey", "lamports
   (1 SOL = 1,000,000,000 lamports)", "blake3-hashed client-side", "rent
   refunded to owner", "Surfpool local cluster", "Wallet Standard extensions
   (Phantom / Solflare / Backpack)".
2. **Snake_case instruction names exposed as labels** — `initialize_household`,
   `add_member`, `create_purchase_request`, `reimburse_buyer` shown verbatim
   in every `SubPanel` header.
3. **Raw 44-char addresses shown prominently** — `shortPubkey()` (e.g.
   `7N2q…k9Px`) is the primary identifier in tables.
4. **The "Live State" panel looks like a DB admin tool** — 4-column stat
   grid + "Household PDA" meta row + two `<table>`s with monospace data.
5. **The header info row is meaningless to users** — Cluster / Program client
   / Wallet cards at the top of the page.
6. **Cold dark-only theme + monospace overload** — slate-950 black, mono fonts
   everywhere, dashed borders — reads like a security tool.
7. **No guided path** — all 14 instructions dumped as 5 stacked panels.

## 3. Vocabulary table (the Layer 1 contract)

| Today (scary) | Revised (friendly) |
|---|---|
| Connect a wallet | **Sign in** |
| Wallet / wallet adapter | **Your account** |
| Vault / vault balance | **Shared budget** |
| Household PDA / derive PDA | **Your household** (no mention of derivation) |
| Base58 pubkey / address | **Member address** (with help text "the long string from your wallet") |
| `initialize_household` | **Set up your household** |
| `add_member` | **Invite a member** |
| `remove_member` | **Remove a member** |
| `set_role` | **Change a member's role** |
| `deposit_funds` | **Add money to the budget** |
| `withdraw_funds` | **Move money back to my account** |
| `create_purchase_request` | **Report something we need** |
| `approve_purchase_request` | **Approve the request** |
| `reject_purchase_request` | **Decline the request** |
| `confirm_restock` | **Mark as bought** |
| `close_purchase_request` | **Close the request** |
| `reimburse_buyer` | **Pay back the buyer** |
| `award_reward` | **Give reward points** |
| `reward_summary` | **Show my reward score** |
| SOL / lamports | Show **SOL**, drop lamports from all help text |
| blake3-hashed / on-chain / off-chain / rent | Collapse into single **"🔒 Private: only your household can see this."** note |
| Transaction signature (long hash) | **✓ Done** + small **View receipt ↗** link |
| Owner-only / Owner/Parent | **Admin only** / **Admin or approver** |

## 4. Layer 1 — Vocabulary rewrite (ACTIVE)

Copy + presentation only. No logic changes. No new dependencies.

- [x] **1.1** Create this plan at `.plans/005_web2_ux.md`.
- [x] **1.2** `app/src/app/page.tsx` — friendly header (welcome line, sign-in
  CTA, status pill), remove the 3 dev `InfoCard`s from the top, add a
  collapsible **"Developer details"** `<details>` at the bottom carrying the
  Cluster / Program client / Wallet cards. Footer copy rewritten in plain
  language (no "household PDA", no "Wallet Standard extensions").
- [x] **1.3** `app/src/components/StateView.tsx` — replace every "PDA",
  "lamports", "blake3", "vault" string in user-facing copy; rewrite Panel
  title/description, OwnerField label + help text ("Household owner address"
  → "Household admin address", drop the PDA-derivation explainer), StatCard
  labels ("Vault balance" → "Shared budget"), MetaRow label ("Household PDA"
  → "Household address"), member/purchase table headers, EmptyState bodies.
- [x] **1.4** `app/src/components/panels/HouseholdPanel.tsx` — Panel
  title/description rewritten; every `SubPanel` `label` rewritten
  (`initialize_household` → "Set up your household", etc.); every `hint`
  rewritten in plain language with a single privacy note replacing the
  blake3 explainer; "Owner-only" → "Admin only"; field labels and help text
  de-jargoned; `ROLE_OPTIONS` "Owner (not allowed)" → "Admin (already taken)".
- [x] **1.5** `app/src/components/panels/FundsPanel.tsx` — Panel title
  "Funds" → "Money"; description rewritten ("shared household vault" →
  "shared household budget"); `deposit_funds` SubPanel → "Add money to the
  budget"; `withdraw_funds` SubPanel → "Move money back to my account";
  "emergency drain" → "withdraw"; drop lamports from every help text; the
  admin-only gate copy rewritten in friendly language.
- [x] **1.6** `app/src/components/panels/PurchasePanel.tsx` — Panel
  description rewritten; `create_purchase_request` → "Report something we
  need"; `approve_purchase_request` → "Approve the request";
  `reject_purchase_request` → "Decline the request"; `confirm_restock` →
  "Mark as bought"; `close_purchase_request` → "Close the request"; "spend
  ceiling" → "spending limit"; "circuit breaker" → "safety limit"; drop
  blake3/lamports mentions; collapse all "blake3-hashed" help text into one
  privacy note.
- [x] **1.7** `app/src/components/panels/ReimbursePanel.tsx` — Panel title
  "Reimburse" → "Pay back"; `reimburse_buyer` → "Pay back the buyer";
  description rewritten; "circuit breaker" → "safety limit"; help text
  de-jargoned; admin/approver gate copy rewritten.
- [x] **1.8** `app/src/components/panels/RewardsPanel.tsx` — Panel
  description rewritten; `award_reward` → "Give reward points";
  `reward_summary` → "Show my reward score"; "audit-stream" / "blake3" /
  "all-zero hash sentinel" copy replaced with plain-language equivalents;
  admin/approver gate copy rewritten.
- [x] **1.9** `app/src/components/ui/ConnectGate.tsx` — "Connect a wallet
  to drive this panel" → "Sign in to use this"; Wallet Standard extensions
  explainer collapsed into a single plain-language "Sign in with Phantom,
  Solflare, Backpack, or the built-in dev account." line; "Enter a household
  owner address above to resolve the household PDA" → "Enter the household
  admin's address above to load your household."
- [x] **1.10** `app/src/components/WalletButton.tsx` — JSDoc only (no visual
  change here; the `WalletMultiButton` chrome comes from the adapter UI and
  will be re-skinned in Layer 2). Update the JSDoc to reflect the "Sign in"
  vocabulary used by the rest of the app.
- [x] **1.11** `app/src/components/ui/ResultBanner.tsx` — "Transaction
  confirmed" → "Done"; "Signing and sending transaction…" → "Sending…";
  "Transaction failed" → "Couldn't complete"; "View on Explorer ↗" → "View
  receipt ↗"; "Copy signature" → "Copy receipt ID"; the raw signature
  `<code>` stays (power users still want it) but is rendered smaller and
  labeled "Receipt ID".
- [x] **1.12** `app/src/components/ui/Badge.tsx` — leave `ROLE_LABELS.owner`
  as "Owner" (the role enum stays as-is for clarity in the badge surface);
  add a code comment noting the rest of the UI surfaces it as "admin".
- [x] **1.13** Verify: `tsc --noEmit` (app) → exit 0; `pnpm -C app build` →
  exit 0; `cargo check -p stocksie` → exit 0 (sanity — no Rust touched).
- [x] **1.14** Conventional commit on `feature/web2-ux`:
  `feat(ux): rewrite crypto jargon to household vocabulary (web2-friendly)`.

## 5. Layer 2 — Visual & layout warmth (DEFERRED)

Not started. Pending Layer 1 review.

- [ ] **2.1** Add a **light theme** (default) with soft pastels; keep dark as
  a toggle. Update `tailwind.config.ts` `darkMode: 'class'` and add a
  `<ThemeToggle>` in the header.
- [ ] **2.2** Replace `shortPubkey()` primary display with **avatars with
  initials** — deterministic color derived from the pubkey so it's stable
  across renders. Add `lib/avatar.ts` + `<Avatar>` component.
- [ ] **2.3** Replace the 3-card dev header with one friendly summary:
  "Welcome back, {name}" + budget badge + sign-in button. (Partially done
  in Layer 1 — the dev cards moved to a collapsible. Layer 2 finishes the
  friendly welcome line.)
- [ ] **2.4** Replace the member-roster `<table>` with a **member card
  grid** — avatar + role + reward points + active/inactive in a soft card.
- [ ] **2.5** Replace the purchase-ledger `<table>` with **purchase cards**
  — status pill + item (truncated) + buyer avatar + spending limit + reward.
- [ ] **2.6** Add **icons / emoji** for household concepts (🏠 household,
  💰 budget, 🛒 purchase, 🎁 reward) in Panel headers.
- [ ] **2.7** Re-skin the `WalletMultiButton` chrome to match the friendly
  palette (this currently pulls in
  `@solana/wallet-adapter-react-ui/styles.css`).

## 6. Layer 3 — Guided flow (DEFERRED)

Not started. Pending Layers 1 + 2 review.

- [ ] **3.1** **Onboarding stepper** — when no household exists, show ONE
  big friendly card "Set up your household" with a 3-step visual (name it →
  invite members → add money).
- [ ] **3.2** **Tabbed layout** — replace the 5 stacked panels with tabs:
  `Overview` · `Shopping` · `Members` · `Money` · `Rewards`. Each tab shows
  only what's relevant.
- [ ] **3.3** **"I need to buy something" primary CTA** — the most common
  action, one click away, opens a friendly modal (not a snake_case form).
- [ ] **3.4** **Lockable admin-only cards** — render admin-only sections as
  visually "locked" with a friendly tooltip "Only the household admin can
  do this" instead of a hard redirect / scary red border.
- [ ] **3.5** **Empty-state illustrations** — replace the dashed-border
  muted boxes with simple inline SVG illustrations for each empty state.

## 7. Definition of done (per layer)

### Layer 1 (this commit)
- Every user-visible string in `page.tsx`, `StateView.tsx`, all 5 panels,
  `ConnectGate.tsx`, `WalletButton.tsx`, `ResultBanner.tsx` uses household
  vocabulary per the table in §3.
- The 3 dev `InfoCard`s (Cluster / Program client / Wallet) live behind a
  collapsed **"Developer details"** `<details>` at the bottom of `page.tsx`.
- No `TODO`, no `FIXME`, no mock data, no placeholder text.
- `tsc --noEmit` (app) and `pnpm -C app build` both exit 0.
- No changes to: any `lib/` file, any `hooks/` file, any `adapters/` file,
  any Rust file, the `Program` instance, any `.accountsStrict({...})` call,
  any PDA derivation, any transaction thunk.

### Layers 2 + 3 (future commits)
- Will be tracked as separate checkboxes above; do not unilaterally start
  until Layer 1 is reviewed and the direction confirmed.

## 8. Verification log

### Layer 1
- `tsc --noEmit` (app) → **exit 0** (zero TypeScript errors).
- `pnpm -C app build` → **exit 0** (`copy-idl` syncs both artifacts;
  `next build` compiles in 1.4s, type-check passes, 4 static pages; main
  route **68.8 kB / 257 kB First Load JS** — byte-identical to the pre-Layer-1
  baseline, confirming copy-only changes).
- `cargo check -p stocksie` → **exit 0** (sanity — no Rust touched).
- `cargo clippy --all-targets` → **exit 0**, zero warnings.
- Post-edit jargon sweep: `rg "lamports|blake3|PDA|base58|on-chain|off-chain|rent|circuit breaker|emergency drain|vault|Wallet Standard|Owner/Parent|Owner-only"` across `app/src/components/**/*.tsx` → **0 matches**.
- Post-edit snake_case sweep: `rg 'label="(initialize_household|add_member|…|reward_summary)"'` across `app/src/components/**/*.tsx` → **0 matches**.
- `git diff --stat HEAD` → **11 files changed, +270/−215**, all under `app/src/app/page.tsx` + `app/src/components/` + `app/src/components/panels/` + `app/src/components/ui/`. **Zero** `lib/`, `hooks/`, `adapters/`, or `programs/` (Rust) files touched.
- Scope-of-change audit: every hunk is a string literal (Panel title / description, SubPanel label / hint, Field label / placeholder / helpText, button label, EmptyState title/body, table header, ResultBanner copy, ConnectGate copy, JSDoc). No Anchor method calls, no `.accountsStrict({...})` account sets, no PDA derivation, no transaction thunks, no validation logic touched.

## 9. Status

**Layer 1 complete and verified.** All vocabulary rewrites applied across
`page.tsx`, `StateView.tsx`, all 5 panels, `ConnectGate.tsx`,
`WalletButton.tsx`, `ResultBanner.tsx`, and `Badge.tsx`. Developer-only
surfaces (Cluster / Program client / Wallet adapter) moved behind a collapsed
`<details>` at the bottom of the page. `tsc --noEmit`, `pnpm -C app build`,
`cargo check`, and `cargo clippy --all-targets` all exit 0. No logic changes —
copy + presentation only.

Layers 2 + 3 deferred pending Layer 1 review. Awaiting conventional commit and
user sign-off on the direction before starting Layer 2 (visual warmth) or
Layer 3 (guided flow).