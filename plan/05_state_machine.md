# Stocksie — Purchase Request State Machine

> The strict lifecycle that makes the shared shopping list trustworthy.

This document is the source of truth for which transitions `PurchaseRequest` allows, who may trigger each one, and what invariants hold at every node. The implementation lives in `programs/stocksie/src/state/purchase_request.rs` (the `transition_*` guard methods) and the instruction handlers in `programs/stocksie/src/instructions/purchase.rs` / `reimburse.rs`.

---

## 1. State diagram

```text
                            ┌──────────────────────────────────────┐
                            │                                      │
                            ▼                                      │
   create_purchase_request  ┌─────────┐  approve_purchase_request  │  ┌──────────┐
  ─────────────────────────▶│ Pending │───────────────────────────▶│  │ Approved │
                            └────┬────┘                             │  └────┬─────┘
                                 │                                   │       │
                  reject_        │                                   │       │ confirm_restock
                  purchase_      │                                   │       │
                  request        │                                   │       ▼
                                 │                                   │  ┌──────────┐  reimburse_buyer
                                 │                                   │  │ Restocked │────────────────▶┌────────────┐
                                 │                                   │  └──────────┘                   │ Reimbursed │ (terminal)
                                 │                                   │                                  └────────────┘
                                 │                                   │
                                 │   reject_purchase_request         │
                                 └───────────────┬───────────────────┘
                                                 │
                                                 ▼
                                           ┌──────────┐
                                           │ Rejected │ (terminal)
                                           └──────────┘
```

Two terminal states: **`Reimbursed`** (happy path completed) and **`Rejected`** (declined by an approver). Once terminal, the account is frozen — no further transitions are accepted; the only thing left to do is `close_purchase_request` to reclaim rent.

---

## 2. Transition table

| # | From | To | Trigger | Authority | Guards |
| --- | --- | --- | --- | --- | --- |
| T1 | — | `Pending` | `create_purchase_request` | active member with `can_transact()` | `MIN_REQUEST_LAMPORTS ≤ amount ≤ MAX_REIMBURSEMENT_LAMPORTS`; buyer must be an active transacting member; rewards `REWARD_LOW_STOCK_REPORT` |
| T2 | `Pending` | `Approved` | `approve_purchase_request` | active member with `can_approve()` (Owner/Parent) | `caller != buyer` (no self-approval) |
| T3 | `Pending` `|` `Approved` | `Rejected` | `reject_purchase_request` | active Owner/Parent | terminal; emits `PurchaseRejected` |
| T4 | `Approved` | `Restocked` | `confirm_restock` | the recorded `buyer` (signer must equal `request.buyer`) | buyer must be active; rewards `REWARD_RESTOCK_COMPLETED` |
| T5 | `Restocked` | `Reimbursed` | `reimburse_buyer` | active Owner/Parent | `0 < lamports ≤ amount_lamports`; vault solvency; rewards `REWARD_FULL_RUN_COMPLETED`; performs the SOL transfer |

Every transition is implemented as a dedicated `transition_*` method on `PurchaseRequest`. The methods are the **only** way `status` mutates — instruction handlers never write `request.status = ...` directly.

---

## 3. Per-state invariants

Each state carries a set of invariants the program guarantees hold on entry. These are what the test suite (`08_testing.md`) asserts.

### `Pending`
- `approved_by == Pubkey::default()`
- `approved_slot == 0`
- `restocked_slot == 0`
- `reimbursed_amount == 0`
- `reward_earned >= REWARD_LOW_STOCK_REPORT` (the reporter reward always fires)
- `status.is_terminal() == false`

### `Approved`
- `approved_by != Pubkey::default()` (a real approver pubkey)
- `approved_slot > 0`
- `approved_by != buyer` (self-approval is structurally impossible)
- `restocked_slot == 0`
- `reimbursed_amount == 0`

