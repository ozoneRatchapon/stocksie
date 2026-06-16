# Stocksie — Account Model & State Machine

> **Audience:** an integrator building a client (who needs the exact account
> layout to derive PDAs and size allocations) or an auditor reviewing the
> on-chain footprint. For instruction-level detail see
> [INSTRUCTIONS.md](INSTRUCTIONS.md); for security claims see
> [SECURITY.md](SECURITY.md).

This is the polished output of the internal design in
[`../plan/03_account_model.md`](../plan/03_account_model.md) and
[`../plan/05_state_machine.md`](../plan/05_state_machine.md). Where this doc and
the plan disagree, the **code** is the source of truth — the structs below are
transcribed verbatim from [`state/`](../programs/stocksie/src/state/).

---

## 1. Account catalog

Three accounts, one vault, zero raw inventory data on chain.

| Account           | Purpose                                                             | Seeds                                                   | On-chain size |     Rent-exempt min |
| ----------------- | ------------------------------------------------------------------- | ------------------------------------------------------- | ------------: | ------------------: |
| `Household`       | Family record **and** the shared SOL vault (one PDA, two roles).    | `[HOUSEHOLD_SEED, owner]`                               |         109 B | ~1,649,520 lamports |
| `Member`          | A wallet's membership in one household (role, points, active flag). | `[MEMBER_SEED, household, wallet]`                      |          91 B | ~1,524,240 lamports |
| `PurchaseRequest` | A single shared-list entry with a strict lifecycle + proofs.        | `[PURCHASE_SEED, household, &request_id.to_le_bytes()]` |         226 B | ~2,463,840 lamports |

Seed constants (see [`constants.rs`](../programs/stocksie/src/constants.rs)):

```programs/stocksie/src/constants.rs#L15-32
pub const HOUSEHOLD_SEED: &[u8] = b"household";
pub const MEMBER_SEED: &[u8] = b"member";
pub const PURCHASE_SEED: &[u8] = b"purchase";
```

Sizes are computed by Anchor's `#[derive(InitSpace)]` and locked by the
[`test_space_budget`](../programs/stocksie/tests/test_space.rs) unit test so a
field addition or reorder is caught before it silently drifts the rent cost.

**Rent-exempt formula.** Solana's rent-exempt minimum for an account of on-chain
size `S` is `(S + 128) * 6960` lamports (`128` = per-account metadata overhead;
`6960 = lamports_per_byte_year (3480) × 2 years`). Spot-checks:

- `Household`: `(109 + 128) × 6960 = 1,649,520` ✓
- `Member`: `(91 + 128) × 6960 = 1,524,240` ✓
- `PurchaseRequest`: `(226 + 128) × 6960 = 2,463,840` ✓

---

## 2. `Household` — family record + shared vault

The verbatim struct lives at [`state/household.rs`](../programs/stocksie/src/state/household.rs) (`#[account]` at L23, `pub struct Household` at L25, fields through L60). Abridged view (the field-rationale table below is authoritative):

```/dev/null/household-struct.txt#L1-11
#[account]
#[derive(InitSpace)]
pub struct Household {
    pub owner: Pubkey,
    pub name_hash: [u8; HASH_LEN],
    pub bump: u8,
    pub member_count: u32,
    pub request_counter: u64,
    pub total_rewards_distributed: u64,
    pub vault_balance: u64,
    pub created_slot: u64,
}
```

`INIT_SPACE = 101` bytes; on-chain size = 8 (discriminator) + 101 = 109 bytes.

### Field rationale

| Field                       | Size | Why it's on chain                                                                     | Why not                                                                                 |
| --------------------------- | ---: | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `owner`                     |   32 | Root of every seed check and the `can_withdraw_funds` authority. Must be on chain.    | —                                                                                       |
| `name_hash`                 |   32 | blake3 of the off-chain display name. Tamper-evidence for a swapped household record. | The raw name is PII with no business need for the chain to read it.                     |
| `bump`                      |    1 | Avoids re-deriving on every CPI; enforces canonical bump.                             | —                                                                                       |
| `member_count`              |    4 | Enforces `MAX_MEMBERS` (= 16) cheaply without iterating `Member` PDAs.                | The full roster is intentionally not stored (privacy + rent cost).                      |
| `request_counter`           |    8 | Source of `PurchaseRequest` seed nonces; guarantees monotonic request ids.            | —                                                                                       |
| `total_rewards_distributed` |    8 | Audit number for the whole family; cross-checks the sum of `RewardEarned` events.     | —                                                                                       |
| `vault_balance`             |    8 | Mirror so events/clients show a balance without a second account read.                | The **source of truth** for SOL is `account.lamports()`; this field must never diverge. |
| `created_slot`              |    8 | Audit ordering; lets UIs show household age.                                          | —                                                                                       |

