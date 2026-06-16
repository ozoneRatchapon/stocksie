# Stocksie — Instruction Specification

> The complete on-chain surface: every instruction, its arguments, its accounts, who may call it, what it changes, and what it emits.

This is the source the `instructions/` Rust files implement against. Each instruction below maps to one handler in `instructions/<group>.rs` and one forwarder in `lib.rs`'s `#[program]` block. Nothing ships that isn't documented here.

---

## How to read an instruction spec

Every entry has the same shape:

- **Signature** — the public Rust signature as exposed in `#[program]`.
- **Access** — which role(s) may call it, and any caller-side constraints.
- **Accounts** — the `#[derive(Accounts)]` struct, with each field's type, mutability, seeds, and constraint annotations.
- **Args** — typed instruction arguments with validation rules.
- **Effect** — the business logic that runs in the handler, including checked arithmetic and state-machine calls.
- **Emits** — the event(s) fired on success (see `06_events.md`).
- **Errors** — the `StocksieError` variants the instruction can return.

A recurring pattern: **access control lives in the accounts struct, business rules live in the handler.** Anything expressible as a `constraint = ...` (signer, seeds, `has_one`, role gate, active flag) is a constraint; anything that needs checked math, a state-machine transition, or multi-field validation is handler logic.

---

## Authority model — quick reference

| Instruction | Caller role gate | Constraint used |
| --- | --- | --- |
| `initialize_household` | anyone (becomes Owner) | `Signer<'info>` only |
| `add_member` | Owner | `caller_member.role.can_manage_members()` |
| `remove_member` | Owner | `caller_member.role.can_manage_members()` |
| `set_role` | Owner | `caller_member.role.can_manage_members()` |
| `deposit_funds` | active member (any role incl. Guest) | `caller_member.active` |
| `withdraw_funds` | Owner | `caller_member.role.can_withdraw_funds()` |
| `create_purchase_request` | active Owner/Parent/Child | `caller_member.can_transact()` |
| `approve_purchase_request` | active Owner/Parent, ≠ buyer | `caller_member.can_approve()` + self-approval guard |
| `reject_purchase_request` | active Owner/Parent | `caller_member.can_approve()` |
| `confirm_restock` | the recorded buyer | `buyer.key() == caller.key()` |
| `reimburse_buyer` | active Owner/Parent | `caller_member.can_approve()` |
| `award_reward` | active Owner/Parent | `caller_member.can_award_rewards()` |
| `close_purchase_request` | buyer or Owner, terminal status | role + status checks |
| `reward_summary` | active member | `caller_member.active` (read-only emit) |

Every gate is applied via the caller's `Member` PDA, which is seeded `[MEMBER_SEED, household, caller]` and `has_one = household`. A wallet that isn't an active member of *this* household cannot derive the right `Member` PDA and therefore cannot pass the constraint — the auth root is the seed, not a stored list.

---

## 1. Household management (`instructions/household.rs`)

### 1.1 `initialize_household(name_hash)`

Creates the `Household` PDA (also the vault) and the owner's own `Member` PDA in a single instruction, so the household is immediately usable.

**Access**: anyone. The signer becomes the Owner.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (init, mut) | `seeds = [HOUSEHOLD_SEED, owner.key()]`, `bump`, `payer = owner`, `space = 8 + Household::INIT_SPACE` |
| `owner_member` | `Account<Member>` (init) | `seeds = [MEMBER_SEED, household, owner]`, `bump`, `payer = owner`, `space = 8 + Member::INIT_SPACE` |
| `owner` | `Signer` (mut) | pays rent for both PDAs |
| `system_program` | `Program<System>` | — |

**Args**:
- `name_hash: [u8; 32]` — blake3 of the off-chain display name.

**Effect**:
- Set all `Household` fields: `owner`, `name_hash`, `bump = ctx.bumps.household`, `member_count = 1`, `request_counter = 0`, `total_rewards_distributed = 0`, `vault_balance = 0`, `created_slot = Clock::slot`.
- Set all `Member` fields: `household`, `wallet = owner`, `role = Role::Owner`, `reward_points = 0`, `active = true`, `bump = ctx.bumps.owner_member`, `joined_slot`.

**Emits**: `HouseholdCreated`, then `MemberAdded` (role `Owner`).

