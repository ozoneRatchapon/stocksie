# Stocksie — On-chain Account Model

> Three accounts, one vault, zero raw inventory data on chain.

This document specifies every on-chain account: its seeds, its fields, its space budget, and the privacy rationale for what is and isn't stored. It is the source the `state/` Rust files implement against.

---

## 1. Account catalog

| Account | Purpose | Seeds | Lifetime |
| --- | --- | --- | --- |
| `Household` | Family record **and** the shared SOL vault (one PDA, two roles). | `[HOUSEHOLD_SEED, owner]` | Until owner drains + closes (future); MVP: permanent. |
| `Member` | A wallet's membership in one household (role, points, active flag). | `[MEMBER_SEED, household, wallet]` | Closable by `remove_member`; re-creatable on re-add. |
| `PurchaseRequest` | A single shared-list entry with a strict lifecycle + proofs. | `[PURCHASE_SEED, household, &request_id.to_le_bytes()]` | Closable after `Reimbursed`/`Rejected` via `close_purchase_request`. |

Seeds are defined as constants in `programs/stocksie/src/constants.rs`:

| Constant | Value | Used by |
| --- | --- | --- |
| `HOUSEHOLD_SEED` | `b"household"` | `Household` PDA |
| `MEMBER_SEED` | `b"member"` | `Member` PDA |
| `PURCHASE_SEED` | `b"purchase"` | `PurchaseRequest` PDA |

**Why these seeds?**
- `Household` keyed by `owner` so one wallet can run multiple households (e.g. a parent in two families) without address collisions.
- `Member` keyed by `(household, wallet)` so the same human can belong to multiple households under different roles — and so a `Member` from family A can never authorize an action in family B.
- `PurchaseRequest` keyed by `(household, request_id)` where `request_id` is the household's monotonic counter. This makes each request address deterministic and replay-safe, and lets clients derive the next request's address before submitting.

**Bump canonicalization (security):** every account stores its canonical `bump` at `init` (from `ctx.bumps.*`) and reuses that stored byte for CPI signing. We never re-run `find_program_address` on a hot path, and we never trust a caller-supplied bump.

---

## 2. `Household` — family record + shared vault

```rust
#[account]
#[derive(InitSpace)]
pub struct Household {
    pub owner: Pubkey,                    // 32  — household creator, irremovable
    pub name_hash: [u8; 32],              // 32  — blake3 of off-chain display name
    pub bump: u8,                         //  1  — canonical PDA bump
    pub member_count: u32,                //  4  — active members, ≤ MAX_MEMBERS
    pub request_counter: u64,             //  8  — monotonic id source for requests
    pub total_rewards_distributed: u64,   //  8  — lifetime points ever awarded
    pub vault_balance: u64,               //  8  — mirror of PDA lamports (convenience)
    pub created_slot: u64,                //  8  — audit ordering
}
// INIT_SPACE = 101 bytes; on-chain size = 8 (disc) + 101 = 109 bytes
```

### Field rationale

| Field | Why it's on chain | Why not |
| --- | --- | --- |
| `owner` | Root of every seeds check + the `can_withdraw_funds` authority. Must be on chain. | — |
| `name_hash` | Tamper-evidence for the off-chain display name (detect a swapped household record). | The raw name is PII + no business need for the chain to read it. |
| `bump` | Avoids re-deriving on every CPI; enforces canonical bump. | — |
| `member_count` | Enforces `MAX_MEMBERS` cap cheaply (no need to iterate `Member` PDAs). | The full roster is intentionally not stored (privacy + rent cost). |
| `request_counter` | Source of `PurchaseRequest` seed nonces; guarantees monotonic ids. | — |
| `total_rewards_distributed` | Audit number for the whole family; cross-checks sum of `RewardEarned` events. | — |
| `vault_balance` | Mirror so events/clients show a balance without a second account read. | The **source of truth** for SOL is `account.lamports()`; this field must never diverge. |
| `created_slot` | Audit ordering; lets UIs show "household age". | — |

### Vault = the same PDA

The `Household` PDA **is** the vault — it holds SOL lamports directly. This gives us:

- Exactly one rent-exempt account per family.
- Solvency is a single `account.lamports()` read.
- Reimbursements are direct lamport moves signed by the PDA (no system-program `transfer`, which would require a system-owned signer).

`vault_balance` is a **convenience mirror**, kept in sync by `Household::credit_vault` / `Household::debit_vault`. The runtime's `account.lamports()` is authoritative; if the two ever disagree the program is buggy.

### Vault methods (in `state/household.rs`)

| Method | Effect | Used by |
| --- | --- | --- |
| `credit_vault(from, vault, system_program, lamports)` | System-program CPI `transfer` (source is a signer wallet), then `vault_balance += lamports`. | `deposit_funds` |
| `debit_vault(vault, to, lamports)` | Direct lamport move out of the program-owned PDA, then `vault_balance -= lamports`. Rejects aliasing of `vault == to`. | `reimburse_buyer`, `withdraw_funds` |
| `next_request_id()` | `request_counter += 1` and return new value (first id is `1`). | `create_purchase_request` |
| `record_rewards(points)` | `total_rewards_distributed += points` with checked add. | every reward path |

