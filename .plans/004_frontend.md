# Plan 004 — Stocksie Reference Frontend (Option 3)

> A "use and see" web UI that drives the 14 Stocksie instructions against a
> local Solana cluster via **Surfpool**. Post-MVP roadmap work, executed on a
> dedicated feature branch off `develop`.

---

## 1. Context

- **Branch:** `feature/frontend` (cut from `develop` @ `fc782ca`, MVP tip).
- **Goal:** a clickable reference frontend exercising the full household →
  vault → purchase lifecycle → rewards flow on real transactions.
- **Program:** `At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj` (Anchor 1.0.2,
  14 instructions, 12 events, 3 account types).
- **MVP backend status:** complete, 75 tests green (`cargo test`), `cargo check`
  and `cargo clippy --all-targets -- -D warnings` clean. No code changes to the
  on-chain program are expected in this plan.

## 2. Cluster decision — localnet via Surfpool

**Decision: Surfpool in local (localnet) mode**, RPC at `http://127.0.0.1:8899`,
commitment `confirmed`.

Rationale:

| Factor | Localnet (Surfpool local) | Devnet fork |
|---|---|---|
| Program deploy | we deploy stocksie locally ✓ | deploy to devnet |
| Airdrop | **unlimited, instant** | rate-limited |
| State | **resettable** | public/persistent |
| Rate limits | none | devnet RPC caps |
| Reads existing on-chain programs | no | yes (not needed) |

We are deploying **our own** program and reading no existing on-chain state, so
devnet's only benefit (live program state) does not apply. Localnet wins on
every axis that matters for iterative UI development.

## 3. Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript** + **Tailwind CSS**.
- **Wallet:** `@solana/wallet-adapter-react` + `@solana/wallet-adapter-react-ui`
  + `@solana/wallet-adapter-base` + wallet-standard auto-detect (Phantom etc.).
- **Dev-only signer fallback:** a custom `LocalKeypairWalletAdapter` that
  generates an in-browser `Keypair`, persists its secret to `localStorage`, and
  registers through the same wallet-adapter store so the UI is wallet-agnostic.
  Active only when no extension wallet is detected. Never bundled into prod
  signing paths for real funds (localnet only).
- **Program client: `@anchor-lang/core`** (Anchor 1.0 client) — **NOT**
  `@coral-xyz/anchor`. The on-chain program is Anchor 1.0.2 and emits the new
  flat IDL format (`metadata`/`address`/`accounts`/`types`/`events`/`errors`,
  `spec: "0.1.0"`), which the legacy `@coral-xyz/anchor` 0.31 client cannot
  parse. The repo already declares `@anchor-lang/core` as a dependency.
- **Hashing:** `@noble/hashes/blake3` for item / receipt / reason / name hashes
  (32-byte, matching on-chain `HASH_LEN`, blake3 per project lib convention).
- **IDs:** client-generated monotonic identifiers use UUIDv7-style ordering
  (time-ordered) where applicable, mirroring the Rust `Uuid::now_v7()` rule.

## 4. PDA seeds (mirror on-chain `constants.rs`)

```text
household = ["household", owner]
member    = ["member",   household, wallet]
purchase  = ["purchase", household, request_id_le_bytes]
```

Program ID: `At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj`.

## 5. Stages

- [x] **Stage 1 — Branch + scaffold.** ✓ `app/` directory as a Next.js 15
  workspace; `package.json`, `next.config.mjs` (with `outputFileTracingRoot`),
  `tsconfig.json` (path aliases `@/*` + `@idl/*`), `tailwind.config.ts`,
  `postcss.config.mjs`, `.gitignore`, `.env.example`, `next-env.d.ts`,
  `pnpm-workspace.yaml`; root `layout.tsx`; `app/src/app/globals.css`; client
  `Providers.tsx` (Connection + Wallet + AutoConnect + Buffer polyfill);
  `scripts/copy-idl.mjs`.
- [x] **Stage 2 — Typed client from IDL.** ✓ `lib/idl.ts` (typed IDL + program
  address), `lib/program.ts` (`Program<Stocksie>` instance via `makeProgram` +
  `useProgram` hook bound to the active wallet), `lib/pda.ts` (household /
  member / purchase derivation, `u64` little-endian request id), `lib/hashes.ts`
  (blake3 helpers), `lib/constants.ts` (env RPC config, seed bytes, reward
  schedule, size limits), typed enum mirrors `lib/types.ts` for `Role`/`Status`.
