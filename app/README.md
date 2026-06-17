# Stocksie Frontend

A Next.js 15 + React 19 reference UI that drives the full Stocksie household
lifecycle (vault, purchase approvals, reimbursements, rewards) against a local
Solana cluster via **Surfpool**.

This is a *reference* frontend: every one of the 14 program instructions is
exercised by a real, signed transaction. No mocks, no hardcoded data, no
placeholder flows. The state panel reflects on-chain truth, polled live.

---

## Stack

| Concern | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 |
| Language | TypeScript (strict) |
| Styling | Tailwind CSS |
| Program client | `@anchor-lang/core` 1.0.2 (the Anchor 1.0 client — the program emits the new flat IDL format, which the legacy `@coral-xyz/anchor` cannot parse) |
| Wallets | `@solana/wallet-adapter-react` + Wallet Standard (Phantom / Solflare / Backpack) + a built-in `LocalKeypairWalletAdapter` for dev signing without an extension |
| Hashing | `@noble/hashes/blake3` (matches on-chain `HASH_LEN = 32`) |

---

## Quick start (Surfpool localnet)

The full happy path takes about three minutes once Surfpool is running.

### 0. Prerequisites

- [`surfpool`](https://github.com/eclipse-laboratories-inc/surfpool) ≥ 1.3.1
- [`anchor`](https://www.anchor-lang.com/) ≥ 1.0.2
- [`solana-cli`](https://docs.solana.com/cli) ≥ 3.1.10
- `node` ≥ 20, `pnpm` ≥ 9

Verify:

```sh
surfpool --version
anchor --version
solana --version
node --version
pnpm --version
```

### 1. Start a Surfpool local cluster

In a dedicated terminal:

```sh
surfpool local
```

This starts a local validator at `http://127.0.0.1:8899` with unlimited,
instant airdrops and resettable state. Leave it running.

Confirm it's reachable:

```sh
solana config set --url http://127.0.0.1:8899
solana cluster-version
```

### 2. Fund your dev wallet

The `Local Keypair (dev)` fallback wallet (and any extension wallet you use)
needs SOL for rent and transactions. With Surfpool, airdrops are instant and
uncapped:

```sh
# Fund the default Solana CLI keypair (also used by `anchor deploy`).
solana airdrop 5

# Or fund a specific wallet you'll connect in the UI:
solana airdrop 5 <RECIPIENT_PUBKEY>
```

### 3. Build + deploy the program to localnet

From the repo root:

```sh
anchor build
anchor deploy
```

`anchor deploy` writes the program ID from `Anchor.toml`
(`At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj`) to the local cluster. The
build also regenerates `target/idl/stocksie.json` and `target/types/stocksie.ts`,
which `pnpm dev` / `pnpm build` copy into the app via `scripts/copy-idl.mjs`.

Confirm the program is live:

```sh
solana program show At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj
```

### 4. Install frontend dependencies + run the dev server

```sh
pnpm -C app install
pnpm -C app dev
```

The dev server runs `copy-idl` first (so the latest IDL is in sync), then
starts Next.js at **http://localhost:3000**.

Open it. You should see:

- The header info row reading `Cluster: localnet (Surfpool)`.
- A `Live State` panel prompting you to connect a wallet.
- The five instruction panels (`Household`, `Funds`, `Purchase Requests`,
  `Reimburse`, `Rewards`), each gated behind a "connect a wallet" hint.

### 5. Connect a wallet

Two options, both fully supported:

- **Wallet Standard extension** (Phantom / Solflare / Backpack): connect it to
  the Surfpool local RPC. In Phantom: Settings → Change Network → Add Custom
  Network → RPC URL `http://127.0.0.1:8899`. Then click **Connect Wallet** in
  the UI and pick your extension.

- **Local Keypair (dev)**: the built-in fallback. Click **Connect Wallet** and
  pick "Local Keypair (dev)". A fresh keypair is generated and persisted to
  `localStorage`; fund it with `solana airdrop 5 <PUBKEY>` (the address is
  shown after connecting).

### 6. Drive the lifecycle

With a funded, connected wallet, work top-to-bottom:

1. **Household → initialize_household** — enter a name, submit. You become the
   owner. The `Live State` panel refreshes within ~1.5s (or immediately, via the
   post-write refetch).
2. **Household → add_member** — paste a second wallet (any base58 address),
   pick a role (Parent / Child / Guest), submit.
3. **Funds → deposit_funds** — top up the vault. Watch the vault balance tick
   up in `Live State`.
4. **Purchase Requests → create_purchase_request** — enter an amount, a buyer
   wallet (must be a member), and item / unit-cost text (blake3-hashed
   client-side). Submit. The reporter earns `REWARD_LOW_STOCK_REPORT` (10 pts).
5. **Purchase Requests → approve_purchase_request** — enter the request ID,
   approve. (Owner / Parent only.)
6. **Purchase Requests → confirm_restock** — as the buyer, confirm restock with
   the actual unit-cost snapshot. The buyer earns `REWARD_RESTOCK_COMPLETED`
   (25 pts).
7. **Reimburse → reimburse_buyer** — pay out the buyer (amount ≤ the request's
   spend ceiling). The buyer earns `REWARD_FULL_RUN_COMPLETED` (15 pts); the
   vault is debited.
8. **Purchase Requests → close_purchase_request** — close the now-terminal
   (reimbursed) request and reclaim rent.

Every confirmed transaction surfaces a green banner with the signature, an
Explorer link (cluster-aware — it points at Solana Explorer with
`cluster=custom&customUrl=…` for the local cluster), and a copy button.

---

## How the UI resolves the household

**Read this if you connect a non-owner wallet and the panels look empty.**

The household PDA is seeded by the household **owner** — `["household", owner]`
— and the owner is fixed at `initialize_household` time. Every later instruction
(`add_member`, `deposit_funds`, `create_purchase_request`, …) can be called by
*any* active member of that household, not just the owner.

This means the UI cannot derive the household from the connected wallet alone:
when a non-owner member connects, `findHouseholdPda(theirWallet)` would produce
the wrong PDA. Instead, the `Live State` panel has a **Household owner address**
field at the top:

- **Default** — auto-fills with the connected wallet (the owner-driven happy
  path: "I created this household, I'm driving the UI").
- **Override** — paste any other owner's pubkey to transact against a household
  you are a member of but did not create. The field is marked "overridden" and a
  **Reset to connected wallet** button restores the default.

The resolved household PDA flows to every panel + the state view, so they all
agree on which household you're operating against.

---

## Project layout

```text
app/
├── README.md                  ← this file
├── .env.example               ← NEXT_PUBLIC_RPC_ENDPOINT / COMMITMENT / PROGRAM_ID
├── next.config.mjs
├── package.json
├── postcss.config.mjs
├── tailwind.config.ts
├── tsconfig.json
├── pnpm-workspace.yaml        ← native-build allowlist (all declined)
├── scripts/
│   └── copy-idl.mjs           ← syncs target/{idl,types} → app/ before dev/build/typecheck
├── idl/
│   └── stocksie.json          ← copied from target/idl (do not edit)
└── src/
    ├── app/
    │   ├── globals.css
    │   ├── layout.tsx         ← <Providers> wrapper
    │   └── page.tsx           ← main shell (header + StateView + 5 panels)
    ├── components/
    │   ├── Providers.tsx       ← Connection + Wallet + HouseholdContext + Refresh
    │   ├── WalletButton.tsx
    │   ├── StateView.tsx       ← vault balance, member roster, purchase ledger
    │   ├── panels/
    │   │   ├── HouseholdPanel.tsx    ← initialize / add_member / remove_member / set_role
    │   │   ├── FundsPanel.tsx        ← deposit_funds / withdraw_funds
    │   │   ├── PurchasePanel.tsx     ← create / approve / reject / confirm_restock / close
    │   │   ├── ReimbursePanel.tsx    ← reimburse_buyer
    │   │   └── RewardsPanel.tsx      ← award_reward / reward_summary
    │   └── ui/                 ← Button, Field, Select, Badge, Panel, ResultBanner, ConnectGate
    ├── hooks/
    │   ├── useHouseholdContext.tsx   ← owner pubkey → household PDA resolution (context)
    │   ├── useHousehold.ts           ← fetch + poll household / members / requests
    │   ├── useRefresh.tsx            ← shared post-write refetch signal
    │   └── useTransaction.ts         ← tx submit wrapper (pending / signature / error)
    └── lib/
        ├── adapters/
        │   └── localKeypairWalletAdapter.ts  ← dev-only in-browser keypair signer
        ├── generated/
        │   └── stocksie.ts          ← copied from target/types (do not edit)
        ├── accounts.ts              ← PDA helpers (household / member / purchase)
        ├── constants.ts             ← env RPC, seeds, reward schedule, limits
        ├── format.ts                ← lamports↔SOL, pubkey shortening, error extraction
        ├── hashes.ts                ← blake3 helpers
        ├── idl.ts                   ← typed IDL entry point
        ├── parse.ts                 ← tryParsePublicKey / tryParseUint64
        ├── pda.ts                   ← raw findProgramAddressSync wrappers
        ├── program.ts               ← Program<Stocksie> client + useProgram hook
        └── types.ts                 ← Role / Status enum mirrors + Anchor converters
```

---

## NPM scripts

Run from `app/` (or use `pnpm -C app <script>` from the repo root):

| Script | What it does |
|---|---|
| `pnpm dev` | Copy the IDL, then start the Next.js dev server on `:3000`. |
| `pnpm build` | Copy the IDL, then run a production build. |
| `pnpm typecheck` | Copy the IDL, then run `tsc --noEmit`. |
| `pnpm lint` | Run `next lint`. |
| `pnpm copy-idl` | Re-sync `target/idl` + `target/types` into the app. |

`copy-idl` runs automatically before `dev`, `build`, and `typecheck`, so the
typed client never drifts from the on-chain program. Re-run `anchor build`
whenever you change the program; the next `pnpm dev` / `build` picks up the new
IDL.

---

## Configuration

All config is env-driven and client-exposed (the UI runs in the browser). Copy
`.env.example` to `.env.local` to override:

| Variable | Default | Purpose |
|---|---|---|
| `NEXT_PUBLIC_RPC_ENDPOINT` | `http://127.0.0.1:8899` | Surfpool local RPC. |
| `NEXT_PUBLIC_RPC_COMMITMENT` | `confirmed` | Read / tx commitment. |
| `NEXT_PUBLIC_PROGRAM_ID` | `At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj` | Must match `Anchor.toml`. |

If you deploy to devnet instead, point `NEXT_PUBLIC_RPC_ENDPOINT` at a devnet
RPC and redeploy the program there. The rest of the UI is cluster-agnostic.

---

## Troubleshooting

**"Program account not found" / "AccountNotFound" on every transaction.**
The program isn't deployed to the cluster the UI is pointed at. Run
`anchor deploy` and confirm `solana program show At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj`
returns account data. Also verify `solana config get --url` matches
`NEXT_PUBLIC_RPC_ENDPOINT`.

**The wallet connects but transactions fail with "insufficient lamports".**
Fund the wallet: `solana airdrop 5 <PUBKEY>`. Surfpool airdrops are instant and
uncapped. The owner pays rent for every `init` PDA (household, members, purchase
requests), so 5 SOL is plenty for a full lifecycle walk-through.

**The `Live State` panel shows "Household not initialized".**
The resolved household PDA has no on-chain account yet. Either run
`initialize_household` (in the Household panel), or — if you're a member, not
the owner — set the **Household owner address** field at the top of `Live State`
to the owner's pubkey. See [How the UI resolves the household](#how-the-ui-resolves-the-household).

**`reward_summary` shows a transaction signature but no visible state change.**
That's correct. `reward_summary` is a read-only instruction that emits a
`RewardEarned` event carrying the caller's cumulative score (with a `points = 0`
+ all-zero-hash sentinel so auditors can distinguish it from a real grant). It
mutates nothing; the `Live State` panel reads scores directly from the `Member`
account. The signature is shown so you can open it in Explorer and see the
emitted event log.

**The Explorer link doesn't load.**
Solana Explorer's `cluster=custom&customUrl=…` mode requires the browser to
reach the Surfpool RPC. If you're behind a proxy or the cluster is on a
different machine, the link won't resolve — but the signature is still
selectable and copyable. For local Surfpool, the link works when the validator
is reachable from your browser at `http://127.0.0.1:8899`.

**`pnpm install` fails with `[ERR_PNPM_IGNORED_BUILDS]`.**
pnpm 11 no longer reads the `pnpm` field in `package.json` for build-script
allowlists; it uses `pnpm-workspace.yaml`. The repo's `pnpm-workspace.yaml`
declines all native build scripts (`sharp`, `bufferutil`, etc.) — none are
needed for the UI. If you regenerated the lockfile and hit this, ensure
`pnpm-workspace.yaml` has every entry set to `false`.

---

## Security notes

- The `LocalKeypairWalletAdapter` is a **dev-only** convenience. Its secret key
  lives in `localStorage` in plaintext. Never use it with real funds or on
  mainnet. It exists purely so the UI is drivable without a browser extension on
  a local cluster.
- All "reason" / "item" / "unit-cost" / "household-name" inputs are
  **blake3-hashed client-side** before submission. Only the 32-byte digest lands
  on-chain. The raw text never touches the ledger (privacy-preserving design,
  mirroring the on-chain `HASH_LEN` invariant).
- The program's on-chain constraints are the source of truth for every
  authorization (owner-only gates, role checks, amount limits). Client-side
  disabled buttons + hints are UX guards only — they never replace the program's
  enforcement.