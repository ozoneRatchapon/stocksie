# Stocksie — Instructions

> **Audience:** a client developer wiring up transactions, or a security reviewer
> mapping the attack surface. For the account layouts these instructions touch
> see [ACCOUNTS.md](ACCOUNTS.md); for the defenses behind each constraint see
> [SECURITY.md](SECURITY.md); for the events they emit see §3 below.

This is the polished output of the internal design in
[`../plan/04_instructions.md`](../plan/04_instructions.md) and
[`../plan/06_events.md`](../plan/06_events.md). Where this doc and the plan
disagree, the **code** is the source of truth — signatures and constraints below
are transcribed from [`instructions/`](../programs/stocksie/src/instructions/).

**Program ID:** `At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj`
(declared in [`lib.rs`](../programs/stocksie/src/lib.rs), mirrored in
[`Anchor.toml`](../Anchor.toml)).

The program ships **14 instructions** across five groups (household, funds,
purchase, reimburse, rewards) and emits **12 events** (see §3).

---

## The boundary rule (canonical privacy statement)

The chain proves _that_ your family spent, approved, and reimbursed. It never
learns _what_ you bought, how much, or from where. The only shapes that cross
the on-chain boundary are pubkeys, `u64`/`u32`/`u8` integers, small enums
(`Role`, `Status`), booleans, and `[u8; 32]` blake3 hashes. Raw item names,
quantities, receipts, and prices never touch the ledger. See
[PRIVACY.md](PRIVACY.md) for the full boundary contract.

Every instruction argument below is one of those permitted shapes — there is no
`String`, no raw text, and no price field anywhere in the surface.

---

## 1. Authority model — quick reference

Every mutating instruction loads the caller's `Member` PDA via
`seeds = [MEMBER_SEED, household, caller]`, checks `active`, and applies a role
gate. The auth root is the **seed**, not a stored roster.

| Instruction                | Group     | Caller authority gate                       | Notable constraint                           |
| -------------------------- | --------- | ------------------------------------------- | -------------------------------------------- |
| `initialize_household`     | household | new `owner` signer                          | `init` household + owner `Member`            |
| `add_member`               | household | Owner (`can_manage_members`)                | `init` new `Member`; rejects `role == Owner` |
| `remove_member`            | household | Owner (`can_manage_members`)                | `close = caller`; rejects removing Owner     |
| `set_role`                 | household | Owner (`can_manage_members`)                | rejects `new_role == Owner`                  |
| `deposit_funds`            | funds     | any active member (Guest included)          | system-program `transfer` into vault         |
| `withdraw_funds`           | funds     | Owner (`can_withdraw_funds`)                | destination fixed to the recorded Owner      |
| `create_purchase_request`  | purchase  | `can_transact` (Owner/Parent/Child)         | `init` request; amount range-checked         |
| `approve_purchase_request` | purchase  | `can_approve` (Owner/Parent), **≠ buyer**   | `transition_approved`; no self-approval      |
| `reject_purchase_request`  | purchase  | `can_approve` (Owner/Parent)                | `transition_rejected` (Pending or Approved)  |
| `confirm_restock`          | purchase  | recorded buyer only                         | `transition_restocked`; double data-match    |
| `close_purchase_request`   | purchase  | Owner **or** request buyer; terminal status | `close = caller`                             |
| `reimburse_buyer`          | reimburse | `can_approve` (Owner/Parent)                | `transition_reimbursed` + vault debit        |
| `award_reward`             | rewards   | `can_award_rewards` (Owner/Parent)          | `points > 0`; targets any active member      |
| `reward_summary`           | rewards   | any active member                           | read-only sentinel emit                      |

### Roles and gates

The four roles (`Owner`, `Parent`, `Child`, `Guest`) and their predicate
helpers live in [`types.rs`](../programs/stocksie/src/types.rs). A helper returns
`true` only when both `active && role.can_*()` hold (see
[`Member::can_transact`](../programs/stocksie/src/state/member.rs)).

| Role     | `can_transact` | `can_approve` | `can_manage_members` | `can_award_rewards` | `can_withdraw_funds` |
| -------- | :------------: | :-----------: | :------------------: | :-----------------: | :------------------: |
| `Owner`  |       ✓        |       ✓       |          ✓           |          ✓          |          ✓           |
| `Parent` |       ✓        |       ✓       |          ✗           |          ✓          |          ✗           |
| `Child`  |       ✓        |       ✗       |          ✗           |          ✗          |          ✗           |
| `Guest`  |       ✗        |       ✗       |          ✗           |          ✗          |          ✗           |