**Errors**: none beyond Anchor's init/constraint failures.

---

### 1.2 `add_member(new_member_wallet, role)`

Onboards a new wallet under a role.

**Access**: Owner only (`caller_member.role.can_manage_members()`), active.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (mut) | `member_count` increments |
| `caller_member` | `Account<Member>` | `seeds = [MEMBER_SEED, household, caller]`, `has_one = household`, `active`, `can_manage_members()` |
| `new_member` | `Account<Member>` (init) | `seeds = [MEMBER_SEED, household, new_member_wallet]`, `bump`, `payer = caller` |
| `caller` | `Signer` (mut) | pays rent |
| `system_program` | `Program<System>` | — |

**Args**:
- `new_member_wallet: Pubkey` — wallet to onboard (need not be a signer).
- `role: Role` — must not be `Owner`.

**Effect**:
- Reject `role == Owner` (`CannotModifyOwner`).
- Reject if `member_count >= MAX_MEMBERS` (`MemberLimitReached`).
- Initialize `new_member` fields; `bump = ctx.bumps.new_member`.
- `member_count += 1` (checked).

> Duplicate add: re-deriving the same `new_member` PDA collides on `init`, so the runtime rejects it. We never use `init_if_needed` (security checklist).

**Emits**: `MemberAdded`.

**Errors**: `CannotModifyOwner`, `MemberLimitReached`, `Overflow`, `UnauthorizedRole`, `MemberInactive`.

---

### 1.3 `remove_member(member_wallet)`

Hard-closes a membership. Rent is refunded to the caller; the `Member` PDA is wiped so the same wallet can be cleanly re-added later via a fresh `init`.

**Access**: Owner only, active.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (mut) | `member_count` decrements |
| `caller_member` | `Account<Member>` | Owner gate |
| `target_member` | `Account<Member>` (mut, `close = caller`) | `seeds = [MEMBER_SEED, household, member_wallet]`, `has_one = household`, `wallet == member_wallet`, `role != Owner` |
| `caller` | `Signer` (mut) | receives refunded rent |

**Args**:
- `member_wallet: Pubkey` — must match `target_member.wallet`.

**Effect**:
- `member_count -= 1` (checked).
- Anchor closes `target_member` (drains lamports to `caller`, zero-fills data, reassigns to system program).

> The owner is irremovable (`role != Owner` constraint). Self-removal by the owner is therefore impossible by construction.

**Emits**: `MemberRemoved`.

**Errors**: `CannotModifyOwner`, `MemberNotFound`, `Overflow`, `UnauthorizedRole`.

---

### 1.4 `set_role(new_role, member_wallet)`

Changes a non-owner member's role. Promotions (Child → Parent) and demotions (Parent → Guest) are both allowed.

