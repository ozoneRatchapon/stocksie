# Stocksie — Event Catalog

> The audit-trail contract: every state-changing instruction emits at least one event, and every event carries only pubkeys, amounts, and hashes — never raw household data.

This document is the source the `programs/stocksie/src/events.rs` file implements against. Each `#[event]` struct below is a 1:1 match for the events already declared in `events.rs`. The plan files lead; the code follows.

---

## 1. Design principles

The event layer is the program's **public audit surface**. Four rules govern every event, and the LiteSVM test suite asserts them:

1. **Verifiable.** Every trust-critical transition emits. An observer reconstructing household activity from logs alone can reconstruct *who did what, when, for how much* — without ever reading an account.
2. **Privacy-preserving.** No event payload contains raw item names, quantities, receipts, prices, or any free-form text. Anything human-readable is reduced to a `blake3` digest first. The chain proves *that* a thing happened, never *what* it was about.
3. **Indexable.** Events that the client UI filters or groups by (e.g. "show me all requests for household X" or "show me all rewards earned by member Y") carry an `#[index]` field so RPC `getLogs` can target them cheaply.
4. **Reconstructible.** A client can rebuild the shared shopping list and the reward leaderboard purely by walking the event stream — accounts are an optimization, not a requirement.

---

## 2. The boundary — what may appear in an event

| Shape | Examples | Allowed |
| --- | --- | :---: |
| `Pubkey` | `household`, `member`, `buyer`, `approver` | ✓ |
| `u64` | `lamports`, `points`, `total_points`, `request_id`, `slot`, `vault_balance` | ✓ |
| `[u8; 32]` (blake3 digest) | `name_hash`, `item_hash`, `unit_cost_hash`, `reason_hash` | ✓ |
| Small enums (`Role`, `Status`) | `role`, `status` | ✓ |
| `String` / free text | item name, reason text, receipt OCR | ✗ — hash off chain |
| Raw prices / pack sizes | unit price, grams per roll | ✗ — only `unit_cost_hash` of a snapshot |

A grep-based invariant test (`tests/test_privacy_invariant.rs`) asserts that no `String` field appears in any `#[event]` struct, keeping the boundary machine-checkable for the life of the codebase.

---

## 3. Event catalog

Every event below maps to a struct in `events.rs`. The "Proves" column is the audit guarantee; the "Omits" column is the privacy guarantee.

### 3.1 Household lifecycle

#### `HouseholdCreated`
Emitted by `initialize_household`. Marks the birth of a household PDA and its treasury vault.

| Field | Type | `#[index]` | Notes |
| --- | --- | :---: | --- |
| `household` | `Pubkey` | | the new household PDA (also the vault) |
| `owner` | `Pubkey` | | the wallet that owns the household |
| `name_hash` | `[u8; 32]` | ✓ | blake3 of the off-chain display name |
| `slot` | `u64` | | creation slot |

- **Proves**: that a household with this owner exists as of `slot`.
- **Omits**: the household's display name (recoverable only off-chain via `name_hash`).

#### `MemberAdded`
Emitted by `initialize_household` (for the owner) and `add_member`.

| Field | Type | `#[index]` | Notes |
| --- | --- | :---: | --- |
| `household` | `Pubkey` | | |
| `member` | `Pubkey` | | the onboarded wallet |
| `role` | `Role` | | role at onboarding |
| `slot` | `u64` | | |

- **Proves**: that `member` was onboarded to `household` with `role` at `slot`.
- **Omits**: any display name, avatar, or contact info for the member.

#### `MemberRemoved`
Emitted by `remove_member`. Note: the on-chain `Member` account is hard-closed; this event is the **only** durable record that the membership existed.

| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Pubkey` | |
| `member` | `Pubkey` | the removed wallet |
| `slot` | `u64` | |

- **Proves**: that `member` left `household` at `slot`. Their historical `RewardEarned` events persist forever.
- **Omits**: the reason for removal (not modeled in the MVP).

#### `RoleChanged`
Emitted by `set_role`. Tracks promotions (Child → Parent) and demotions (Parent → Guest).

| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Pubkey` | |
| `member` | `Pubkey` | |
| `old_role` | `Role` | role before the change |
| `new_role` | `Role` | role after the change |
| `slot` | `u64` | |

- **Proves**: the privilege delta. A future dispute over "could X approve at slot N?" is answerable by walking `MemberAdded` / `RoleChanged` events up to `N`.
- **Omits**: the reason for the change.

---