---

## 2. Instruction groups

Each instruction follows the five-layer shape (accounts struct → handler → state
mutation → emit → unit tests) documented in
[ARCHITECTURE.md](ARCHITECTURE.md) §4. The handler is the _only_ place business
rules that cannot be expressed as Anchor constraints are enforced.

### 2.1 Household lifecycle

#### `initialize_household(name_hash: [u8; 32])`

Creates the `Household` PDA (also the vault) and the owner's `Member` PDA in one
instruction. `name_hash` is a blake3 digest of the off-chain display name.

| Account          | Type                 | Mut | Seeds / constraints                                                                 |
| ---------------- | -------------------- | :-: | ----------------------------------------------------------------------------------- |
| `household`      | `Account<Household>` |  ✓  | `init`, `[HOUSEHOLD_SEED, owner]`, payer `owner`, space `8 + Household::INIT_SPACE` |
| `owner_member`   | `Account<Member>`    |  ✓  | `init`, `[MEMBER_SEED, household, owner]`, payer `owner`                            |
| `owner`          | `Signer`             |  ✓  | pays rent for both PDAs                                                             |
| `system_program` | `Program<System>`    |     |                                                                                     |

- **Args & validation.** `name_hash` is any 32 bytes (the program cannot verify
  "is this a real blake3 hash"; clients hash off-chain).
- **Effect.** Owner role is set exclusively here; `member_count = 1`;
  `request_counter = 0`; canonical bumps stored.
- **Emits.** `HouseholdCreated`, `MemberAdded` (role `Owner`).
- **Errors.** None beyond Anchor's `init` collision (re-init fails on the PDA).

#### `add_member(new_member_wallet: Pubkey, role: Role)`

Owner onboards a wallet under a role.

| Account          | Type                 | Mut | Seeds / constraints                                                                       |
| ---------------- | -------------------- | :-: | ----------------------------------------------------------------------------------------- |
| `household`      | `Account<Household>` |  ✓  | `member_count += 1`                                                                       |
| `caller_member`  | `Account<Member>`    |     | `[MEMBER_SEED, household, caller]`, `has_one = household`, `active`, `can_manage_members` |
| `new_member`     | `Account<Member>`    |  ✓  | `init`, `[MEMBER_SEED, household, new_member_wallet]`, payer `caller`                     |
| `caller`         | `Signer`             |  ✓  |                                                                                           |
| `system_program` | `Program<System>`    |     |                                                                                           |

- **Args & validation.** `role` must not be `Owner` (`CannotModifyOwner`).
  `member_count` must be `< MAX_MEMBERS` (16). Duplicate add fails on PDA
  collision at `init` (no `init_if_needed`).
- **Emits.** `MemberAdded`.
- **Errors.** `CannotModifyOwner`, `MemberLimitReached`, `Overflow`.

#### `remove_member(member_wallet: Pubkey)`

Owner closes a membership and reclaims rent.

| Account         | Type                 | Mut | Seeds / constraints                                                                                                    |
| --------------- | -------------------- | :-: | ---------------------------------------------------------------------------------------------------------------------- |
| `household`     | `Account<Household>` |  ✓  | `member_count -= 1`                                                                                                    |
| `caller_member` | `Account<Member>`    |     | owner gate (as above)                                                                                                  |
| `target_member` | `Account<Member>`    |  ✓  | `[MEMBER_SEED, household, member_wallet]`, `has_one`, `wallet == member_wallet`, `role != Owner`, **`close = caller`** |
| `caller`        | `Signer`             |  ✓  | receives the closed account's rent                                                                                     |

- **Effect.** Hard close: rent refunded to caller, data zero-filled, ownership
  reassigned to the system program. A fresh `init` can re-add the wallet later.
  Historical membership is preserved by the permanent `MemberAdded` /
  `MemberRemoved` events.
- **Emits.** `MemberRemoved`.
- **Errors.** `CannotModifyOwner` (target is the Owner), `MemberNotFound`.

#### `set_role(new_role: Role, member_wallet: Pubkey)`

Owner changes a member's role.