### Vault = the same PDA

The `Household` PDA **is** the vault — it holds SOL lamports directly. This
gives exactly one rent-exempt account per family, makes solvency a single
`account.lamports()` read, and lets reimbursements be direct lamport moves
signed by the PDA (no `system_program::transfer`, which would require a
system-owned signer).

`vault_balance` is a **convenience mirror**, kept in sync by
`Household::credit_vault` / `Household::debit_vault`. The runtime's
`account.lamports()` is authoritative; if the two ever disagree the program is
buggy.

### Vault methods

`debit_vault` is the security-critical one — a direct lamport move out of the
program-owned PDA with an explicit zero, sufficiency, and alias guard before
the move. `credit_vault` (used by `deposit_funds`) is the mirror: a
system-program `transfer` CPI (the source is a signer wallet) plus a checked
`vault_balance += lamports`.

```programs/stocksie/src/state/household.rs#L118-156
    pub fn debit_vault(
        &mut self,
        vault: &AccountInfo<'_>,
        to: &AccountInfo<'_>,
        lamports: u64,
    ) -> Result<()> {
        if lamports > self.vault_balance {
            return Err(StocksieError::InsufficientVaultFunds.into());
        }
        if lamports == 0 {
            return Err(StocksieError::ZeroWithdrawal.into());
        }

        // Defensive: never allow the vault and destination to alias.
        // (Security checklist: duplicate mutable accounts can corrupt state.)
        if vault.key() == to.key() {
            return Err(StocksieError::HouseholdAccountMismatch.into());
        }

        // Program-owned PDA vault → arbitrary destination. Direct lamport move
        // is the canonical pattern for a program-owned SOL vault: a PDA cannot
        // be a system-program signer, so `system_program::transfer` is not an
        // option here. Debit the source first, credit the destination second;
        // both `RefMut<&mut u64>` borrows resolve cleanly because the accounts
        // are guaranteed distinct by the alias check above.
        **vault.try_borrow_mut_lamports()? = vault
            .lamports()
            .checked_sub(lamports)
            .ok_or(StocksieError::Overflow)?;
        **to.try_borrow_mut_lamports()? = to
            .lamports()
            .checked_add(lamports)
            .ok_or(StocksieError::Overflow)?;

        self.vault_balance = self
            .vault_balance
            .checked_sub(lamports)
            .ok_or(StocksieError::Overflow)?;
        Ok(())
    }
```

| Method            | Effect                                                                                                                                          | Used by                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `credit_vault`    | System-program CPI `transfer` (source is a signer wallet), then `vault_balance += lamports`.                                                    | `deposit_funds`                     |
| `debit_vault`     | Direct lamport move out of the program-owned PDA, then `vault_balance -= lamports`. Rejects aliasing of `vault == to`, zero, and insufficiency. | `reimburse_buyer`, `withdraw_funds` |
| `next_request_id` | `request_counter += 1` and return new value (first id is `1`).                                                                                  | `create_purchase_request`           |
| `record_rewards`  | `total_rewards_distributed += points` with checked add.                                                                                         | every reward path                   |

---

## 3. `Member` — a wallet's membership

The verbatim struct lives at [`state/member.rs`](../programs/stocksie/src/state/member.rs) (`#[account]` at L26, `pub struct Member` at L28, fields through L56). Abridged view (the field-rationale table below is authoritative):

```/dev/null/member-struct.txt#L1-10
#[account]
#[derive(InitSpace)]
pub struct Member {
    pub household: Pubkey,
    pub wallet: Pubkey,
    pub role: Role,
    pub reward_points: u64,
    pub active: bool,
    pub bump: u8,
    pub joined_slot: u64,
}
```

`INIT_SPACE = 83` bytes; on-chain size = 91 bytes.

### Field rationale

| Field           | Size | Why                                                                                          | Notes                                                         |
| --------------- | ---: | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `household`     |   32 | `has_one = household` in every instruction guards against cross-family account substitution. | Required by the data-matching security check.                 |
| `wallet`        |   32 | Must equal the seed wallet; `seeds = [..., wallet.as_ref()]` enforces it.                    | Also the key the client uses to find the account.             |
| `role`          |    1 | Drives every `Role::can_*()` gate (`Owner`, `Parent`, `Child`, `Guest`).                     | `Owner` is only ever set by `initialize_household`.           |
| `reward_points` |    8 | Member's lifetime score for the gamification loop.                                           | Only increments (`add_reward`); never decremented in the MVP. |
| `active`        |    1 | Reserved for a future suspension flow.                                                       | Always `true` between `init` and `close` in the MVP.          |
| `bump`          |    1 | Canonical bump storage.                                                                      | —                                                             |
| `joined_slot`   |    8 | Audit ordering.                                                                              | —                                                             |