---

## 3. `Member` — a wallet's membership

```rust
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub household: Pubkey,      // 32  — back-reference, used by has_one
    pub wallet: Pubkey,         // 32  — the wallet that holds this membership
    pub role: Role,             //  1  — Owner | Parent | Child | Guest
    pub reward_points: u64,     //  8  — cumulative points earned by this member
    pub active: bool,           //  1  — soft-delete flag
    pub bump: u8,               //  1  — canonical PDA bump
    pub joined_slot: u64,       //  8  — audit ordering
}
// INIT_SPACE = 83 bytes; on-chain size = 8 (disc) + 83 = 91 bytes
```

### Field rationale

| Field | Why | Notes |
| --- | --- | --- |
| `household` | `has_one = household` in every instruction guards against cross-family account substitution. | Required by the data-matching security check. |
| `wallet` | Must equal the seed wallet; the `seeds = [..., wallet.as_ref()]` constraint enforces it. | Also the key the client uses to find the account. |
| `role` | Drives every `Role::can_*()` gate. | `Owner` only ever set by `initialize_household`. |
| `reward_points` | Member's lifetime score for the gamification loop (Feature 2.5). | Only increments (`add_reward`); never decremented in MVP. |
| `active` | `remove_member` flips this to `false`. | Soft delete preserves audit history; `close` is used for hard close in `remove_member` (see below). |
| `bump` | Canonical bump storage. | — |
| `joined_slot` | Audit ordering. | — |

### Soft delete vs. hard close

Two designs were considered:

1. **Soft delete** — `remove_member` sets `active = false` and keeps the account. Pro: full audit of historical members. Con: rent stays locked forever; the wallet can't be cleanly re-added.
2. **Hard close** — `remove_member` uses Anchor's `close = caller`. Pro: rent reclaimed, PDA wiped, clean re-add via fresh `init` (no `init_if_needed`). Con: the historical `Member` row is gone (but its events persist forever).

**Decision: hard close.** Historical membership is preserved by the `MemberAdded` / `MemberRemoved` / `RewardEarned` events, which are emitted regardless and live outside any closable account. This keeps the rent model clean and lets us avoid `init_if_needed` entirely (security checklist). The `active` field is retained on the struct for forward-compatibility (e.g. a temporary suspension flow) but is always `true` between `init` and `close` in the MVP.

### Member methods (in `state/member.rs`)

| Method | Effect |
| --- | --- |
| `add_reward(points)` | Checked `reward_points += points`; rejects `0`. |
| `deactivate()` / `reactivate()` | Flip `active`. (Reserved for future suspension flow.) |
| `can_transact()` / `can_approve()` | `active && role.can_*()` — single call site for "can this wallet act". |

---

## 4. `PurchaseRequest` — shared-list entry + lifecycle

```rust
#[account]
#[derive(InitSpace)]
pub struct PurchaseRequest {
    pub household: Pubkey,          // 32  — back-reference for has_one
    pub buyer: Pubkey,              // 32  — who shops + who gets reimbursed
    pub request_id: u64,            //  8  — monotonic id, also in the seed
    pub amount_lamports: u64,       //  8  — requested spend = reimbursement ceiling
    pub item_hash: [u8; 32],        // 32  — blake3 of item name + quantity
    pub unit_cost_hash: [u8; 32],   // 32  — blake3 of best-value snapshot
    pub status: Status,             //  1  — Pending|Approved|Restocked|Reimbursed|Rejected
    pub approved_by: Pubkey,        // 32  — who approved (default() until approval)
    pub approved_slot: u64,         //  8  — 0 until approval
    pub restocked_slot: u64,        //  8  — 0 until restock
    pub reimbursed_amount: u64,     //  8  — 0 until reimbursement; ≤ amount_lamports
    pub reward_earned: u64,         //  8  — points already granted against this request
    pub bump: u8,                   //  1  — canonical PDA bump
    pub created_slot: u64,          //  8  — audit ordering
}
// INIT_SPACE = 226 bytes; on-chain size = 8 (disc) + 226 = 234 bytes
```

### Field rationale

| Field | Why | Privacy note |
| --- | --- | --- |
| `household` | `has_one` guard. | Pubkey — public. |
| `buyer` | `confirm_restock` must be signed by this wallet; reimbursement target. | Pubkey — public. |
| `request_id` | Seed component; monotonic per household. | — |
| `amount_lamports` | Reimbursement ceiling; the program enforces `payout ≤ amount`. | Amount in lamports — public. |
| `item_hash` | blake3 of item name + quantity. Proves *which* off-chain record this request references, without revealing it. | **Hash only.** Raw item/qty never on chain. |
| `unit_cost_hash` | blake3 of the best-value recommendation snapshot (Feature 2.3). Proves *which* price comparison was used. | **Hash only.** Prices never on chain. |
| `status` | The lifecycle state machine. See `05_state_machine.md`. | Enum — public. |
| `approved_by` | Audit of who authorized the spend (Feature 3.4). | Pubkey — public. |
| `approved_slot` / `restocked_slot` / `created_slot` | Audit timing; lets UIs show age and duration of each stage. | — |
| `reimbursed_amount` | Actual payout (may be < ceiling if buyer spent less). Guards double-reimbursement (non-zero ⇒ already paid). | — |
| `reward_earned` | Per-request reward ledger so each lifecycle reward stage fires at most once (idempotent guard). | — |
| `bump` | Canonical bump storage. | — |