| Account         | Type                 | Mut | Seeds / constraints                        |
| --------------- | -------------------- | :-: | ------------------------------------------ |
| `household`     | `Account<Household>` |     | read-only (member_count unchanged)         |
| `caller_member` | `Account<Member>`    |     | owner gate                                 |
| `target_member` | `Account<Member>`    |  ✓  | `wallet == member_wallet`, `role != Owner` |
| `caller`        | `Signer`             |     |                                            |

- **Args & validation.** `new_role` must not be `Owner` (`CannotModifyOwner`).
  All other transitions (e.g. `Child → Parent`) are allowed.
- **Emits.** `RoleChanged` (carries both `old_role` and `new_role`).
- **Errors.** `CannotModifyOwner`, `MemberNotFound`.

---

### 2.2 Funds

#### `deposit_funds(lamports: u64)`

Top up the vault. Any active member — Guest included — may deposit (the
"grandparent sends diaper money" flow is modelled as "join as Guest, then fund").

| Account            | Type                 | Mut | Seeds / constraints                                                   |
| ------------------ | -------------------- | :-: | --------------------------------------------------------------------- |
| `household`        | `Account<Household>` |  ✓  | `credit_vault` bumps `vault_balance`                                  |
| `depositor_member` | `Account<Member>`    |     | `[MEMBER_SEED, household, depositor]`, `has_one`, `active` (any role) |
| `depositor`        | `Signer`             |  ✓  | source of the system-program transfer                                 |
| `system_program`   | `Program<System>`    |     |                                                                       |

- **Args & validation.** `lamports > 0` (`ZeroDeposit`).
- **Effect.** `Household::credit_vault` performs a system-program `transfer` CPI
  (source is a signer wallet) and a checked `vault_balance += lamports`.
- **Emits.** `FundsDeposited` (with post-credit `vault_balance` snapshot).
- **Errors.** `ZeroDeposit`, `Overflow`.

#### `withdraw_funds(lamports: u64)`

Emergency drain. **Owner-only**, and the destination is **fixed** to the
recorded Owner signer — there is no arbitrary `to` field, so an Owner cannot
route treasury value to a third party in one instruction (that must go through
`reimburse_buyer` against an approved request).

| Account          | Type                 | Mut | Seeds / constraints                                                                  |
| ---------------- | -------------------- | :-: | ------------------------------------------------------------------------------------ |
| `household`      | `Account<Household>` |  ✓  | `debit_vault` debits `vault_balance`                                                 |
| `caller_member`  | `Account<Member>`    |     | `[MEMBER_SEED, household, owner]`, `has_one`, `active`, `can_withdraw_funds` (Owner) |
| `owner`          | `Signer`             |  ✓  | authorizer **and** drain destination                                                 |
| `system_program` | `Program<System>`    |     | reserved for symmetry                                                                |

- **Args & validation.** `lamports > 0` (`ZeroWithdrawal`). Handler
  defense-in-depth: `household.owner == owner.key()` (`NotOwner`).
- **Effect.** `Household::debit_vault` performs a direct lamport move (the
  program-owned PDA cannot be a system-program signer) with an explicit
  `vault != to` alias guard, then `vault_balance -= lamports`.
- **Emits.** `FundsWithdrawn`.
- **Errors.** `ZeroWithdrawal`, `NotOwner`, `InsufficientVaultFunds`,
  `HouseholdAccountMismatch`, `Overflow`.

---

### 2.3 Purchase lifecycle

The shared shopping list is a state machine. Each transition is a guard method
on `PurchaseRequest` (see [ACCOUNTS.md](ACCOUNTS.md) §5); handlers stay thin.

#### `create_purchase_request(amount_lamports, item_hash, unit_cost_hash, buyer)`

The "Last-One Tap" entry point. Opens a `PurchaseRequest` in `Pending`.

| Account          | Type                       | Mut | Seeds / constraints                                                                                    |
| ---------------- | -------------------------- | :-: | ------------------------------------------------------------------------------------------------------ |
| `household`      | `Account<Household>`       |  ✓  | `next_request_id()`, reward accumulator                                                                |
| `caller_member`  | `Account<Member>`          |  ✓  | `[MEMBER_SEED, household, caller]`, `has_one`, `active`, `can_transact`                                |
| `request`        | `Account<PurchaseRequest>` |  ✓  | `init`, `[PURCHASE_SEED, household, (request_counter+1).to_le_bytes()]`, payer `caller`                |
| `buyer_member`   | `Account<Member>`          |     | `[MEMBER_SEED, household, buyer]`, `has_one`, `active`, `can_transact` (proves buyer is a real member) |
| `caller`         | `Signer`                   |  ✓  |                                                                                                        |
| `system_program` | `Program<System>`          |     |                                                                                                        |