### Hard close (not soft delete)

`remove_member` uses Anchor's `close = caller`: rent is refunded to the caller,
the data is zero-filled, and ownership is reassigned to the system program. A
clean `init` can then re-add the same wallet later — no `init_if_needed`
required (security checklist). Historical membership is preserved by the
permanent `MemberAdded` / `MemberRemoved` / `RewardEarned` events, which live
outside any closable account.

The `active` field is retained on the struct for forward-compatibility (e.g. a
temporary suspension flow) but is always `true` between `init` and `close` in
the MVP.

### Member methods

| Method                             | Effect                                                                 |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `add_reward(points)`               | Checked `reward_points += points`; rejects `0` with `ZeroReward`.      |
| `deactivate()` / `reactivate()`    | Flip `active`. Reserved for a future suspension flow.                  |
| `can_transact()` / `can_approve()` | `active && role.can_*()` — single call site for "can this wallet act". |

---

## 4. `PurchaseRequest` — shared-list entry + lifecycle

The verbatim struct lives at [`state/purchase_request.rs`](../programs/stocksie/src/state/purchase_request.rs) (`#[account]` at L33, `pub struct PurchaseRequest` at L35, fields through L91). Abridged view (the field-rationale table below is authoritative):

```/dev/null/purchase-request-struct.txt#L1-17
#[account]
#[derive(InitSpace)]
pub struct PurchaseRequest {
    pub household: Pubkey,
    pub buyer: Pubkey,
    pub request_id: u64,
    pub amount_lamports: u64,
    pub item_hash: [u8; HASH_LEN],
    pub unit_cost_hash: [u8; HASH_LEN],
    pub status: Status,
    pub approved_by: Pubkey,
    pub approved_slot: u64,
    pub restocked_slot: u64,
    pub reimbursed_amount: u64,
    pub reward_earned: u64,
    pub bump: u8,
    pub created_slot: u64,
}
```

`INIT_SPACE = 218` bytes; on-chain size = 226 bytes.

### Field rationale

| Field                                               |   Size | Why                                                                                         | Privacy note                                |
| --------------------------------------------------- | -----: | ------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `household`                                         |     32 | `has_one` guard.                                                                            | Pubkey — public.                            |
| `buyer`                                             |     32 | `confirm_restock` must be signed by this wallet; reimbursement target.                      | Pubkey — public.                            |
| `request_id`                                        |      8 | Seed component; monotonic per household (first id is `1`).                                  | —                                           |
| `amount_lamports`                                   |      8 | Reimbursement ceiling; the program enforces `payout ≤ amount`.                              | Amount in lamports — public.                |
| `item_hash`                                         |     32 | blake3 of item name + quantity. Proves _which_ off-chain record this references.            | **Hash only.** Raw item/qty never on chain. |
| `unit_cost_hash`                                    |     32 | blake3 of the best-value recommendation snapshot. Proves _which_ price comparison was used. | **Hash only.** Prices never on chain.       |
| `status`                                            |      1 | The lifecycle state machine.                                                                | Enum — public.                              |
| `approved_by`                                       |     32 | Audit of who authorized the spend.                                                          | Pubkey — public.                            |
| `approved_slot` / `restocked_slot` / `created_slot` | 8 each | Audit timing; lets UIs show age and stage duration.                                         | —                                           |
| `reimbursed_amount`                                 |      8 | Actual payout (may be < ceiling if buyer spent less). Guards double-reimbursement.          | —                                           |
| `reward_earned`                                     |      8 | Per-request reward ledger so each lifecycle reward stage fires at most once.                | —                                           |
| `bump`                                              |      1 | Canonical bump storage.                                                                     | —                                           |

### The `request_id` seed pattern (monotonic from 1)

`request_counter` starts at `0`. The `PurchaseRequest` PDA seed reads
`request_counter.wrapping_add(1)` during Anchor's validation pass (before the
handler runs); the handler then calls `next_request_id()` to increment the
counter to exactly that value. The derived address and the stored `request_id`
are therefore provably consistent, and the first request id is `1` (0 is
reserved as the "no request yet" client sentinel).

---

## 5. State machine

