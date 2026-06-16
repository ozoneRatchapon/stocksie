# Stocksie — Architecture & Tech Stack

> How the pieces fit together, where each concern lives, and why.

---

## 1. High-level architecture

Stocksie is a **privacy-first on-chain coordination layer** for household shopping. The trust-critical state (membership, approvals, reimbursements, rewards) lives on Solana; the privacy-sensitive detail (item names, quantities, receipts, prices) lives off-chain and is referenced by `blake3` hashes only.

```text
┌──────────────────────────────────────────────────────────────────┐
│                         Client (off-chain)                        │
│  ┌────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │  Mobile UI     │  │  Best-value      │  │  Off-chain       │   │
│  │  (Last-One Tap,│  │  engine          │  │  inventory DB    │   │
│  │   shared list) │  │  (price/unit)    │  │  (items, qty,    │   │
│  │                │  │                  │  │   receipts)      │   │
│  └───────┬────────┘  └────────┬─────────┘  └────────┬─────────┘   │
│          │                    │                     │             │
│          └──────────┬─────────┴─────────────────────┘             │
│                     │                                             │
│           blake3 hashes + pubkeys + amounts                       │
└─────────────────────┼─────────────────────────────────────────────┘
                      │  (IDL-generated typed client)
──────────────────────┼───────────────────────────────────────────
                      ▼
┌──────────────────────────────────────────────────────────────────┐
│                  Solana — Anchor program (on-chain)               │
│                                                                   │
│   Household PDA ── also the shared SOL vault                      │
│        │                                                          │
│        ├── Member PDA × N        (role, reward_points, active)    │
│        │                                                          │
│        └── PurchaseRequest PDA × M (status machine, proofs)       │
│                                                                   │
│   Events: HouseholdCreated, MemberAdded, FundsDeposited,          │
│           PurchaseCreated, Approved, Restocked, Reimbursed,       │
│           RewardEarned, …  (hashes + pubkeys only)                │
└───────────────────────────────────────────────────────────────────┘
```

The boundary is the rule, not a suggestion: **nothing crosses it that isn't a pubkey, a lamport amount, a status enum, or a `blake3` hash.** This is what lets the program be open-source and auditable without leaking what a family buys.

---

## 2. Tech stack decisions

| Layer | Choice | Why |
| --- | --- | --- |
| Program framework | **Anchor 1.0.2** (modular template) | First-class accounts/constraints, generated typed client, idiomatic for the lifecycle logic. |
| Runtime target | **Solana SBF** (Agave) | Production target. |
| Treasury asset | **Native SOL** (PDA-held) | One account per household, no SPL token-account bookkeeping, simplest CPI path for reimbursements. Token/USDC vault is a roadmap item. |
| Hashing | **blake3** | Faster than SHA-256, project-standard per lib rules, 32-byte digest fits fixed-size accounts. |
| Unit tests | **LiteSVM** (in-process Rust VM) | 10–100× faster than `solana-test-validator`; Anchor 1.0 default; no cluster needed. |
| Integration tests | **Surfpool** (optional, later) | Realistic state + mainnet fork for end-to-end; not needed for MVP. |
| Client SDK | **Anchor-generated Rust + TypeScript IDL** | Zero hand-maintained serializers; type-safe on both sides. |
| Build orchestrator | **anchor CLI** | `anchor build` → `.so` + IDL + types; `anchor test` → `cargo test` (LiteSVM). |

### Version compatibility matrix (locked)

| Tool | Version | Notes |
| --- | --- | --- |
| `anchor-cli` | `1.0.2` | Stable Anchor 1.0. |
| `anchor-lang` crate | `1.0.2` | Must match CLI. |
| Solana CLI (Agave) | `3.1.10` | Ships `cargo-build-sbf`. |
| Rust (host) | `1.89.0` MSRV (we have `1.96.0`) | Pinned via `rust-toolchain.toml`; `1.96.0` works. |
| Rust (SBF target) | `1.89.0-sbpf-solana-v1.52` | Auto-managed by `cargo-build-sbf`. |
| Node | `24.x` | Only needed for TS templates / lint; LiteSVM tests need none. |

---

## 3. Project layout

```text
stocksie/
├── Anchor.toml                     # build/test/provider config
├── Cargo.toml                      # workspace root
├── package.json                    # TS deps (lint/idl consumers)
├── rust-toolchain.toml             # pins host Rust
├── target -> ~/.cargo/target       # SYMLINK (shared CARGO_TARGET_DIR)
│
├── plan/                           # ← this folder: single source of truth
│   ├── README.md
│   ├── 01_concept.md
│   ├── 02_architecture.md
│   └── …
│
├── docs/                           # user-facing + dev docs (output of plan/10)
│   ├── ARCHITECTURE.md
│   ├── SECURITY.md
│   └── TESTING.md
│
├── migrations/                     # deploy scripts
│
└── programs/stocksie/
    ├── Cargo.toml                  # program crate manifest
    ├── tests/                      # LiteSVM integration tests
    │   └── test_*.rs
    └── src/
        ├── lib.rs                  # declare_id! + #[program] dispatch (thin)
        ├── constants.rs            # seeds, reward schedule, limits
        ├── error.rs                # StocksieError enum
        ├── events.rs               # #[event] structs
        ├── types.rs                # Role, Status + permission helpers
        │
        ├── state/
        │   ├── mod.rs              # index only (re-exports)
        │   ├── household.rs        # Household + vault debit/credit logic
        │   ├── member.rs           # Member + reward accumulator
        │   └── purchase_request.rs # PurchaseRequest + state-machine guards
        │
        └── instructions/
            ├── mod.rs              # index only
            ├── household.rs        # init / add_member / remove_member / set_role
            ├── funds.rs            # deposit_funds / withdraw_funds
            ├── purchase.rs         # create / approve / reject / confirm_restock / close
            ├── reimburse.rs        # reimburse_buyer (vault → buyer SOL)
            └── rewards.rs          # award_reward / reward_summary
```