- **Args & validation.** `MIN_REQUEST_LAMPORTS ≤ amount_lamports ≤
MAX_REIMBURSEMENT_LAMPORTS` (100_000 … 500_000_000 lamports). `item_hash` and
  `unit_cost_hash` are blake3 digests.
- **The seed/counter trick.** The `init` seed reads `request_counter + 1` during
  validation; the handler then calls `next_request_id()` to land the counter on
  exactly that value. The derived address and the stored `request_id` are
  provably consistent; the first id is `1`.
- **Effect + reward.** Writes the request fields, credits the reporter
  `REWARD_LOW_STOCK_REPORT` (10 pts) across the three audit accumulators
  (member / request / household).
- **Emits.** `PurchaseCreated`, `RewardEarned` (reason: "reported low stock").
- **Errors.** `AmountBelowMinimum`, `AmountExceedsMaximum`, `UnauthorizedRole`,
  `MemberInactive`, `RewardOverflow`, `Overflow`.

#### `approve_purchase_request()`

`Pending → Approved`. Enforces separation of duties.

| Account         | Type                       | Mut | Seeds / constraints                                                                |
| --------------- | -------------------------- | :-: | ---------------------------------------------------------------------------------- |
| `household`     | `Account<Household>`       |     | read-only                                                                          |
| `caller_member` | `Account<Member>`          |     | `[MEMBER_SEED, household, caller]`, `has_one`, `active`, `can_approve`             |
| `request`       | `Account<PurchaseRequest>` |  ✓  | `[PURCHASE_SEED, household, request.request_id]`, `bump = request.bump`, `has_one` |
| `caller`        | `Signer`                   |     |                                                                                    |

- **Effect.** Handler rejects `request.buyer == caller` (`SelfApprovalForbidden`)
  — this applies even to the Owner. Then `transition_approved(slot)` sets
  `approved_by` and `approved_slot`.
- **Emits.** `PurchaseApproved`.
- **Errors.** `SelfApprovalForbidden`, `UnauthorizedRole`, `InvalidStatusTransition`.

#### `reject_purchase_request(reason_hash: [u8; 32])`

`Pending | Approved → Rejected` (terminal). An approver can undo a mistaken
approval before the buyer shops. `reason_hash` may be `[0; 32]` for "no reason".

- **Accounts.** Same shape as `approve_purchase_request` (caller is approver).
- **Emits.** `PurchaseRejected` (carries `reason_hash`).
- **Errors.** `UnauthorizedRole`, `InvalidStatusTransition` (from `Restocked` or
  a terminal state).

#### `confirm_restock(unit_cost_hash: [u8; 32])`

`Approved → Restocked`. Only the recorded buyer may confirm.

| Account        | Type                       | Mut | Seeds / constraints                                                                                                      |
| -------------- | -------------------------- | :-: | ------------------------------------------------------------------------------------------------------------------------ |
| `household`    | `Account<Household>`       |  ✓  | reward accumulator                                                                                                       |
| `buyer_member` | `Account<Member>`          |  ✓  | `[MEMBER_SEED, household, buyer]`, `has_one`, `active`                                                                   |
| `request`      | `Account<PurchaseRequest>` |  ✓  | re-derived from `request_id` + `bump`, `has_one`, `request.buyer == buyer_member.wallet`, `request.buyer == buyer.key()` |
| `buyer`        | `Signer`                   |     | must equal `request.buyer`                                                                                               |

- **Effect.** `transition_restocked(slot)`; overwrites `unit_cost_hash` with the
  actual-purchase snapshot so the off-chain best-value engine can re-score it.
  Credits buyer `REWARD_RESTOCK_COMPLETED` (25 pts).
- **Emits.** `Restocked`, `RewardEarned` (reason: "completed restock").
- **Errors.** `NotBuyer`, `MemberInactive`, `InvalidStatusTransition`, `RewardOverflow`.

#### `close_purchase_request()`