- [x] **Stage 3 — Wallet connection.** ✓ `components/WalletButton.tsx`,
  `lib/adapters/localKeypairWalletAdapter.ts` (dev keypair fallback, localStorage
  persistence, full `SignerWalletAdapter` surface), `WalletModalProvider`,
  wallet-standard auto-detect of Phantom/Solflare/Backpack, `autoConnect`.
- [x] **Stage 4 — Instruction UI panels.** ✓ All 14 instructions across five
  domain panels. `HouseholdPanel` (initialize, add/remove member, set role),
  `FundsPanel` (deposit, withdraw), `PurchasePanel` (create, approve, reject,
  confirm restock, close), `ReimbursePanel` (reimburse buyer), `RewardsPanel`
  (award reward, reward summary). Each panel builds the instruction with
  client-resolved PDAs via `.accountsStrict({...})`, signs + sends through a
  `useTransaction` wrapper, and surfaces the tx signature (Explorer link +
  copy) and extracted program/Anchor errors via a shared `ResultBanner`.
  Owner-only and Owner/Parent sections gate their forms on the resolved
  household owner. Shared infra: `ui/{Button,Field,Select,Badge,Panel,
  ResultBanner,ConnectGate}`, `hooks/useHouseholdContext` (owner-pubkey →
  household PDA resolution — handles the non-owner-member case), `lib/accounts`
  (PDA bundle helpers), `lib/format` (lamports↔SOL float-free, pubkey
  shortening, Anchor error extraction), `lib/parse`, `lib/cn`. No mocks, no
  TODOs, no placeholders.
- [x] **Stage 5 — Live state view.** ✓ `hooks/useHousehold.ts` (fetches
  household via `fetchNullable` so an uninitialized household is a null, not
  an error; polls members + purchase requests every 1.5s via `memcmp` on the
  discriminator-adjacent `household` field at offset 8; refetches immediately
  on the shared `useRefresh` nonce after any confirmed write).
  `components/StateView.tsx` renders the vault balance (lamports → SOL via
  float-free bigint math), the member roster (owner-first, role + reward
  points + active badges), and the purchase-request ledger (newest-first,
  status badges, spend ceiling, reimbursed amount, reward earned). Includes
  the household-owner address field (override + reset), a manual refresh
  button, and clear empty/error/loading states.
- [x] **Stage 6 — Surfpool integration docs.** ✓ `app/README.md` with the
  exact runbook: prerequisites, `surfpool local` → `solana airdrop` →
  `anchor build && anchor deploy` → `pnpm -C app dev` → connect Phantom to
  the local RPC (or the dev keypair fallback) → drive the 8-step happy-path
  lifecycle. Includes the owner-vs-caller household-resolution explainer,
  the project-layout tree, the npm-script table, the env-var reference, a
  troubleshooting section, and security notes on the dev keypair + blake3
  hashing. The `copy-idl` script (Stage 1) already syncs the IDL on every
  `dev`/`build`/`typecheck`.

## 6. Target file tree

```text
app/
├── .env.example
├── .gitignore
├── pnpm-workspace.yaml       # build-script allowlist (all declined)
├── README.md                  # Stage 6 runbook
├── next.config.mjs
├── next-env.d.ts
├── package.json
├── postcss.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── idl/
│   └── stocksie.json          # copied from target/idl on build
└── src/
    ├── app/
    │   ├── globals.css
    │   ├── layout.tsx         # <Providers> wrapper
    │   └── page.tsx           # main shell
    ├── components/
    │   ├── Providers.tsx
    │   ├── WalletButton.tsx
    │   ├── StateView.tsx
    │   ├── panels/
    │   │   ├── HouseholdPanel.tsx
    │   │   ├── FundsPanel.tsx
    │   │   ├── PurchasePanel.tsx
    │   │   ├── ReimbursePanel.tsx
    │   │   └── RewardsPanel.tsx
    │   └── ui/                 # small primitives (Button, Field, Badge)
    ├── hooks/
    │   ├── useHousehold.ts
    │   └── useProgram.ts
    └── lib/
        ├── adapters/
        │   └── localKeypairWalletAdapter.ts
        ├── generated/
        │   └── stocksie.ts     # copied from target/types on build
        ├── constants.ts
        ├── hashes.ts
        ├── idl.ts
        ├── pda.ts
        ├── program.ts
        └── types.ts           # Role / Status enum mirrors + DTOs
```

## 7. Definition of done

- `pnpm install` + `pnpm build` succeed with zero TypeScript errors.
- A connected wallet (extension **or** dev keypair) can execute at least the
  happy path: `initialize_household` → `add_member` → `deposit_funds` →
  `create_purchase_request` → `approve_purchase_request` → `confirm_restock`
  → `reimburse_buyer`, with `StateView` updating after each tx.