**Access**: Owner only, active.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` | read-only (no count change) |
| `caller_member` | `Account<Member>` | Owner gate |
| `target_member` | `Account<Member>` (mut) | same constraints as `remove_member` minus `close` |
| `caller` | `Signer` | seed key only |

**Args**:
- `new_role: Role` — must not be `Owner`.
- `member_wallet: Pubkey`.

**Effect**:
- Reject `new_role == Owner` (`CannotModifyOwner`).
- `target.role = new_role`.

**Emits**: `RoleChanged` (carries `old_role` + `new_role`).

**Errors**: `CannotModifyOwner`, `MemberNotFound`, `UnauthorizedRole`.

---

## 2. Vault funds (`instructions/funds.rs`)

### 2.1 `deposit_funds(lamports)`

Anyone may top up a household vault — including non-members (a grandparent sending diaper money, say). The vault is the `Household` PDA itself.

**Access**: none at the program level; the `Signer` simply needs lamports. (A non-member deposit is a feature, not a bug — it's how external family support flows in.) However, we require the deposit to come through the standard membership path so the depositor's identity is auditable in the event.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (mut) | the vault |
| `depositor_member` | `Account<Member>` | `seeds = [MEMBER_SEED, household, depositor]`, `has_one = household`, `active` (Guests may deposit) |
| `depositor` | `Signer` (mut) | source of lamports |
| `system_program` | `Program<System>` | used by `credit_vault` |

**Args**:
- `lamports: u64` — must be `> 0`.

**Effect**:
- Reject `lamports == 0` (`ZeroDeposit`).
- `Household::credit_vault(depositor, household, system_program, lamports)` — a system-program `transfer` CPI plus a checked `vault_balance += lamports`.

**Emits**: `FundsDeposited` (with `vault_balance` snapshot after credit).

**Errors**: `ZeroDeposit`, `Overflow`.

---

### 2.2 `withdraw_funds(lamports)`

Emergency drain — Owner only. Intended for winding down a household or recovering mis-sent funds. Routine spending must go through the approval + reimbursement flow.

**Access**: Owner only (`caller_member.role.can_withdraw_funds()`), active.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (mut) | the vault; debited |
| `caller_member` | `Account<Member>` | Owner gate |
| `owner` | `Signer` (mut) | destination of the drain (must be the household owner) |
| `system_program` | `Program<System>` | — |

**Args**:
- `lamports: u64` — must be `> 0`.

> The destination is always the `owner` recorded on the `Household` account, not an arbitrary `to`. This prevents an Owner from routing treasury funds to a third-party wallet in a single instruction (which would defeat the reimbursement flow). For third-party payouts, use `reimburse_buyer` against an approved request.

**Effect**:
- Reject `lamports == 0` (`ZeroWithdrawal`).
- Verify `household.owner == owner.key()` (defense-in-depth).
- `Household::debit_vault(household, owner, lamports)`.

**Emits**: `FundsWithdrawn`.

**Errors**: `ZeroWithdrawal`, `InsufficientVaultFunds`, `NotOwner`, `Overflow`.

---

## 3. Purchase lifecycle (`instructions/purchase.rs`)

### 3.1 `create_purchase_request(amount_lamports, item_hash, unit_cost_hash, buyer)`

The on-chain anchor of the **Last-One Tap** (Feature 2.1). Any transacting member submits a request; the buyer is named explicitly (often the caller, but not required to be).

**Access**: active Owner/Parent/Child (`caller_member.can_transact()`).

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (mut) | `request_counter` increments |
| `caller_member` | `Account<Member>` | transact gate |
| `request` | `Account<PurchaseRequest>` (init) | `seeds = [PURCHASE_SEED, household, &request_id.to_le_bytes()]`, `bump`, `payer = caller` |
| `buyer_member` | `Account<Member>` | `seeds = [MEMBER_SEED, household, buyer]`, `has_one = household`, `active`, `can_transact()` — proves the named buyer is a real, active, transacting member |
| `caller` | `Signer` (mut) | pays rent |
| `system_program` | `Program<System>` | — |

**Args**:
- `amount_lamports: u64` — requested spend ceiling. Must satisfy `MIN_REQUEST_LAMPORTS <= amount <= MAX_REIMBURSEMENT_LAMPORTS`.
- `item_hash: [u8; 32]` — blake3 of item name + quantity.
- `unit_cost_hash: [u8; 32]` — blake3 of the best-value snapshot (Feature 2.3).
- `buyer: Pubkey` — the designated shopper / reimbursement recipient.

**Effect**:
- Range-check `amount_lamports`.
- `let request_id = household.next_request_id()?;` (first id is `1`).
- Initialize `request` fields: `household`, `buyer`, `request_id`, `amount_lamports`, `item_hash`, `unit_cost_hash`, `status = Pending`, `approved_by = Pubkey::default()`, slots `0`, `reimbursed_amount = 0`, `reward_earned = 0`, `bump = ctx.bumps.request`, `created_slot`.
- Reward the reporter: `caller_member.add_reward(REWARD_LOW_STOCK_REPORT)?;` and `request.record_reward_stage(REWARD_LOW_STOCK_REPORT)?;` and `household.record_rewards(REWARD_LOW_STOCK_REPORT)?;`.

> The `request_id` must be computed before the `init` constraint resolves the PDA, so the accounts struct uses `#[instruction(...)]` only for args; the seed nonce is handled by deriving `request_id = household.request_counter + 1` in the handler and validating the seed via a `seeds` constraint referencing a checked value. (See `05_state_machine.md` for the exact pattern.)

**Emits**: `PurchaseCreated`, then `RewardEarned` (reason: low-stock report).