Reclaims rent from a terminal (`Reimbursed` or `Rejected`) request.

| Account         | Type                       | Mut | Seeds / constraints                                     |
| --------------- | -------------------------- | :-: | ------------------------------------------------------- |
| `household`     | `Account<Household>`       |     | read-only                                               |
| `caller_member` | `Account<Member>`          |     | `[MEMBER_SEED, household, caller]`, `has_one`, `active` |
| `request`       | `Account<PurchaseRequest>` |  ✓  | `request.status.is_terminal()`, **`close = caller`**    |
| `caller`        | `Signer`                   |  ✓  | receives the rent; must be Owner or `request.buyer`     |

- **Effect.** Anchor's `close` drains lamports, zero-fills data, and reassigns
  ownership to the system program (revival-safe). The handler additionally
  requires the caller be the Owner or the request's buyer.
- **Emits.** Nothing — the terminal event was already emitted when the status was
  reached. Closing is housekeeping; the audit trail lives forever in the event
  stream.
- **Errors.** `InvalidStatusTransition` (non-terminal), `UnauthorizedRole`.

---

### 2.4 Reimbursement

#### `reimburse_buyer(lamports: u64)`

The trust-critical vault → buyer SOL transfer. `Restocked → Reimbursed`,
atomically moving `lamports` SOL and granting the full-run reward. **The caller
is the approver (Owner/Parent), not the buyer** — the buyer merely receives
lamports.

| Account         | Type                       | Mut | Seeds / constraints                                                                                                        |
| --------------- | -------------------------- | :-: | -------------------------------------------------------------------------------------------------------------------------- |
| `household`     | `Account<Household>`       |  ✓  | `debit_vault`, reward accumulator                                                                                          |
| `caller_member` | `Account<Member>`          |     | `[MEMBER_SEED, household, caller]`, `has_one`, `active`, `can_approve`                                                     |
| `request`       | `Account<PurchaseRequest>` |  ✓  | re-derived from `request_id` + `bump`, `has_one`                                                                           |
| `buyer_member`  | `Account<Member>`          |  ✓  | `[MEMBER_SEED, household, request.buyer]` (**stored** buyer, not a signer), `has_one`, `active`, `wallet == request.buyer` |
| `buyer`         | `UncheckedAccount`         |  ✓  | `constraint buyer.key() == request.buyer` (`NotBuyer`)                                                                     |
| `caller`        | `Signer`                   |     | the authorizing approver                                                                                                   |

- **Why `buyer` is an `UncheckedAccount`.** The buyer neither signs nor owns
  program state here. Safety is enforced inline: (1) the address is pinned to
  the request's recorded buyer via `buyer.key() == request.buyer`; (2)
  `buyer_member` is seeded from the **stored** `request.buyer`, and
  `request.buyer == buyer.key()` together prove the recipient is an active
  member whose wallet matches the recorded buyer. Lamports are only ever
  _credited_ to this account.
- **Order matters.** The lifecycle guard runs FIRST (`transition_reimbursed`
  rejects over-ceiling, zero, and non-`Restocked` states), so a failed
  validation aborts before any SOL moves. Solana transaction atomicity then
  guarantees a failed `debit_vault` or `RewardOverflow` rolls back the status
  mutation and the SOL movement.
- **Effect + reward.** `debit_vault` moves vault SOL to the buyer; the buyer
  earns `REWARD_FULL_RUN_COMPLETED` (15 pts) across the audit triangle.
- **Emits.** `Reimbursed`, `RewardEarned` (reason: "completed full grocery run").
- **Errors.** `UnauthorizedRole`, `NotBuyer`, `MemberInactive`,
  `InvalidStatusTransition`, `AlreadyReimbursed`, `ReimbursementExceedsApproved`,
  `ZeroWithdrawal`, `InsufficientVaultFunds`, `HouseholdAccountMismatch`,
  `RewardOverflow`, `Overflow`.

---

### 2.5 Rewards

#### `award_reward(member_wallet: Pubkey, points: u64, reason_hash: [u8; 32])`

Owner/Parent manually grants points to any active member. `reason_hash` is a
client-computed blake3 digest of the off-chain reason; the program passes it
through verbatim.

