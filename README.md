# Stocksie

> The anti-out-of-stock household coordination platform — on Solana.
> Track essentials, kill duplicate purchases, approve shared spending,
> reimburse buyers, and reward smart buying.

Stocksie turns household-shopping friction into tiny, auditable, on-chain
moments: the "last paper towel is gone" tap, the approval before a spend, the
reimbursement after a restock, and the reward for picking the cheapest pack.
The trust-critical state (who's a member, who approved what, who got paid, who
earned points) lives in an Anchor program; the privacy-sensitive detail (item
names, quantities, receipts, prices) never touches the ledger.

**Privacy boundary.** The chain proves _that_ your family spent, approved, and
reimbursed. It never learns _what_ you bought, how much, or from where. The only
shapes that cross the on-chain boundary are pubkeys, `u64`/`u32`/`u8` integers,
small enums (`Role`, `Status`), booleans, and `[u8; 32]` blake3 hashes. Raw item
names, quantities, receipts, and prices never touch the ledger. See
[docs/PRIVACY.md](docs/PRIVACY.md) for the full boundary contract.

---

## The five core features

1. **Last-One Tap** — a single tap logs that the final item ran out and opens a
   `PurchaseRequest`. The shopping list is never out of sync because the list
   _is_ the on-chain account set.
2. **Shared household shopping list** — every member sees the same status for
   every request: `Pending → Approved → Restocked → Reimbursed` (or `Rejected`).
3. **Best-value recommendation** — an off-chain engine compares price-per-unit
   across pack sizes; only a `blake3` hash of the recommendation snapshot is
   recorded, so prices never leak.
4. **Household fund & reimbursement** — the `Household` PDA _is_ the shared SOL
   vault. Funds leave it only through an approved, restocked request.
5. **Family reward & learning mode** — members earn points for helpful actions
   (reporting low stock, completing a restock, picking the best value, finishing
   a full grocery run). The audit trail of _why_ each point was granted is
   tamper-proof.

---

## Why Solana?

- **Program-controlled vault** — the family treasury is a PDA; funds move only
  when the program's rules are satisfied. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
- **On-chain approvals & reimbursements** — state transitions are signed and
  final. No "I said yes in the group chat" disputes.
- **Verifiable events** — `PurchaseCreated`, `PurchaseApproved`, `Restocked`,
  `Reimbursed`, `RewardEarned` form a tamper-proof contribution history that any
  family member can audit without trusting a single phone.

What does **not** go on chain: raw item names, quantities, receipts, prices, and
consumption patterns. Those stay off-chain; the ledger stores only `blake3`
hashes, pubkeys, amounts, and status. See [docs/PRIVACY.md](docs/PRIVACY.md).

---

## Architecture at a glance

```text
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

The boundary is the rule, not a suggestion: nothing crosses it that isn't a
pubkey, a lamport amount, a status enum, or a `blake3` hash.

---

## Quickstart

You need: Rust toolchain, `anchor-cli` `1.0.2`, and the Agave Solana CLI
(`cargo-build-sbf`). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §Appendix
for the version matrix and machine-specific setup notes.

```sh
# One-time: this repo expects a shared CARGO_TARGET_DIR via a ./target
# symlink (see docs/ARCHITECTURE.md §Appendix). If ./target is missing:
ln -s ~/.cargo/target ./target

# Build the program to SBF; emits the .so + IDL + TS types.
anchor build

# Run the full LiteSVM test suite (24 unit + 51 integration = 75 tests).
cargo test -p stocksie
```

Expected output tail:

```text
test result: ok. 24 passed; 0 failed; ...
     Running tests/test_lifecycle.rs
test full_lifecycle_reaches_reimbursed ... ok
...
test result: ok. 75 passed; 0 failed; ...
```

Run a single test file:

```sh
cargo test -p stocksie --test test_lifecycle
```

Pure unit tests (no `anchor build` required, runs in microseconds):

```sh
cargo test -p stocksie --lib
```

Lint gate (must be clean before commit):

```sh
cargo clippy -p stocksie --all-targets -- -D warnings
cargo fmt --all -- --check
```

---

## Project layout

```text
stocksie/
├── Anchor.toml                 # build / test / provider config
├── Cargo.toml                  # workspace root (overflow-checks = true)
├── README.md                   # this file
├── CHANGELOG.md                # release log
├── docs/                       # public-facing docs (output of plan/10)
├── plan/                       # internal design rationale (the source of truth)
└── programs/stocksie/
    ├── Cargo.toml              # program crate manifest
    ├── tests/                  # LiteSVM integration tests (51 tests)
    │   ├── helpers/mod.rs      # shared harness: setup_svm, derive_*, send
    │   └── test_*.rs           # one file per concern
    └── src/
        ├── lib.rs              # declare_id! + #[program] dispatch (thin)
        ├── constants.rs        # seeds, reward schedule, size limits
        ├── error.rs            # StocksieError enum
        ├── events.rs           # 11 #[event] structs (audit trail)
        ├── types.rs            # Role, Status + permission helpers
        ├── state/              # Household, Member, PurchaseRequest + logic
        └── instructions/       # household, funds, purchase, reimburse, rewards
```

**Program ID:** `At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj`
(declared in `programs/stocksie/src/lib.rs`, mirrored in `Anchor.toml`).

---

## Status

Phases 0–11 complete: the program ships all 14 instructions across the
household / funds / purchase / reimburse / rewards groups, all 11 events, and a
75-test LiteSVM suite covering lifecycle, permissions, reimbursement edge cases,
security defenses, cross-cutting invariants, the privacy grep, and the space
budget. See [plan/09_build_phases.md](plan/09_build_phases.md) for the per-phase
build tracker.

---

## Where to read next

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — how the pieces fit together,
  the five-layer instruction shape, PDA seeds, and environment quirks.
- [docs/INSTRUCTIONS.md](docs/INSTRUCTIONS.md) — the full on-chain surface:
  every instruction's accounts, args, effect, events, and errors.
- [plan/](plan/) — the internal design rationale (concept, architecture, account
  model, instructions, state machine, events, security, testing, build phases).

Other docs in [`docs/`](docs/): [ACCOUNTS.md](docs/ACCOUNTS.md),
[SECURITY.md](docs/SECURITY.md), [TESTING.md](docs/TESTING.md),
[PRIVACY.md](docs/PRIVACY.md), [ROADMAP.md](docs/ROADMAP.md).