**Errors**: `AmountBelowMinimum`, `AmountExceedsMaximum`, `MemberInactive`, `UnauthorizedRole`, `Overflow`, `ZeroReward`, `RewardOverflow`.

---

### 3.2 `approve_purchase_request()`

Owner/Parent authorizes the spend. The request moves `Pending → Approved`.

**Access**: active Owner/Parent (`caller_member.can_approve()`), **and `caller != buyer`** (separation of duties — you may not approve your own spend).

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` | read-only reference |
| `caller_member` | `Account<Member>` | approve gate |
| `request` | `Account<PurchaseRequest>` (mut) | `seeds = [...]`, `has_one = household` |
| `caller` | `Signer` | the approver |

**Args**: none beyond accounts.

**Effect**:
- Reject if `request.buyer == caller.key()` (`SelfApprovalForbidden`).
- `request.transition_approved(Clock::slot)?;`.
- `request.approved_by = caller.key();`.

**Emits**: `PurchaseApproved`.

**Errors**: `InvalidStatusTransition`, `AlreadyTerminal`, `SelfApprovalForbidden`, `UnauthorizedRole`, `MemberInactive`.

---

### 3.3 `reject_purchase_request(reason_hash)`

Owner/Parent declines the spend. Allowed from `Pending` or `Approved` (an approver can undo a mistaken approval before the buyer shops). Terminal.

**Access**: active Owner/Parent.

**Accounts**: same shape as `approve_purchase_request`.

**Args**:
- `reason_hash: [u8; 32]` — blake3 of an optional human-readable reason. May be all-zeros if no reason is supplied.

**Effect**:
- `request.transition_rejected()?;`.

**Emits**: `PurchaseRejected`.

**Errors**: `InvalidStatusTransition`, `AlreadyTerminal`, `UnauthorizedRole`, `MemberInactive`.

---

### 3.4 `confirm_restock(unit_cost_hash)`

The buyer attests the item is replenished. Only the recorded buyer may confirm. Moves `Approved → Restocked`, unlocking reimbursement.

**Access**: the recorded `buyer` (enforced by `request.buyer == caller.key()`). The buyer must be an active member at confirmation time.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (mut) | for `record_rewards` |
| `buyer_member` | `Account<Member>` (mut) | `seeds = [MEMBER_SEED, household, buyer]`, `has_one = household`, `active` |
| `request` | `Account<PurchaseRequest>` (mut) | `has_one = household`, `buyer == buyer_member.wallet` |
| `buyer` | `Signer` | must equal `request.buyer` |

**Args**:
- `unit_cost_hash: [u8; 32]` — may differ from the creation-time hash if the buyer picked a different package; recorded for the off-chain best-value engine to re-score.

**Effect**:
- `request.transition_restocked(Clock::slot)?;`.
- `request.unit_cost_hash = unit_cost_hash;` (overwrite with the actual-purchase snapshot).
- Reward the buyer for completing the restock: `buyer_member.add_reward(REWARD_RESTOCK_COMPLETED)?;`, `request.record_reward_stage(REWARD_RESTOCK_COMPLETED)?;`, `household.record_rewards(REWARD_RESTOCK_COMPLETED)?;`.

**Emits**: `Restocked`, then `RewardEarned` (reason: restock completed).

**Errors**: `InvalidStatusTransition`, `AlreadyTerminal`, `NotBuyer`, `MemberInactive`, `Overflow`, `RewardOverflow`.

---

### 3.5 `close_purchase_request()`

Reclaims rent from a terminal request (`Reimbursed` or `Rejected`). Lets the household keep its long-tail footprint small.

**Access**: the original buyer or the household Owner.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` | reference |
| `caller_member` | `Account<Member>` | `seeds = [MEMBER_SEED, household, caller]`, `has_one = household`, `active`; **must be either the buyer or the Owner** |
| `request` | `Account<PurchaseRequest>` (mut, `close = caller`) | `has_one = household`, `status.is_terminal()` |
| `caller` | `Signer` (mut) | receives rent |

**Args**: none.

**Effect**:
- Assert `request.status.is_terminal()`.
- Assert `caller_member.role == Owner || request.buyer == caller.key()`.
- Anchor closes the PDA (rent → caller).