| Account         | Type                 | Mut | Seeds / constraints                                                                       |
| --------------- | -------------------- | :-: | ----------------------------------------------------------------------------------------- |
| `household`     | `Account<Household>` |  ✓  | `record_rewards`                                                                          |
| `caller_member` | `Account<Member>`    |     | `[MEMBER_SEED, household, caller]`, `has_one`, `active`, `can_award_rewards`              |
| `target_member` | `Account<Member>`    |  ✓  | `[MEMBER_SEED, household, member_wallet]`, `has_one`, `active`, `wallet == member_wallet` |
| `caller`        | `Signer`             |     |                                                                                           |

- **Args & validation.** `points > 0` (`ZeroReward`). The caller may target any
  active member, not just themselves (the seed takes the arg `member_wallet`).
- **Emits.** `RewardEarned` (with post-credit `total_points` snapshot).
- **Errors.** `ZeroReward`, `UnauthorizedRole`, `MemberNotFound`, `MemberInactive`,
  `RewardOverflow`.

#### `reward_summary()`

Read-only score fetch. Any active member (Guest included) may call. Emits a
`RewardEarned` with the sentinel `points == 0` and `reason_hash == [0; 32]` so
auditors can distinguish a score-fetch from a real grant — `add_reward` rejects
`points == 0`, and blake3 of any real reason is nonzero, so the distinguisher is
unambiguous.