```/dev/null/state-machine.txt#L1-7
Pending ──approve──▶ Approved ──confirm_restock──▶ Restocked ──reimburse──▶ Reimbursed
   │                     │
   └──────reject─────────┴──▶ Rejected   (terminal)
                                      Reimbursed (terminal)
```

Each transition is a guard method on `PurchaseRequest` that asserts the
precondition and returns the new `Status` on success — the state machine has
exactly one definition (DRY).

| Method                            | Precondition                                  | Effect                                                           |
| --------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `transition_approved(now)`        | `Pending`                                     | `status = Approved`, `approved_slot = now`                       |
| `transition_rejected()`           | `Pending` **or** `Approved`                   | `status = Rejected` (terminal)                                   |
| `transition_restocked(now)`       | `Approved`                                    | `status = Restocked`, `restocked_slot = now`                     |
| `transition_reimbursed(lamports)` | `Restocked`, `0 < lamports ≤ amount_lamports` | `status = Reimbursed` (terminal), `reimbursed_amount = lamports` |
| `record_reward_stage(points)`     | —                                             | `reward_earned += points` (idempotency ledger)                   |

### Per-state invariants (what the program guarantees at each node)

- **`Pending`** — created by an active transacting member; `approved_by` is
  `Pubkey::default()`; no funds have moved.
- **`Approved`** — an active Owner/Parent (`can_approve`) who is **not** the
  buyer has signed; `approved_by == caller`, `approved_slot > 0`.
- **`Restocked`** — the recorded buyer (`request.buyer == signer`) attested the
  item is replenished; `restocked_slot > 0`; the buyer earned
  `REWARD_RESTOCK_COMPLETED`.
- **`Reimbursed`** (terminal) — the vault paid `reimbursed_amount` (≤ ceiling)
  to the buyer; `reimbursed_amount > 0`; the buyer earned
  `REWARD_FULL_RUN_COMPLETED`. Cannot be re-entered.
- **`Rejected`** (terminal) — an approver declined; no funds moved. Reachable
  from `Pending` or `Approved` (an approver can undo a mistaken approval before
  the buyer shops).

### Forbidden transitions

Every rejected move returns a specific `StocksieError` variant, asserted by a
named test (see [SECURITY.md](SECURITY.md) and [TESTING.md](TESTING.md)).

| From         | Attempted move                 | Error variant                  | Verifying test                          |
| ------------ | ------------------------------ | ------------------------------ | --------------------------------------- |
| `Pending`    | `confirm_restock`              | `InvalidStatusTransition`      | `confirm_restock_from_pending_rejected` |
| `Pending`    | `reimburse_buyer`              | `InvalidStatusTransition`      | `reimburse_from_pending_rejected`       |
| `Approved`   | `approve` again                | `InvalidStatusTransition`      | `approve_from_approved_rejected`        |
| `Restocked`  | `reject`                       | `InvalidStatusTransition`      | `reject_from_restocked_rejected`        |
| `Restocked`  | `approve`                      | `InvalidStatusTransition`      | `approve_from_terminal_rejected`        |
| `Reimbursed` | `reimburse` again              | `AlreadyReimbursed`            | `double_reimburse`                      |
| `Rejected`   | any transition                 | `InvalidStatusTransition`      | `approve_from_terminal_rejected`        |
| any          | `reimburse(0)`                 | `ZeroWithdrawal`               | `reimburse_zero`                        |
| `Restocked`  | `reimburse(> amount_lamports)` | `ReimbursementExceedsApproved` | `reimburse_over_ceiling`                |
| `Approved`   | `reimburse`                    | `InvalidStatusTransition`      | `reimburse_from_approved_rejected`      |
| `Rejected`   | `reimburse`                    | `InvalidStatusTransition`      | `reimburse_from_rejected_rejected`      |
| non-terminal | `close_purchase_request`       | `InvalidStatusTransition`      | (status guard in the accounts struct)   |

---

## 6. Worst-case household footprint

A maxed-out household (1 owner + 15 members, 0 open requests):

```text
Household          109 B
Member × 16      1,456 B   (16 × 91)
                ─────────
Total            1,565 B   ≈ 0.022 SOL rent locked
```

Plus one `PurchaseRequest` (226 B ≈ 0.0025 SOL) per open/unclosed request.
Closable lifecycle keeps long-tail rent bounded: closed requests and removed
members refund their rent to the caller.

---

## Where to go next

- [INSTRUCTIONS.md](INSTRUCTIONS.md) — every instruction's accounts, args,
  effect, events, and errors.
- [SECURITY.md](SECURITY.md) — the vulnerability matrix and the named test
  behind each defense.
- [PRIVACY.md](PRIVACY.md) — the full on-chain/off-chain boundary contract.