**Emits**: none (the terminal event — `Reimbursed` or `Rejected` — was already emitted when the status was reached; closing is housekeeping).

**Errors**: `InvalidStatusTransition` (if not terminal), `NotBuyer`, `UnauthorizedRole`, `MemberInactive`.

---

## 4. Reimbursement (`instructions/reimburse.rs`)

### 4.1 `reimburse_buyer(lamports)`

The trust-critical moment: the vault pays the buyer back. Moves `Restocked → Reimbursed` and performs the SOL transfer in the same atomic instruction.

**Access**: active Owner/Parent (`caller_member.can_approve()`). The approver need not be the same wallet that approved originally.

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (mut) | the vault; debited via `debit_vault` |
| `caller_member` | `Account<Member>` | approve gate |
| `request` | `Account<PurchaseRequest>` (mut) | `has_one = household` |
| `buyer_member` | `Account<Member>` (mut) | `seeds = [MEMBER_SEED, household, request.buyer]`, `active` — recipient of the reward bonus |
| `buyer` | `AccountInfo` (mut) | the wallet receiving SOL; must equal `request.buyer` |
| `caller` | `Signer` | the authorizing approver |

**Args**:
- `lamports: u64` — actual payout. Must satisfy `0 < lamports <= request.amount_lamports`. The buyer may be paid less than the ceiling if they spent less.

**Effect**:
- `request.transition_reimbursed(lamports)?;` (this rejects over-ceiling and zero payouts, and rejects double-reimbursement via the `Restocked` precondition).
- `Household::debit_vault(household, buyer, lamports)?;` — signed by the household PDA via stored canonical bump.
- Reward the buyer for completing a full grocery run: `buyer_member.add_reward(REWARD_FULL_RUN_COMPLETED)?;`, `request.record_reward_stage(REWARD_FULL_RUN_COMPLETED)?;`, `household.record_rewards(REWARD_FULL_RUN_COMPLETED)?;`.

> Why `lamports` is an arg rather than always `amount_lamports`: real receipts don't always match the request ceiling (sales, substitutions, bulk discounts). Allowing the approver to reimburse the *actual* spend keeps the vault honest. The over-ceiling guard prevents abuse; the under-ceiling case is the buyer's gift to the household (and a candidate for a future `REWARD_COST_SAVING` bonus, see `06_events.md`).

**Emits**: `Reimbursed`, then `RewardEarned` (reason: full run completed).

**Errors**: `InvalidStatusTransition`, `AlreadyReimbursed`, `ReimbursementExceedsApproved`, `ZeroWithdrawal`, `InsufficientVaultFunds`, `UnauthorizedRole`, `MemberInactive`, `Overflow`, `RewardOverflow`.

---

## 5. Rewards (`instructions/rewards.rs`)

### 5.1 `award_reward(member_wallet, points, reason_hash)`

Manual point grant. Owner/Parent may reward any member for any reason (e.g. "noticed the milk was expiring", "found a coupon"). The reason text is hashed.