### Layout rules enforced

- **`mod.rs` is index-only.** No logic, no structs — just `pub mod` + `pub use`. (Per architecture rule.)
- **`types.rs` is decoupled.** Enums and their `impl` blocks live outside `state/` so instructions, events, and tests can depend on them without pulling in account structs.
- **Files stay under 1024 lines.** Split when an instruction group or state file approaches the cap.
- **`lib.rs` stays thin.** Only `declare_id!`, module declarations, and the `#[program]` dispatch block. No business logic.

---

## 4. Program structure pattern

Every instruction follows the same five-layer shape so the codebase stays predictable:

```text
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
│      - via the state struct's own methods (Household::debit_vault, etc.)
│
├─ 4. Event emission
│      - emit!(...) with pubkeys + amounts + hashes, never raw text
│
└─ 5. #[cfg(test)] unit tests
       - pure-logic tests (state machines, permission helpers) run without LiteSVM
```

The `#[program]` mod in `lib.rs` is a one-line forwarder per instruction:

```rust
pub fn initialize_household(ctx: Context<InitializeHousehold>, name_hash: [u8; 32]) -> Result<()> {
    household::initialize_household_handler(ctx, name_hash)
}
```

---

## 5. PDA derivation summary

All seeds are documented in `constants.rs` and cross-referenced from `03_account_model.md`. Canonical bumps are stored on each account at `init` and reused for CPI signing (security: bump canonicalization).

| Account | Seeds | Bump source |
| --- | --- | --- |
| `Household` (also vault) | `[HOUSEHOLD_SEED, owner]` | `ctx.bumps.household` |
| `Member` | `[MEMBER_SEED, household, wallet]` | `ctx.bumps.*_member` |
| `PurchaseRequest` | `[PURCHASE_SEED, household, &request_id.to_le_bytes()]` | `ctx.bumps.request` |

---

## 6. Environment notes (machine-specific)

These are documented so a fresh clone doesn't trip on them.

### Shared `CARGO_TARGET_DIR`

The dev machine sets `target-dir = "/Users/ozone/.cargo/target"` in `~/.cargo/config.toml`. Anchor expects artifacts in `./target/deploy/`. **Fix applied**: `./target` is a symlink to the shared dir.

```sh
rm -rf ./target
ln -s /Users/ozone/.cargo/target ./target
```

If the symlink is missing, `anchor build` will succeed but produce no `.so` in `target/deploy/`, and LiteSVM tests will fail at `include_bytes!`.

### Platform-tools architecture

If `anchor build` fails with `Bad CPU type in executable (os error 86)`, the cached platform-tools have the wrong arch. Clear and rebuild:

```sh
rm -rf ~/.cache/solana/v1.52
anchor build    # re-downloads arm64 platform-tools
```

### Program ID

- Declared in `programs/stocksie/src/lib.rs` via `declare_id!`.
- Mirrored in `Anchor.toml` under `[programs.localnet]`.
- Keypair at `target/deploy/stocksie-keypair.json`.
- All three must agree. `anchor build` enforces this; mismatched keys abort the build.

---

## 7. Build & test commands

| Command | Purpose |
| --- | --- |
| `anchor build` | Compile program to SBF, emit `.so` + IDL + TS types. |
| `anchor test` | Build + run `cargo test` (LiteSVM, in-process). |
| `cargo test -p stocksie` | Run unit tests only (no rebuild). |
| `cargo test --test test_lifecycle` | Run one LiteSVM test file. |
| `cargo clippy --fix --allow-dirty` | Lint + auto-fix per project rule. |
| `RUST_LOG=info anchor build --quiet` | Clean logs per project rule. |

---

## 8. Why not…?

- **Why not SPL token vault?** Adds a mint + ATA + transfer_checked surface for no MVP benefit. SOL is simpler, native, and the reimbursement amounts are small. Roadmap: optional USDC vault gated behind a feature flag.
- **Why not Pinocchio?** The lifecycle logic is IO-bound, not CU-bound; Anchor's constraints buy us more safety than Pinocchio's rawness saves CU. We'd reconsider for a high-frequency hot path (none in MVP).
- **Why not `init_if_needed`?** Forbidden by the security checklist (reinitialization risk). `remove_member` uses `close = caller`, which fully wipes the PDA so a clean `init` can re-add later.
- **Why not store the member roster on the `Household` account?** Fixed-size `Vec<Pubkey>` would either cap membership hard or waste rent. Per-wallet `Member` PDAs scale cleanly and let each membership be independently closed.