### 3.2 Vault / funds (Feature 2.4 & 3.2)

#### `FundsDeposited`
Emitted by `deposit_funds`.

| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Pubkey` | |
| `depositor` | `Pubkey` | the wallet that funded the vault |
| `lamports` | `u64` | amount credited |
| `vault_balance` | `u64` | vault balance immediately after credit |
| `slot` | `u64` | |

- **Proves**: the funding history of the shared treasury. Summing `lamports` over events reconstructs total inflow.
- **Omits**: the source of funds (bank, cash, etc.) — out of scope.

#### `FundsWithdrawn`
Emitted by `withdraw_funds` (Owner-only emergency drain).

| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Pubkey` | |
| `owner` | `Pubkey` | the wallet that drained (always the recorded owner) |
| `lamports` | `u64` | amount debited |
| `vault_balance` | `u64` | vault balance immediately after debit |
| `slot` | `u64` | |

- **Proves**: every direct vault drain. Routine spending does **not** go through this path — it goes through `Reimbursed`, which is a separate, richer event.
- **Omits**: the reason for the drain.

---

### 3.3 Purchase request lifecycle (Feature 2.1, 2.2, 3.3)

#### `PurchaseCreated`
Emitted by `create_purchase_request`. This is the on-chain anchor of the **Last-One Tap**.

| Field | Type | `#[index]` | Notes |
| --- | --- | :---: | --- |
| `household` | `Pubkey` | | |
| `request` | `Pubkey` | | the new `PurchaseRequest` PDA |
| `buyer` | `Pubkey` | | designated shopper / reimbursement target |
| `request_id` | `u64` | ✓ | monotonic per-household id (also in the seed) |
| `amount` | `u64` | | requested spend in lamports (reimbursement ceiling) |
| `item_hash` | `[u8; 32]` | | blake3 of item name + quantity |
| `unit_cost_hash` | `[u8; 32]` | | blake3 of best-value recommendation snapshot |
| `slot` | `u64` | | |

- **Proves**: that a request for `amount` was opened by/for `buyer`, referencing a specific off-chain item record and a specific price-comparison snapshot.
- **Omits**: the item name, the quantity, the price, the pack size, the store. All recoverable only off-chain via the hashes.

#### `PurchaseApproved`
Emitted by `approve_purchase_request`.

| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Pubkey` | |
| `request` | `Pubkey` | |
| `buyer` | `Pubkey` | |
| `approver` | `Pubkey` | the Owner/Parent who authorized |
| `amount` | `u64` | ceiling being authorized |
| `slot` | `u64` | |

- **Proves**: who authorized the spend. `approver != buyer` is guaranteed by the program (no self-approval), so this event is also proof of separation of duties.
- **Omits**: any conditions attached to the approval.

#### `PurchaseRejected`
Emitted by `reject_purchase_request`.

| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Pubkey` | |
| `request` | `Pubkey` | |
| `buyer` | `Pubkey` | |
| `approver` | `Pubkey` | |
| `reason_hash` | `[u8; 32]` | blake3 of the (optional) rejection reason; `[0; 32]` if none |
| `slot` | `u64` | |

- **Proves**: that the request was declined, by whom, and (optionally) against which reason record.
- **Omits**: the reason text. UIs render the reason by looking up `reason_hash` off-chain.

#### `Restocked`
Emitted by `confirm_restock`.

| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Pubkey` | |
| `request` | `Pubkey` | |
| `buyer` | `Pubkey` | the wallet that confirmed (always `request.buyer`) |
| `status` | `Status` | always `Restocked` here; included for uniform parsing |
| `unit_cost_hash` | `[u8; 32]` | may differ from creation's hash if a different package was bought |
| `slot` | `u64` | |

- **Proves**: the buyer's attestation that the item is replenished. Unlocks reimbursement.
- **Omits**: the receipt, the actual store, the actual price paid. The `unit_cost_hash` is a *reference* to an off-chain snapshot, not the snapshot itself.

#### `Reimbursed`
Emitted by `reimburse_buyer`. This is the trust-critical moment — the vault pays the buyer back.

| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Pubkey` | |
| `request` | `Pubkey` | |
| `buyer` | `Pubkey` | recipient of the SOL |
| `lamports` | `u64` | actual payout (may be `≤` the approved ceiling) |
| `status` | `Status` | always `Reimbursed` here |
| `slot` | `u64` | |

