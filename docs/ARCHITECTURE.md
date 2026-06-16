# Stocksie — Architecture

> **Audience:** a contributor who wants to understand the system before changing
> it, or an integrator deciding how to build on top. If you just want to run the
> thing, start at [../README.md](../README.md). For the account layout see
> [ACCOUNTS.md](ACCOUNTS.md); for the instruction surface see
> [INSTRUCTIONS.md](INSTRUCTIONS.md).

This is the developer-facing deep dive. It is the polished output of the internal
design rationale in [../plan/02_architecture.md](../plan/02_architecture.md);
where this doc and the plan disagree, the **code** is the source of truth.

---

## 1. High-level architecture

Stocksie is a **privacy-first on-chain coordination layer** for household
shopping. The trust-critical state (membership, approvals, reimbursements,
rewards) lives on Solana; the privacy-sensitive detail (item names, quantities,
receipts, prices) lives off-chain and is referenced by `blake3` hashes only.

```/dev/null/stocksie-arch.txt#L1-28
┌──────────────────────────────────────────┐
│              Client (off-chain)           │
│  ┌──────────┐ ┌─────────┐ ┌────────────┐  │
│  │ Mobile UI│ │ Best-   │ │ Off-chain  │  │
│  │ (Last-One│ │ value   │ │ inventory  │  │
│  │  Tap)    │ │ engine  │ │ DB         │  │
│  └────┬─────┘ └────┬────┘ └─────┬──────┘  │
│       └──────┬────┴────────────┘         │
│              │ hashes + pubkeys + amounts│
└──────────────┼───────────────────────────┘
               │  (IDL-generated typed client)
───────────────┼───────────────────────────
               ▼
┌──────────────────────────────────────────┐
│        Solana — Anchor program (on-chain) │
│  Household PDA ── also the shared SOL     │
│                   vault                   │
│    ├─ Member PDA × N                      │
│    │   (role, reward_points, active)      │
│    └─ PurchaseRequest PDA × M             │
│        (status machine, proofs)           │
│  Events: pubkeys + amounts + hashes only  │
└──────────────────────────────────────────┘
```

### The boundary rule (canonical privacy statement)

The chain proves _that_ your family spent, approved, and reimbursed. It never
learns _what_ you bought, how much, or from where. The only shapes that cross
the on-chain boundary are pubkeys, `u64`/`u32`/`u8` integers, small enums
(`Role`, `Status`), booleans, and `[u8; 32]` blake3 hashes. Raw item names,
quantities, receipts, and prices never touch the ledger. See
[PRIVACY.md](PRIVACY.md) for the full boundary contract.

This invariant is machine-checked: the test
[`no_string_fields_on_chain`](../programs/stocksie/tests/test_privacy_invariant.rs)
grep-asserts that no `#[account]` or `#[event]` struct in the source contains a
`String` field, so the guarantee cannot silently regress as the codebase grows.

---

## 2. Tech stack

| Layer                    | Choice                                     | Why                                                                                                                                    |
| ------------------------ | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| Program framework        | **Anchor 1.0.2**                           | First-class accounts/constraints, generated typed client, idiomatic for the lifecycle logic.                                           |
| Runtime target           | **Solana SBF** (Agave)                     | Production target.                                                                                                                     |
| Treasury asset           | **Native SOL** (PDA-held)                  | One account per household, no SPL token-account bookkeeping, simplest CPI path for reimbursements. Token/USDC vault is a roadmap item. |
| Hashing                  | **blake3**                                 | Faster than SHA-256, project standard, 32-byte digest fits fixed-size accounts.                                                        |
| Unit & integration tests | **LiteSVM 0.10.0** (in-process Rust VM)    | 10–100× faster than `solana-test-validator`; no cluster needed.                                                                        |
| Client SDK               | **Anchor-generated Rust + TypeScript IDL** | Zero hand-maintained serializers; type-safe on both sides.                                                                             |
| Build orchestrator       | **`anchor-cli` 1.0.2**                     | `anchor build` → `.so` + IDL + types; `anchor test` → `cargo test`.                                                                    |

### Version compatibility matrix (locked)