- **Emits.** `RewardEarned` (sentinel; carries the member's current `total_points`).
- **Errors.** `MemberInactive`.

---

## 3. Instruction → event matrix

The audit-trail contract. Every state-changing instruction emits exactly the
events listed; `RewardEarned` is reused across the auto-reward paths (with a
deterministic `reason_hash` per stage) and for the manual award + summary cases.

| Instruction                | Emits                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| `initialize_household`     | `HouseholdCreated`, `MemberAdded`                                  |
| `add_member`               | `MemberAdded`                                                      |
| `remove_member`            | `MemberRemoved`                                                    |
| `set_role`                 | `RoleChanged`                                                      |
| `deposit_funds`            | `FundsDeposited`                                                   |
| `withdraw_funds`           | `FundsWithdrawn`                                                   |
| `create_purchase_request`  | `PurchaseCreated`, `RewardEarned` (low-stock)                      |
| `approve_purchase_request` | `PurchaseApproved`                                                 |
| `reject_purchase_request`  | `PurchaseRejected`                                                 |
| `confirm_restock`          | `Restocked`, `RewardEarned` (restock)                              |
| `close_purchase_request`   | — (terminal event already emitted)                                 |
| `reimburse_buyer`          | `Reimbursed`, `RewardEarned` (full run)                            |
| `award_reward`             | `RewardEarned` (manual)                                            |
| `reward_summary`           | `RewardEarned` (sentinel: `points == 0`, `reason_hash == [0; 32]`) |

**Event payloads** (defined in [`events.rs`](../programs/stocksie/src/events.rs))
carry only pubkeys, lamports/points, slots, and `[u8; 32]` hashes — never raw
text. The reward `reason_hash` is produced by a single shared helper so the
blake3 → `[u8; 32]` mapping has exactly one definition:

```programs/stocksie/src/instructions/purchase.rs#L57-59
pub(crate) fn hash_reason(reason: &[u8]) -> [u8; 32] {
    *blake3::hash(reason).as_bytes()
}
```

### Reward schedule

Defined in [`constants.rs`](../programs/stocksie/src/constants.rs). Each
auto-reward stage fires at most once per request, tracked by the per-request
`reward_earned` accumulator (idempotency guard).

| Constant                    | Points | Awarded by                                                                                    |
| --------------------------- | -----: | --------------------------------------------------------------------------------------------- |
| `REWARD_LOW_STOCK_REPORT`   |     10 | `create_purchase_request` (reporter)                                                          |
| `REWARD_RESTOCK_COMPLETED`  |     25 | `confirm_restock` (buyer)                                                                     |
| `REWARD_FULL_RUN_COMPLETED` |     15 | `reimburse_buyer` (buyer)                                                                     |
| `REWARD_COST_SAVING`        |     50 | reserved — awarded by the off-chain best-value engine hook; not wired to a handler in the MVP |

> **Honest note.** `REWARD_COST_SAVING` is defined but not granted by any MVP
> handler. It is the hook the off-chain engine (Feature 2.3) will use once the
> cost-savings scoring loop ships; including it here avoids renumbering the
> schedule later.

---

## 4. Cross-cutting rules

These apply to every instruction and are the backbone of [SECURITY.md](SECURITY.md).

1. **Checked arithmetic everywhere.** Every `u64`/`u32` mutation uses
   `checked_add` / `checked_sub` with `ok_or(StocksieError::Overflow)` (or
   `RewardOverflow`). The release profile sets `overflow-checks = true` as
   defense-in-depth.
2. **`init` only — never `init_if_needed`.** Reinitialization is impossible: a
   duplicate create collides on the PDA and fails. Re-add flows through `close`
   then a fresh `init`.
3. **Canonical bumps stored at `init`.** Every account stores
   `bump = ctx.bumps.*`; CPI signing reuses that byte. We never re-derive and
   never trust a caller-supplied bump (verified by `canonical_bump_stored`).
4. **`has_one = household` on every cross-account reference.** A `Member` or
   `PurchaseRequest` from household A cannot authorize an action in household B.
5. **No free text on chain.** Only pubkeys, integers, `Role`/`Status` enums,
   booleans, and `[u8; 32]` hashes (enforced by the `no_string_fields_on_chain`
   grep test).
6. **Auth root is the seed.** Every mutating op loads `caller_member` via
   `seeds = [MEMBER_SEED, household, caller]` and checks `active`; there is no
   stored roster to drift.
7. **`active` gate on every caller.** A deactivated/removed member fails
   `MemberInactive` before the role predicate is even consulted.
8. **`close = caller` for rent reclamation.** `remove_member` and
   `close_purchase_request` drain lamports to the caller, zero-fill data, and
   reassign ownership to the system program (revival-safe).
9. **`Signer` required on every state-mutating instruction.** Combined with the
   caller-seeded `Member` PDA, a non-signing pubkey cannot be substituted.
10. **Defense-in-depth data-matching.** `request.buyer == buyer.key()`,
    `household.owner == owner.key()`, and `buyer_member.wallet == request.buyer`
    are re-checked in handlers/constraints even though the seed already derives
    the correct account — guarding against data corruption.

### Vault debit pattern (why not `system_program::transfer`?)

The vault is a program-owned PDA, so it **cannot** be a system-program signer.
`Household::debit_vault` therefore does a direct lamport move with an explicit
`vault != to` alias guard:

```programs/stocksie/src/instructions/purchase.rs#L146-159
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
```

(The handler above shows the validate-first, mutate-second ordering; the SOL
move itself lives in `Household::debit_vault`, documented in
[ACCOUNTS.md](ACCOUNTS.md) §2.)

---

## 5. Client example

The test harness in
[`tests/helpers/mod.rs`](../programs/stocksie/tests/helpers/mod.rs) is the
canonical "how a client builds a transaction" reference. It uses Anchor's
generated `accounts::*` and `instruction::*` structs directly, so the same
pattern works in a TS/JS client (via the IDL) or a Rust client.

Derive the PDAs from the seed constants, then build the instruction:

```programs/stocksie/tests/helpers/mod.rs#L121-131
pub fn derive_household(owner: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[HOUSEHOLD_SEED, owner.as_ref()], &stocksie::id())
}

pub fn derive_member(household: &Pubkey, wallet: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MEMBER_SEED, household.as_ref(), wallet.as_ref()],
        &stocksie::id(),
    )
}
```

Compose the accounts + args and produce the canonical
`discriminator(8) ++ borsh(args)` payload:

```programs/stocksie/tests/helpers/mod.rs#L165-176
pub fn build_ix<A, I>(accounts: &A, args: &I) -> Instruction
where
    A: ToAccountMetas,
    I: InstructionData,
{
    Instruction::new_with_bytes(
        stocksie::id(),
        &args.data(),
        &accounts.to_account_metas(None),
    )
}
```

Putting it together for `initialize_household`:

```rust
use stocksie::{
    accounts::InitializeHousehold,
    instruction::InitializeHousehold as InitializeHouseholdArgs,
    id, HOUSEHOLD_SEED, MEMBER_SEED,
};

let owner = payer.pubkey();                         // the new household owner
let name_hash = *blake3::hash(b"Smith family").as_bytes();

let (household, _) = Pubkey::find_program_address(
    &[HOUSEHOLD_SEED, owner.as_ref()],
    &id(),
);
let (owner_member, _) = Pubkey::find_program_address(
    &[MEMBER_SEED, household.as_ref(), owner.as_ref()],
    &id(),
);

let accounts = InitializeHousehold {
    household,
    owner_member,
    owner,
    system_program: solana_system_program_interface::ID,
};
let args = InitializeHouseholdArgs { name_hash };
let ix = build_ix(&accounts, &args);
// ... sign + send `ix` in a transaction
```

For the full end-to-end flow (init → add_member → deposit → create → approve →
confirm → reimburse), see the
[`full_lifecycle_reaches_reimbursed`](../programs/stocksie/tests/test_lifecycle.rs)
test.

---

## 6. Error reference

All errors are defined in [`error.rs`](../programs/stocksie/src/error.rs) as
`StocksieError`. Each variant is asserted by a named test (see
[TESTING.md](TESTING.md) and [SECURITY.md](SECURITY.md)).

| Variant                        | Meaning                                             | Raised by                                                                 |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------- |
| `NotAMember`                   | Caller is not an active member                      | (reserved; the seed gate surfaces Anchor's `ConstraintSeeds` in practice) |
| `UnauthorizedRole`             | Caller's role does not permit this action           | every role-gated instruction                                              |
| `NotOwner`                     | Only the household owner may do this                | `withdraw_funds` (defense-in-depth)                                       |
| `MemberAlreadyExists`          | Wallet is already a member                          | (PDA collision at `init` in practice)                                     |
| `MemberNotFound`               | Wallet is not a member / arg mismatch               | `remove_member`, `set_role`, `award_reward`                               |
| `MemberInactive`               | Membership is deactivated                           | every caller/buyer gate                                                   |
| `MemberLimitReached`           | Household at `MAX_MEMBERS` (16)                     | `add_member`                                                              |
| `CannotModifyOwner`            | Cannot add/remove/demote the Owner                  | `add_member`, `remove_member`, `set_role`                                 |
| `HouseholdAccountMismatch`     | Account is not the expected PDA / vault==to alias   | `debit_vault`                                                             |
| `HouseholdMismatch`            | Cross-account reference points elsewhere            | (covered by `has_one`)                                                    |
| `InsufficientVaultFunds`       | Vault lacks lamports                                | `debit_vault`                                                             |
| `AmountBelowMinimum`           | `amount < MIN_REQUEST_LAMPORTS` (100_000)           | `create_purchase_request`                                                 |
| `AmountExceedsMaximum`         | `amount > MAX_REIMBURSEMENT_LAMPORTS` (500_000_000) | `create_purchase_request`                                                 |
| `ZeroDeposit`                  | `deposit_funds(0)`                                  | `deposit_funds`                                                           |
| `ZeroWithdrawal`               | `withdraw_funds(0)` / `reimburse_buyer(0)`          | `debit_vault`, `transition_reimbursed`                                    |
| `InvalidStatusTransition`      | Wrong lifecycle state                               | every `transition_*` guard, `close`                                       |
| `AlreadyTerminal`              | Request is finalized                                | (covered by `InvalidStatusTransition`/`AlreadyReimbursed`)                |
| `NotBuyer`                     | Caller is not the recorded buyer                    | `confirm_restock`, `reimburse_buyer`                                      |
| `ReimbursementExceedsApproved` | `lamports > amount_lamports`                        | `transition_reimbursed`                                                   |
| `AlreadyReimbursed`            | Second reimbursement attempt                        | `transition_reimbursed`                                                   |
| `SelfApprovalForbidden`        | Approver == buyer                                   | `approve_purchase_request`                                                |
| `ZeroReward`                   | `award_reward(0)`                                   | `Member::add_reward`                                                      |
| `RewardOverflow`               | Reward accumulator wrapped                          | `add_reward`, `record_rewards`                                            |
| `Overflow`                     | Generic checked-arithmetic overflow                 | every `checked_*` site                                                    |

---

## Where to go next

- [ACCOUNTS.md](ACCOUNTS.md) — the three account structs, the state machine, and
  the forbidden-transitions table.
- [SECURITY.md](SECURITY.md) — the vulnerability matrix and the named test
  behind each defense.
- [TESTING.md](TESTING.md) — how to run the 75-test suite, the harness pattern,
  and where to add new tests.
- [PRIVACY.md](PRIVACY.md) — the full on-chain/off-chain boundary contract.