- **Proves**: that `lamports` moved from the vault to `buyer` for request `request`. The lamport movement is also visible in account diffs; this event attaches the *intent* (reimbursement for request N), which account diffs alone cannot convey.
- **Omits**: the receipt, the change from the ceiling (computable as `ceiling - lamports` from `PurchaseCreated.amount`).

---

### 3.4 Rewards (Feature 2.5 — gamification)

#### `RewardEarned`
Emitted by every reward path: `create_purchase_request`, `confirm_restock`, `reimburse_buyer`, `award_reward`, and `reward_summary`.

| Field | Type | `#[index]` | Notes |
| --- | --- | :---: | --- |
| `household` | `Pubkey` | | |
| `member` | `Pubkey` | | the earner |
| `points` | `u64` | | points credited in this event |
| `total_points` | `u64` | | member's cumulative score after the credit |
| `reason_hash` | `[u8; 32]` | ✓ | blake3 of the human-readable reason |
| `slot` | `u64` | | |

- **Proves**: the entire reward history of every member. Summing `points` (excluding `reward_summary`'s sentinel `0` emits) reconstructs `member.reward_points`; the test suite asserts the two never diverge.
- **Omits**: the reason text. UIs render badges by mapping `reason_hash` to a friendly description off-chain.

**The `points == 0` sentinel**: `reward_summary` emits with `points = 0` and the current `total_points`. Because `Member::add_reward` rejects `0`, a real reward credit can never produce a zero-points event — so auditors can unambiguously distinguish a summary from a grant.

---

## 4. Instruction → event matrix

Every state-changing instruction emits at least one event. This matrix is the audit-trail contract the test suite enforces.

| Instruction | Emits |
| --- | --- |
| `initialize_household` | `HouseholdCreated`, `MemberAdded` |
| `add_member` | `MemberAdded` |
| `remove_member` | `MemberRemoved` |
| `set_role` | `RoleChanged` |
| `deposit_funds` | `FundsDeposited` |
| `withdraw_funds` | `FundsWithdrawn` |
| `create_purchase_request` | `PurchaseCreated`, `RewardEarned` |
| `approve_purchase_request` | `PurchaseApproved` |
| `reject_purchase_request` | `PurchaseRejected` |
| `confirm_restock` | `Restocked`, `RewardEarned` |
| `reimburse_buyer` | `Reimbursed`, `RewardEarned` |
| `award_reward` | `RewardEarned` |
| `close_purchase_request` | — (terminal event already emitted earlier) |
| `reward_summary` | `RewardEarned` (sentinel; `points = 0`) |

Read-only instructions (none in the MVP other than `reward_summary`, which emits but doesn't mutate) emit no events.

---

## 5. Reconstruction invariants

These invariants are asserted by the test suite and hold for the lifetime of a household. They are what makes the event stream a trustworthy audit log:

1. **Treasury reconciliation.** `sum(FundsDeposited.lamports) - sum(FundsWithdrawn.lamports) - sum(Reimbursed.lamports) == household.vault_balance` at any slot.
2. **Reward reconciliation.** `sum(RewardEarned.points where points > 0) == household.total_rewards_distributed == sum(Member.reward_points over active members)`.
3. **Membership reconciliation.** Walking `MemberAdded` minus `MemberRemoved` for a household yields exactly the set of wallets whose `Member` PDAs currently exist.
4. **Lifecycle monotonicity.** For any `request`, the sequence `(PurchaseCreated, PurchaseApproved, Restocked, Reimbursed)` or `(PurchaseCreated, [PurchaseApproved,] PurchaseRejected)` appears in slot order, with no gaps in the happy path.
5. **No-self-approval.** For every `PurchaseApproved`, `approver != buyer`. Guaranteed structurally; asserted by `test_permissions.rs`.

---

## 6. Event versioning

Events are not upgradeable in the MVP — the structs are fixed for the program's lifetime. If a field must be added later, the plan is:

- Add the field as a trailing `Option<T>` with `#[borsh(skip)]` on the old variant, or
- Introduce a new event variant (e.g. `RewardEarnedV2`) and keep the original emitting for back-compat.

Either way, the privacy boundary (Section 2) and the instruction→event matrix (Section 4) are re-asserted by the test suite on every change.

---

## Next up

- **`plan/07_security.md`** — the security checklist applied to Stocksie: owner checks, signer checks, PDA seed design, close patterns, and the specific attack vectors the program defends against. Then `08_testing.md`, `09_build_phases.md`, `10_docs.md` finish the plan folder before we resume implementation in `programs/stocksie/src/instructions/funds.rs`.