### Lifecycle guards (in `state/purchase_request.rs`)

The state machine has exactly one source of truth. Each transition is a method that asserts the precondition and returns the new `Status`:

| Method | Precondition | Effect |
| --- | --- | --- |
| `transition_approved(now)` | `Pending` | `status = Approved`, `approved_slot = now` |
| `transition_rejected()` | `Pending` or `Approved` | `status = Rejected` (terminal) |
| `transition_restocked(now)` | `Approved` | `status = Restocked`, `restocked_slot = now` |
| `transition_reimbursed(lamports)` | `Restocked`, `0 < lamports ≤ amount_lamports` | `status = Reimbursed` (terminal), `reimbursed_amount = lamports` |
| `record_reward_stage(points)` | — | `reward_earned += points` (idempotency ledger) |

Calling a transition from the wrong state returns `StocksieError::InvalidStatusTransition` (or `AlreadyReimbursed` for the specific double-pay case). See `05_state_machine.md` for the full diagram and rationale.

---

## 5. Space & rent budget

Sizes are computed by Anchor's `#[derive(InitSpace)]` and verified in the unit test `test_space_budget` (`tests/test_space.rs`). The `8 + INIT_SPACE` form (8-byte discriminator + data) is used in every `space = ...` constraint.

| Account | Data (`INIT_SPACE`) | On-chain size | Rent-exempt min | Notes |
| --- | ---: | ---: | ---: | --- |
| `Household` | 101 B | 109 B | ~1,649,520 lamports (~0.00165 SOL) | Paid by `owner` at `init`. |
| `Member` | 83 B | 91 B | ~1,524,240 lamports (~0.00152 SOL) | Paid by caller at `add_member`; refunded to caller at `close`. |
| `PurchaseRequest` | 226 B | 234 B | ~2,519,520 lamports (~0.00252 SOL) | Paid by creator at `create_purchase_request`; refunded at `close_purchase_request`. |

### Rent-exempt formula

Solana's rent-exempt minimum for an account of on-chain size `S` is `(S + 128) * 6960` lamports, where:
- `128` is the per-account metadata overhead (pubkey, owner, lamports, rent epoch, etc.),
- `6960 = lamports_per_byte_year (3480) × 2 years`.

Spot-checks:
- `Household`: `(109 + 128) × 6960 = 237 × 6960 = 1,649,520` ✓
- `Member`: `(91 + 128) × 6960 = 219 × 6960 = 1,524,240` ✓
- `PurchaseRequest`: `(234 + 128) × 6960 = 362 × 6960 = 2,519,520` ✓

The numbers above are **targets the implementation must match**; if `INIT_SPACE` drifts (e.g. a field is added), update this table and the `test_space_budget` assertion together.

### Worst-case household footprint

A maxed-out household in the MVP (1 owner + 15 members, 0 open requests) occupies:

```
Household          109 B
Member × 16       1456 B   (16 × 91)
                ─────────
Total            1565 B   ≈ 0.022 SOL rent locked
```

Plus one `PurchaseRequest` (234 B ≈ 0.0025 SOL) for every open/unclosed request. Closable lifecycle keeps long-tail rent bounded: closed requests and removed members refund their rent.

---

## 6. Privacy budget — what never crosses the boundary

This is the invariant the whole privacy story rests on. **No instruction argument, no account field, and no event payload may contain raw item names, quantities, receipts, prices, or any free-form household text.** Permitted on-chain data shapes are:

| Shape | Examples | Allowed |
| --- | --- | --- |
| `Pubkey` | member wallets, approver, buyer | ✓ |
| `u64` (lamports, points, slots, counters) | amount, vault_balance, reward_points | ✓ |
| `[u8; 32]` (blake3 digest) | name_hash, item_hash, unit_cost_hash, reason_hash | ✓ |
| Small enums (`Role`, `Status`) | role, status | ✓ |
| `bool`, `u8`, `u32` | active, bump, member_count | ✓ |
| `String` / `Vec<u8>` of free text | item name, receipt OCR text, reason text | ✗ — hash off chain first |
| Raw prices / pack sizes | unit prices, grams, rolls | ✗ — only `unit_cost_hash` of a snapshot |

A grep-based guard (`tests/test_privacy_invariant.rs`) asserts that no `String` field appears in any `#[account]` or `#[event]` struct, keeping the invariant machine-checkable for the life of the codebase.