**Access**: active Owner/Parent (`caller_member.can_award_rewards()`).

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` (mut) | `total_rewards_distributed` bumps |
| `caller_member` | `Account<Member>` | reward gate |
| `target_member` | `Account<Member>` (mut) | `seeds = [MEMBER_SEED, household, member_wallet]`, `has_one = household`, `active` |
| `caller` | `Signer` | — |

**Args**:
- `member_wallet: Pubkey`.
- `points: u64` — must be `> 0`.
- `reason_hash: [u8; 32]` — blake3 of the human-readable reason.

**Effect**:
- `target_member.add_reward(points)?;`.
- `household.record_rewards(points)?;`.

**Emits**: `RewardEarned` (with `total_points = target_member.reward_points` after the credit).

**Errors**: `ZeroReward`, `RewardOverflow`, `MemberInactive`, `UnauthorizedRole`, `MemberNotFound`.

---

### 5.2 `reward_summary()`

Read-only convenience: emits a `RewardEarned` event with `points = 0` and the member's current `total_points`, so a client can fetch a member's score from the event stream without deserializing the account. (Optionally foldable into a pure client-side account read; included for the audit-stream use case.)

**Access**: active member (any role).

**Accounts**:
| Field | Type | Notes |
| --- | --- | --- |
| `household` | `Account<Household>` | reference |
| `caller_member` | `Account<Member>` | `seeds`, `has_one`, `active` |
| `caller` | `Signer` | — |

**Args**: none.

**Effect**: emit only; no state mutation.

**Emits**: `RewardEarned` with `points = 0`, `total_points = caller_member.reward_points`, `reason_hash = [0; 32]`.

> The `points = 0` sentinel is what lets auditors distinguish a summary emit from a real reward grant. `Member::add_reward` rejects `0`, so a summary can never be confused with a real credit at the data layer.

**Errors**: `NotAMember`, `MemberInactive`.

---

## 6. Instruction → Event matrix

Every state-changing instruction emits at least one event. This matrix is the audit-trail contract.

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
| `close_purchase_request` | — (terminal event already emitted) |
| `reward_summary` | `RewardEarned` (sentinel, `points = 0`) |

---

## 7. Cross-cutting rules (apply to every instruction)

These are non-negotiable and verified by the LiteSVM test suite (`08_testing.md`):

1. **Checked arithmetic everywhere.** No `+`, `-`, `*` on `u64`/`u32` without `.checked_*` and an `Overflow`/`RewardOverflow` error path.
2. **No `init_if_needed`.** All `init` constraints are unconditional; re-creation flows through `close` first.
3. **Canonical bumps only.** Every account stores `bump = ctx.bumps.*` at init and reuses it for CPI signing.
4. **`has_one = household` on every cross-account reference.** A `Member` or `PurchaseRequest` from family A can never authorize an action in family B.
5. **No free text on chain.** Every `String`-shaped concept is reduced to `[u8; 32]` before it crosses the boundary. Verified by `tests/test_privacy_invariant.rs`.
6. **Events carry pubkeys + amounts + hashes only.** Same rule, applied to the event payload layer.
7. **Soft-delete-respecting gates.** Every `can_*` check combines `active && role.can_*()` so a deactivated member loses all authority even if their role would otherwise permit the action.
8. **Self-approval forbidden.** `approve_purchase_request` rejects `caller == buyer`; the same person cannot both propose and authorize a spend.
9. **Reimbursement ceiling enforced.** `reimburse_buyer` rejects `lamports > request.amount_lamports` and rejects any call from a non-`Restocked` state, making double-reimbursement impossible.
10. **Vault solvency enforced.** `debit_vault` rejects `lamports > vault_balance` *and* keeps `vault_balance` mirrored to the actual account lamports.

---

## 8. Open design questions (resolved)

These were debated during planning; the resolutions are locked for the MVP.

- **Q: Should `approve_purchase_request` allow self-approval if the caller is the Owner?**
  - **A: No.** Separation of duties applies even to the Owner. The Owner can still route their own spend via a two-step (create as the buyer, then approve in a second tx signed by the same wallet — but the program requires `caller != buyer` *within a single approval call*, which is always satisfiable because the two are different roles in the same household membership model). For the MVP the simpler rule wins: no self-approval, period.

- **Q: Should `deposit_funds` be open to non-members?**
  - **A: No (for MVP).** Requiring a `Member` PDA keeps the depositor identity auditable in `FundsDeposited`. External support flows through a member (e.g. the grandparent is added as a `Guest`, deposits, and is later removed). Roadmap: an `external_deposit` instruction that takes an arbitrary `Signer` and emits a richer event.

- **Q: Why does `reimburse_buyer` take `lamports` as an arg instead of always paying the full ceiling?**
  - **A:** Real receipts vary. Paying the actual spend keeps the vault honest; the over-ceiling guard prevents abuse; the under-ceiling delta is the buyer's contribution to the household (and a candidate for a future savings reward).

- **Q: Why is `close_purchase_request` separate from `reimburse_buyer`?**
  - **A:** Two concerns. Reimbursement is the spend; closing is rent reclamation. Bundling them would force every reimbursement to also close the account, losing the audit row. Splitting them lets the household keep reimbursed requests on chain as long as desired, then close in a batch.

- **Q: Should the Owner be removable?**
  - **A: No.** The owner is the household's identity root (it's in the PDA seed). Removing the owner would orphan the household. Ownership transfer is a roadmap item and would require an ownership-migration instruction that re-derives a new household PDA.