- No `TODO`, no `FIXME`, no mock data, no placeholder text in shipped files.
- Conventional-commit on `feature/frontend`; plan checkboxes updated as stages
  land.

## 8. Verification log (stages 1–3)

- `pnpm -C app install` → **exit 0** (`Done in 400ms`, pnpm v11.6.0; all native
  build scripts declined via `pnpm-workspace.yaml`).
- `pnpm -C app build` → **exit 0** (`copy-idl` copies both artifacts;
  `next build` compiles in 2.3s, type-check passes, 4 static pages generated,
  no Tailwind content warning).
- `tsc --noEmit` (`app/node_modules/.bin/tsc -p app/tsconfig.json`) → **exit 0**.
- One resolved diagnostic during the pass: `LocalKeypairWalletAdapter.emit(
  'error', ...)` initially emitted a plain `Error`; corrected to emit
  `WalletConnectionError` to satisfy the `WalletError`-typed event.

## 9. Verification log (stages 4–6)

- IDL ground-truth extracted programmatically via `jq` from
  `target/idl/stocksie.json`: all 14 instruction account names (camelCased),
  arg names + types, and the 3 account-struct field layouts (Household / Member /
  PurchaseRequest). Confirmed `create_purchase_request`'s request PDA uses
  `request_counter + 1` (read live off the household inside the submit thunk to
  close the race window).
- `@anchor-lang/core` 1.0.2 API surface confirmed against the installed type
  definitions: `program.methods.<ix>(...).accountsStrict({...}).rpc()` builder,
  `program.account.<type>.fetchNullable/.all` (with `memcmp` filters), and the
  `AnchorError` / `ProgramError` shapes consumed by `extractErrorMessage`.
- `tsc --noEmit` (`app/`) → **exit 0** (zero TS errors) after Stages 4–6.
- `pnpm -C app build` → **exit 0** (`copy-idl` syncs both artifacts; `next build`
  compiles, type-check passes, 4 static pages generated; main route 68.8 kB /
  257 kB First Load JS).
- Diagnostics resolved during the pass:
  - `import type { PublicKey }` used as a value in 4 panels → switched to a
    value import (the `tryParsePublicKey` helpers call `new PublicKey(...)`).
  - `roleToAnchor` returned `Partial<Record<Role, …>>`, too loose for Anchor's
    generated `DecodeEnum<…>` arg type → rebuilt `AnchorRole` as a precise
    discriminated union (`AnchorEnumVariant` mapped helper) so
    `program.methods.addMember(wallet, roleToAnchor(role))` type-checks without
    a cast.
  - `cn()` `ClassValue` union rejected `0` / `0n` (from `ReactNode`-typed
    `suffix && 'cls'` expressions) → broadened to accept `number | bigint |
    boolean` and filter falsy at runtime.
  - DRY: `tryParsePublicKey` (4 copies) + `tryParseUint64` (3 copies) extracted
    into `lib/parse.ts`; the four panels now import from there.
- Post-write refetch wired without touching panel bodies: panels import
  `useTransactionWithRefresh as useTransaction` from `useRefresh`, which binds
  the shared `bump()` to each `useTransaction`'s `onConfirmed`. The `StateView`
  reads `useRefresh().nonce` and passes it to `useHousehold`, which refetches
  immediately on increment (in addition to its 1.5s poll).

## 10. Status

All six stages complete and verified. Branch `feature/frontend` carries a full
reference frontend: a typed Anchor 1.0 client, a dual-mode wallet layer (Wallet
Standard + dev keypair), all 14 instruction panels with client-resolved PDAs +
uniform tx-signature/error surfacing, a live state view (vault / roster /
ledger) that polls and refetches on every confirmed write, and a Surfpool
integration runbook.

`cargo check -p stocksie` remains green — the on-chain program was not touched
in this plan. Ready for a conventional commit on `feature/frontend`.

**Definition of done (§7) status:**
- ✅ `pnpm install` + `pnpm build` + `tsc --noEmit` all exit 0.
- ⚠️ End-to-end happy path against a live Surfpool cluster: not yet executed in
  this session (requires a running Surfpool + deployed program + manual wallet
  interaction). The UI is wired to do so — see `app/README.md` §"Quick start"
  for the exact runbook. All instruction builders, account resolution, and
  state polling are implemented against the verified IDL ground-truth.
- ✅ No `TODO`, no `FIXME`, no mock data, no placeholder text in shipped files.
- ☐ Conventional commit on `feature/frontend` + plan checkboxes (this update).