### `Restocked`
- `approved_by != Pubkey::default()`
- `restocked_slot > 0`
- `restocked_slot >= approved_slot`
- `reimbursed_amount == 0`
- `reward_earned >= REWARD_LOW_STOCK_REPORT + REWARD_RESTOCK_COMPLETED`

### `Reimbursed` (terminal)
- `reimbursed_amount > 0`
- `reimbursed_amount <= amount_lamports`
- `reward_earned >= REWARD_LOW_STOCK_REPORT + REWARD_RESTOCK_COMPLETED + REWARD_FULL_RUN_COMPLETED`
- `status.is_terminal() == true`
- No further `transition_*` call succeeds; the only valid operation is `close_purchase_request`.

### `Rejected` (terminal)
- `status.is_terminal() == true`
- `reimbursed_amount == 0` (no funds ever moved)
- The reporter's low-stock reward persists (`reward_earned >= REWARD_LOW_STOCK_REPORT`) — reporting the problem is rewarded regardless of the outcome.

---

## 4. Forbidden transitions (negative cases)

These are the transitions the state machine **rejects**, each with a specific error. The test suite asserts every one.

| Attempt | Returned error |
| --- | --- |
| `confirm_restock` from `Pending` (skip approval) | `InvalidStatusTransition` |
| `reimburse_buyer` from `Approved` (skip restock) | `InvalidStatusTransition` |
| `reimburse_buyer` from `Pending` | `InvalidStatusTransition` |
| `reimburse_buyer` from `Rejected` | `InvalidStatusTransition` |
| `reimburse_buyer` from `Reimbursed` (double pay) | `AlreadyReimbursed` |
| `reject_purchase_request` from `Restocked` | `InvalidStatusTransition` |
| `reject_purchase_request` from `Reimbursed` | `InvalidStatusTransition` |
| `reject_purchase_request` from `Rejected` | `InvalidStatusTransition` |
| `approve_purchase_request` from `Approved` | `InvalidStatusTransition` |
| `approve_purchase_request` from any terminal | `InvalidStatusTransition` |
| `reimburse_buyer` with `lamports == 0` | `ZeroWithdrawal` |
| `reimburse_buyer` with `lamports > amount_lamports` | `ReimbursementExceedsApproved` |

The `transition_reimbursed` method has a dedicated `AlreadyReimbursed` arm (rather than falling through to the generic `InvalidStatusTransition`) so the client UI can distinguish "you already paid this" from "this request was never restocked" — useful for showing the right error toast.

---

## 5. Reward stages along the lifecycle

Rewards are tied to lifecycle stages, not to who triggered them. The `reward_earned` field on `PurchaseRequest` is a per-request ledger that guarantees each stage fires at most once, even if an instruction is retried or a transaction is re-submitted.

| Stage | Trigger | Points | Credited to | Idempotency guard |
| --- | --- | --- | --- | --- |
| Low-stock report | `create_purchase_request` | `REWARD_LOW_STOCK_REPORT` (+10) | the caller (reporter) | `reward_earned` starts at 0; this is the first stage |
| Restock completed | `confirm_restock` | `REWARD_RESTOCK_COMPLETED` (+25) | the buyer | only callable from `Approved`; the `Restocked` state itself proves the restock reward hasn't fired yet |
| Full grocery run | `reimburse_buyer` | `REWARD_FULL_RUN_COMPLETED` (+15) | the buyer | only callable from `Restocked`; the `Reimbursed` transition is one-shot |
| Cost-saving bonus | `award_reward` (manual) | up to `REWARD_COST_SAVING` (+50) | the buyer | off-chain engine decides; recorded via `RewardEarned` with `reason_hash` |

The cost-saving bonus (`REWARD_COST_SAVING`) is **not** auto-granted by a transition — it requires a manual `award_reward` call because the savings computation is off-chain (comparing `unit_cost_hash` snapshots to a baseline). The data is available on-chain (the hashes are there); the judgment is deferred to the best-value engine (Feature 2.3).