| Tool / crate                                                                        | Version                        | Notes                                                                                       |
| ----------------------------------------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------- |
| `anchor-cli`                                                                        | `1.0.2`                        | Stable Anchor 1.0.                                                                          |
| `anchor-lang`                                                                       | `1.0.2`                        | Must match the CLI.                                                                         |
| Solana CLI (Agave)                                                                  | `3.1.10`                       | Ships `cargo-build-sbf`.                                                                    |
| Rust (host)                                                                         | `1.89.0` MSRV (`1.96.0` works) | Pinned via `rust-toolchain.toml`.                                                           |
| Rust (SBF target)                                                                   | `1.89.0-sbpf-solana-v1.52`     | Auto-managed by `cargo-build-sbf`.                                                          |
| Node                                                                                | `24.x`                         | Only needed for TS templates / lint; LiteSVM tests need none.                               |
| `litesvm`                                                                           | `0.10.0`                       | In-process SVM for the MVP test layer.                                                      |
| `blake3`                                                                            | `1`                            | Pure-Rust core compiles cleanly to SBF.                                                     |
| `solana-{message,transaction,signer,keypair,instruction,transaction-error,account}` | `3.0.x`                        | Pinned to match `litesvm`'s own deps so `TransactionError` matching lines up type-for-type. |

The workspace [`Cargo.toml`](../Cargo.toml) also sets
`overflow-checks = true`, `lto = "fat"`, and `codegen-units = 1` in the release
profile — defense-in-depth arithmetic safety plus a tighter binary.

---

## 3. Project layout

```/dev/null/stocksie-tree.txt#L1-32
stocksie/
├── Anchor.toml                 # build / test / provider config
├── Cargo.toml                  # workspace root (overflow-checks = true)
├── README.md                   # first-time visitor entry point
├── CHANGELOG.md                # release log (Keep a Changelog format)
├── docs/                       # public-facing docs (output of plan/10)
│   ├── ARCHITECTURE.md         #   this file
│   ├── ACCOUNTS.md             #   account catalog + state machine
│   ├── INSTRUCTIONS.md         #   full on-chain instruction surface
│   ├── SECURITY.md             #   security review checklist
│   ├── TESTING.md              #   test suite layout + matrix
│   ├── PRIVACY.md              #   on-chain/off-chain boundary
│   └── ROADMAP.md              #   MVP / next / later / out-of-scope
├── plan/                       # internal design rationale (source of truth)
├── programs/stocksie/
│   ├── Cargo.toml              # program crate manifest
│   ├── tests/                  # LiteSVM integration tests (51 tests)
│   │   ├── helpers/mod.rs      #   shared harness: setup_svm, derive_*, send
│   │   └── test_*.rs           #   one file per concern
│   └── src/
│       ├── lib.rs              # declare_id! + #[program] dispatch (thin)
│       ├── constants.rs        # seeds, reward schedule, size limits
│       ├── error.rs            # StocksieError enum
│       ├── events.rs           # 11 #[event] structs (audit trail)
│       ├── types.rs            # Role, Status + permission helpers
│       ├── state/
│       │   ├── mod.rs          # index only (re-exports)
│       │   ├── household.rs    # Household + vault debit/credit logic
│       │   ├── member.rs       # Member + reward accumulator
│       │   └── purchase_request.rs  # PurchaseRequest + state-machine guards
│       └── instructions/
│           ├── mod.rs          # index only
│           ├── household.rs    # init / add_member / remove_member / set_role
│           ├── funds.rs        # deposit_funds / withdraw_funds
│           ├── purchase.rs     # create / approve / reject / confirm / close
│           ├── reimburse.rs    # reimburse_buyer (vault → buyer SOL)
│           └── rewards.rs      # award_reward / reward_summary
```

### Layout rules enforced

- **`mod.rs` is index-only.** No logic, no structs — just `pub mod` + `pub use`.
  See [`state/mod.rs`](../programs/stocksie/src/state/mod.rs) and
  [`instructions/mod.rs`](../programs/stocksie/src/instructions/mod.rs).
- **`types.rs` is decoupled.** Enums and their `impl` blocks live outside
  `state/` so instructions, events, and tests can depend on them without pulling
  in account structs.
- **Files stay under 1024 lines.** Split when an instruction group or state file
  approaches the cap.
- **`lib.rs` stays thin.** Only `declare_id!`, module declarations, and the
  `#[program]` dispatch block. No business logic.

---

