# Stocksie — Product Concept

> The anti-out-of-stock household coordination platform.
> Track essentials, kill duplicate purchases, approve shared spending, reimburse buyers, and reward smart buying — all on Solana.

---

## 1. The problem

Running a household is a logistics problem hiding inside a family problem. The same house keeps buying the same thing twice, forgetting the one thing that ran out, and arguing about who paid for what. The friction lives at five specific points:

1. **The "last one" moment** — someone uses the final paper towel and forgets to tell anyone. Two days later, no paper towels.
2. **Duplicate purchases** — two family members are both at the store, both buy milk, the fridge overflows.
3. **Best-value blindness** — nobody compares price-per-roll across pack sizes; the household overpays silently every week.
4. **Reimbursement awkwardness** — the teenager bought groceries with their own money; nobody remembers to pay them back; resentment accrues.
5. **No reward for good behavior** — the kid who picked the cheapest pack gets the same recognition as the one who grabbed the premium brand. So the smart behavior doesn't repeat.

Stocksie turns each of those frictions into a tiny, satisfying, auditable on-chain moment.

---

## 2. The five core features

These map 1:1 to the five pain points above and to the on-chain surfaces in `03_account_model.md` and `04_instructions.md`.

### 2.1 Last-One Tap
A single-tap workflow to log when the final item of a household essential is used. The tap instantly creates a `PurchaseRequest` PDA (`Pending`) so the item is never forgotten. This is the entry point of the whole product loop.

- **On-chain effect**: `create_purchase_request` → `PurchaseCreated` event.
- **Reward**: +10 pts (`REWARD_LOW_STOCK_REPORT`) for reporting low stock.

### 2.2 Shared Household Shopping List
A real-time, shared registry where every member sees the status of every request:

| Status | Meaning |
| --- | --- |
| `Pending` | Someone proposed the buy; awaiting an approver. |
| `Approved` | Owner/Parent authorized the spend. Buyer may shop. |
| `Restocked` | Buyer confirmed the item is home. Ready to reimburse. |
| `Reimbursed` | Vault paid the buyer back. Terminal. |
| `Rejected` | Approver declined. Terminal. |

The list is derived purely from on-chain `PurchaseRequest` accounts — there is no separate off-chain list state to drift out of sync.

### 2.3 Best-Value Recommendation
A price-comparison engine computes price-per-unit across pack sizes and suggests the cheapest option. The **engine runs off-chain**; only a `blake3` hash of the recommendation snapshot (`unit_cost_hash`) is recorded on the request. That hash is enough to later prove *which* recommendation was used, without leaking prices to chain observers. Choosing the recommended pack can unlock the `REWARD_COST_SAVING` bonus.

### 2.4 Household Fund & Reimbursement
A shared treasury (the household PDA itself, holding SOL lamports). The lifecycle:

1. Members `deposit_funds` into the vault.
2. A buyer submits a `PurchaseRequest` (capped at `amount_lamports`).
3. Owner/Parent `approve_purchase_request`.
4. Buyer shops, then `confirm_restock`.
5. Owner/Parent `reimburse_buyer` → the vault signs a SOL transfer to the buyer.

Every step emits an event. The vault never releases funds without an approved, restocked request.

### 2.5 Family Reward & Learning Mode
A gamified loop where members earn points for helpful actions:

| Action | Points |
| --- | --- |
| Reporting low stock (`create_purchase_request`) | +10 |
| Confirming a restock | +25 |
| Picking the best-value pack | +50 |
| Completing a full grocery run | +15 |

Points are non-transferable, non-spendable reputation in the MVP — they unlock badges and bragging rights. The audit trail of *why* each point was granted (`RewardEarned` + `reason_hash`) is tamper-proof.

---

## 3. User roles

Four roles, privilege strictly decreasing:

| Role | Can transact | Can approve/reject | Can manage members | Can award rewards | Can withdraw vault | Can reimburse |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| **Owner** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Parent** | ✓ | ✓ | ✗ | ✓ | ✗ | ✓ |
| **Child** | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| **Guest** | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

- **Owner**: the household creator. Exactly one per household, irremovable, non-promotable. Set only by `initialize_household`.
- **Parent**: co-authority for spending. Cannot touch membership or drain the vault directly (must use the approval flow).
- **Child**: contributor. Can submit requests and confirm their own restocks; cannot approve or reimburse.
- **Guest**: read-only observer. Useful for extended family who want visibility without spend power.

Role checks are centralized in `types::Role::can_*()` so every instruction gate reads from one source of truth.

---

## 4. Why Solana?

The trust-critical surfaces — who is a member, who approved what, who got paid, who earned points — are exactly the things a family should be able to audit without trusting any single member's phone. Solana gives us:

- **Program-controlled vault** (Feature 3.2): the family treasury is a PDA; funds move only when the program's rules are satisfied.
- **On-chain approvals & reimbursements** (Feature 3.3): state transitions are signed and final. No "I said yes in the group chat" disputes.
- **Verifiable events** (Feature 3.4): `PurchaseCreated`, `PurchaseApproved`, `Restocked`, `Reimbursed`, `RewardEarned` form a tamper-proof contribution history.
- **Cheap, fast, final**: sub-cent fees and 400ms finality make a household-coordination app actually pleasant to use.

What does **not** go on chain: raw item names, quantities, receipts, consumption patterns (Feature 3.5). Those stay off-chain; the ledger stores only `blake3` hashes, pubkeys, amounts, and status.

---

## 5. MVP scope (1-week build)

The MVP demonstrates the full lifecycle, end-to-end:

1. Owner `initialize_household`.
2. Owner `add_member` (a Parent and a Child).
3. Member `deposit_funds` into the vault.
4. Child `create_purchase_request` (Last-One Tap).
5. Parent `approve_purchase_request`.
6. Child `confirm_restock`.
7. Parent `reimburse_buyer` → vault pays the child.
8. Reward points accrue at the relevant stages.
9. Every step verifiable via events and account reads.

**Out of scope for MVP** (deferred — see `10_docs.md` roadmap):
- Solana Mobile Stack / Blinks integration.
- AI receipt scanning and predictive refill.
- Multi-sig vault and account abstraction.
- Cross-household features (shared lists between families).

---

## 6. Success criteria

The MVP is done when **all** of these hold:

- A single LiteSVM test walks the full happy-path lifecycle (init → reimburse) and asserts every event + balance delta.
- Negative tests prove: non-members can't act, Children can't approve, no double-reimbursement, no over-ceiling reimbursement, vault can't go negative, removed members lose access.
- `anchor build` produces a clean `.so` + IDL with no warnings beyond dead-code on unused client surface.
- The privacy invariant holds: no instruction argument or account field contains raw item names, only `[u8; 32]` hashes.
```