---

## 6. The `request_id` seed pattern

`PurchaseRequest` PDAs are seeded `[PURCHASE_SEED, household, &request_id.to_le_bytes()]`. The `request_id` is `household.request_counter + 1`, assigned and incremented inside `create_purchase_request`.

This creates an ordering subtlety: the seed depends on a value that the handler computes, but Anchor's `init` constraint needs to resolve the PDA from the accounts struct. The resolution pattern:

1. The accounts struct loads `household` as mutable.
2. The handler computes `let request_id = household.next_request_id()?;` (which increments `request_counter`).
3. The handler then derives the expected PDA with `Pubkey::create_program_address(&[PURCHASE_SEED, household.as_ref(), &request_id.to_le_bytes(), &[bump]], &crate::id())` and asserts it matches the `request` account passed in.

In practice we let Anchor's `init` derive the address from the *current* `request_counter + 1` by structuring the accounts so the seed read happens after the counter increment. The test suite verifies the address derivation matches in `tests/test_lifecycle.rs`.

> Alternative considered: a client-supplied `request_id` arg. Rejected — it would let a malicious client skip ids or create gaps, breaking the monotonic invariant. The counter is authoritative; clients learn the assigned id from the `PurchaseCreated` event.

---

## 7. Concurrent and reordered submissions

The state machine is robust against the realistic failure modes of a household app:

- **Two members create requests in the same slot.** Each gets a distinct `request_id` (the counter is incremented atomically per instruction), so their PDAs don't collide.
- **A buyer tries to confirm restock before approval lands.** `transition_restocked` rejects because the state is still `Pending`.
- **An approver approves, then changes their mind before the buyer shops.** `reject_purchase_request` allows `Approved → Rejected`, undoing the approval.
- **An approver approves twice (replayed tx).** The second call hits `Pending → Approved`'s precondition failure: the state is already `Approved`, so `InvalidStatusTransition` is returned. No double-effect.
- **A buyer tries to reimburse themselves.** `reimburse_buyer` requires an active Owner/Parent caller; if the buyer is only a Child, they can't call it. If the buyer is a Parent, they still can't self-approve (T2's `caller != buyer` guard), so the request can never reach `Restocked` under their own authority — and therefore can never be reimbursed under it either.

---

## 8. Closing and revival

`close_purchase_request` is the only path that removes a `PurchaseRequest` account, and it requires a terminal status. Anchor's `close = caller` constraint:

1. Drains the account's lamports to `caller` (rent refund).
2. Zero-fills the data.
3. Reassigns the account to the system program, preventing revival at the same address with stale data.

A closed request cannot be revived (security checklist: revival attacks). Its history persists forever via the events (`PurchaseCreated`, `PurchaseApproved`, `Restocked`, `Reimbursed` / `PurchaseRejected`) — events are not stored in closable accounts.

---

## 9. Test coverage mapping

The state machine is the most-tested surface in the program. Every transition and every forbidden attempt has a dedicated LiteSVM test:

| Test file | Covers |
| --- | --- |
| `tests/test_state_machine.rs` | All 5 transitions + all 12 forbidden cases (pure unit tests on `PurchaseRequest::transition_*`) |
| `tests/test_lifecycle.rs` | Full happy-path `Pending → Reimbursed` with real accounts and balance assertions |
| `tests/test_permissions.rs` | Authority gates per transition (Child can't approve, non-buyer can't confirm, etc.) |
| `tests/test_reimburse.rs` | Over-ceiling, zero, and double-reimbursement rejections |

See `08_testing.md` for the complete test matrix.

---

## Next up

- **`plan/06_events.md`** — the event catalog: every event's fields, what it proves, and what it deliberately omits. Then `07_security.md`, `08_testing.md`, `09_build_phases.md`, `10_docs.md` round out the plan folder before we resume implementation in `programs/stocksie/src/instructions/funds.rs`.