## 4. Program structure: the five-layer instruction shape

Every instruction follows the same five-layer shape so the codebase stays
predictable. A handler is the _only_ place business rules that cannot be
expressed as Anchor constraints are enforced (zero-amount rejection,
defense-in-depth owner re-checks, range checks). Access control is expressed
declaratively in the `#[derive(Accounts)]` block via seeds + `has_one` +
`Role::can_*` gates.

```/dev/null/five-layer.txt#L1-40
┌─ 1. Accounts struct  (#[derive(Accounts)])
│      - PDA seeds + bump
│      - has_one / owner / signer constraints
│      - role + active gates as constraint = ...
│
├─ 2. Handler function  (pub fn xxx_handler(ctx, args) -> Result<()>)
│      - business rules not expressible as constraints
│      - checked arithmetic only
│      - state-machine guard calls
│
├─ 3. State mutation
│      - via the state struct's own methods
│        (Household::debit_vault, PurchaseRequest::transition_*, etc.)
│
├─ 4. Event emission
│      - emit!(...) with pubkeys + amounts + hashes, never raw text
│
└─ 5. #[cfg(test)] unit tests
       - pure-logic tests (state machines, permission helpers)
         run without LiteSVM, in microseconds
```

The `#[program]` mod in [`lib.rs`](../programs/stocksie/src/lib.rs) is a thin
one-line forwarder per instruction — it contains no logic, only dispatch:

```programs/stocksie/src/lib.rs#L33-39
    pub fn initialize_household(
        ctx: Context<InitializeHousehold>,
        name_hash: [u8; 32],
    ) -> Result<()> {
        household::initialize_household_handler(ctx, name_hash)
    }
```

The actual work lives in the handler. For example,
`create_purchase_request_handler` validates the amount range, assigns the next
monotonic request id, writes the new `PurchaseRequest` fields, credits the
low-stock-report reward across the three audit accumulators (member / request /
household), and emits `PurchaseCreated` + `RewardEarned`:

```programs/stocksie/src/instructions/purchase.rs#L146-218
pub fn create_purchase_request_handler(
    ctx: Context<CreatePurchaseRequest>,
    amount_lamports: u64,
    item_hash: [u8; 32],
    unit_cost_hash: [u8; 32],
    buyer: Pubkey,
) -> Result<()> {
    // Range-check the requested spend ceiling.
    if amount_lamports < MIN_REQUEST_LAMPORTS {
        return Err(StocksieError::AmountBelowMinimum.into());
    }
    if amount_lamports > MAX_REIMBURSEMENT_LAMPORTS {
        return Err(StocksieError::AmountExceedsMaximum.into());
    }

    // Capture immutable snapshots before any mutable borrows.
    let household_key = ctx.accounts.household.key();
    let caller_key = ctx.accounts.caller.key();
    let request_key = ctx.accounts.request.key();
    let request_bump = ctx.bumps.request;
    let clock = Clock::get()?;

    // Assign the next monotonic id. This increments `request_counter` to
    // exactly the value (`counter + 1`) the seed was derived from.
    let request_id = ctx.accounts.household.next_request_id()?;
    // ... field writes, audit-triangle reward credits, emit! calls ...
```

The strict status transitions are _not_ encoded in handlers — they live in
`PurchaseRequest::transition_*` so the state machine has exactly one definition
(DRY). Handlers stay thin: validate args, call the relevant `transition_*`,
mutate, emit.

---

## 5. PDA derivation

All seeds are documented in [`constants.rs`](../programs/stocksie/src/constants.rs)
and cross-referenced from [ACCOUNTS.md](ACCOUNTS.md). Canonical bumps are stored
on each account at `init` and reused for CPI signing (security: bump
canonicalization — verified by `canonical_bump_stored`).

| Account                  | Seeds                                                   | Bump source           |
| ------------------------ | ------------------------------------------------------- | --------------------- |
| `Household` (also vault) | `[HOUSEHOLD_SEED, owner]`                               | `ctx.bumps.household` |
| `Member`                 | `[MEMBER_SEED, household, wallet]`                      | `ctx.bumps.*_member`  |
| `PurchaseRequest`        | `[PURCHASE_SEED, household, &request_id.to_le_bytes()]` | `ctx.bumps.request`   |

The seed constants themselves:

```programs/stocksie/src/constants.rs#L15-32
pub const HOUSEHOLD_SEED: &[u8] = b"household";
pub const MEMBER_SEED: &[u8] = b"member";
pub const PURCHASE_SEED: &[u8] = b"purchase";
```

**Why these seeds?**

- `Household` keyed by `owner` so one wallet can head multiple households (e.g.
  a parent in two families) without address collisions.
- `Member` keyed by `(household, wallet)` so the same human can belong to
  multiple households under different roles — and so a `Member` from family A
  can never authorize an action in family B.
- `PurchaseRequest` keyed by `(household, request_id)` where `request_id` is the
  household's monotonic counter. The `init` seed reads `request_counter + 1`
  during validation; the handler then calls `next_request_id()` to land the
  counter on exactly that value, keeping the derived address and the stored
  `request_id` provably consistent. The first id is `1`.

---

## 6. Why these design choices

- **Why not an SPL token vault?** Adds a mint + ATA + `transfer_checked` surface
  for no MVP benefit. Native SOL is simpler, and reimbursement amounts are small.
  Roadmap: optional USDC vault gated behind a feature flag.
- **Why not Pinocchio?** The lifecycle logic is IO-bound, not CU-bound; Anchor's
  constraints buy more safety than Pinocchio's rawness saves CU. We'd reconsider
  for a high-frequency hot path (none in the MVP).
- **Why not `init_if_needed`?** Forbidden by the security checklist
  (reinitialization risk). `remove_member` uses `close = caller`, which fully
  wipes the PDA so a clean `init` can re-add later. See [SECURITY.md](SECURITY.md).
- **Why not store the member roster on the `Household` account?** A fixed-size
  `Vec<Pubkey>` would either cap membership hard or waste rent. Per-wallet
  `Member` PDAs scale cleanly, are independently closable, and let the
  `member_count` field give a cheap cap check without iterating.
- **Why is the vault the same PDA as the household?** One account, one rent.
  Solvency is a single `account.lamports()` read. Splitting them would add an
  account, a seed, and a `has_one` for no security gain.
- **Why direct lamport moves for reimbursements (not `system_program::transfer`)?**
  The vault is a program-owned PDA; it cannot be a system-program signer. The
  canonical pattern is a direct lamport move with an explicit alias guard — this
  is what `Household::debit_vault` does.

---

## Appendix: environment quirks (machine-specific)

> These are not part of the design. They are recorded so a fresh clone does not
> trip on them. See [`plan/02_architecture.md`](../plan/02_architecture.md) §6
> for the longer rationale.

### Shared `CARGO_TARGET_DIR`

The dev machine sets `target-dir = "/Users/ozone/.cargo/target"` in
`~/.cargo/config.toml`. Anchor expects artifacts in `./target/deploy/`. The
repo handles this with a symlink: `./target` → the shared dir. If the symlink is
missing, `anchor build` succeeds but produces no `.so` in `target/deploy/`, and
LiteSVM tests fail at `include_bytes!`. Recreate it with:

```sh
rm -rf ./target
ln -s ~/.cargo/target ./target
```

### Platform-tools architecture

If `anchor build` fails with `Bad CPU type in executable (os error 86)`, the
cached platform-tools have the wrong arch. Clear and rebuild:

```sh
rm -rf ~/.cache/solana/v1.52
anchor build    # re-downloads the correct platform-tools
```

### Program ID consistency

The program ID must agree in three places:

- [`declare_id!`](../programs/stocksie/src/lib.rs) in `programs/stocksie/src/lib.rs`.
- `[programs.localnet]` in [`Anchor.toml`](../Anchor.toml).
- The keypair at `target/deploy/stocksie-keypair.json`.

`anchor build` enforces this; mismatched keys abort the build. The MVP program
ID is `At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj`.

---

## Where to go next

- [ACCOUNTS.md](ACCOUNTS.md) — the three account structs, field-by-field
  rationale, the state machine, and the forbidden-transitions table.
- [INSTRUCTIONS.md](INSTRUCTIONS.md) — every instruction's accounts, args,
  effect, events, and errors.
- [SECURITY.md](SECURITY.md) — the vulnerability matrix and the named test that
  verifies each defense.
- [TESTING.md](TESTING.md) — how to run the 75-test suite and where to add new
  tests.
