# Stocksie — Roadmap

> **Audience:** a sponsor, a judge, or a curious user wondering "what's next?".
> This is the **only** doc that forward-references unbuilt features — per the
> project doc-style guide, the other docs describe only what ships today. For the
> shipped surface see [INSTRUCTIONS.md](INSTRUCTIONS.md); for the MVP scope see §1.

The horizons below are ordered: §1 is done, §2 is the next ~4 weeks, §3 is later,
and §4 is explicitly out of scope (not just "later" but "won't fix" in the current
design).

---

## 1. MVP scope — shipped ✅

Everything below is implemented, tested (75-test LiteSVM suite), and committed on
`develop/feature/01_household_program`. See [../README.md](../README.md) for the
quickstart and [plan/09_build_phases.md](../plan/09_build_phases.md) for the
per-phase tracker.

- [x] **Household lifecycle** — `initialize_household` (creates the PDA + vault +
      owner `Member`), `add_member`, `remove_member` (hard-close, rent refunded),
      `set_role`.
- [x] **Shared SOL vault** — `deposit_funds` (any active member, Guest included),
      `withdraw_funds` (Owner-only emergency drain, destination fixed to the
      recorded Owner).
- [x] **Purchase lifecycle (state machine)** — `create_purchase_request` (Last-One
      Tap, reporter reward), `approve_purchase_request` (no self-approval),
      `reject_purchase_request` (from `Pending` or `Approved`), `confirm_restock`
      (buyer-only), `close_purchase_request` (rent reclaim on terminal).
- [x] **Reimbursement** — `reimburse_buyer`: `Restocked → Reimbursed` with a direct
      vault → buyer SOL move, one-shot, ceiling-enforced, full-run reward.
- [x] **Rewards / gamification** — `award_reward` (Owner/Parent manual grant to any
      active member), `reward_summary` (read-only sentinel emit). Auto-rewards at
      low-stock report (+10), restock (+25), full run (+15).
- [x] **12 events** forming the tamper-proof audit trail (`HouseholdCreated`,
      `MemberAdded`, `MemberRemoved`, `RoleChanged`, `FundsDeposited`,
      `FundsWithdrawn`, `PurchaseCreated`, `PurchaseApproved`, `PurchaseRejected`,
      `Restocked`, `Reimbursed`, `RewardEarned`).
- [x] **Privacy boundary** — no `String` field on any account or event; all
      human-readable concepts reduced to `[u8; 32]` blake3 hashes. Machine-checked
      by `no_string_fields_on_chain`.
- [x] **Test coverage** — 24 unit + 51 LiteSVM integration tests covering
      lifecycle, permissions, reimbursement edge cases, Solana attack-category
      defenses, cross-cutting reconciliation invariants, the privacy grep, and the
      space budget.

---

## 2. Next horizon (~4 weeks)

The post-MVP work that most directly turns the program into a product.

### Solana Mobile Stack (SMS) optimization

Make the **Last-One Tap** a mobile-native action. The whole product loop starts
with a single tap; SMS lets that tap live on the lock screen / home screen as an
immutable action with no wallet-connect friction. The on-chain surface already
supports this — `create_purchase_request` is one signed instruction — so the work
is client-side (an Android dApp with an SMS action provider) plus a session-key
wrapper so a Child can tap without re-approving every transaction.

### Solana Blinks / Actions

Surface `approve_purchase_request`, `confirm_restock`, and `award_reward` as
**Blinks** so an approver can authorize a spend from a chat app (iMessage,
Discord, Telegram) without opening the full dApp. Each Blink maps to exactly one
program instruction; the accounts are pre-derived and embedded in the Action URL.
This makes the "approve the milk" loop as low-friction as tapping a link.

### AI receipt scanning

OCR a receipt on the client, match it to the open `PurchaseRequest` it reimburses,
and propose the reimbursement amount (`lamports`) from the scanned total. The
**off-chain** matching engine produces the number; `reimburse_buyer` enforces the
ceiling. The scanned receipt text never goes on chain — at most a `blake3` of the
OCR'd text could be recorded for tamper-evidence (the boundary already permits
this; the MVP does not wire it).

### Predictive refill

Learn per-household consumption patterns **off-chain** (e.g. "detergent runs out
every 18 days") and surface a "you'll run out Thursday" hint before the last one
is used. The hint triggers a pre-emptive `create_purchase_request`. No new on-chain
state: the pattern is derived from the event stream and stored client-side.

---

## 3. Later horizon

Valuable but deliberately deferred until the MVP proves the loop.

- **USDC / SPL token vault** — option, gated behind a feature flag, for households
  that prefer stablecoin accounting over native SOL. Adds a mint + ATA +
  `transfer_checked` surface; the current direct-lamport-move pattern would be
  replaced by a `token::transfer` CPI signed by the vault PDA. The
  `Household::signer_seeds` helper is already in place for this.
- **Multi-sig vault (Squads integration)** — for households that want N-of-M
  approval on large spends above a threshold. The approval flow already separates
  "buyer" from "approver"; a multi-sig layer would gate the approver step.
- **Account abstraction / session keys** — so a Child can transact (create
  requests, confirm restocks) without re-approving every transaction. Pairs with
  the SMS work above.
- **Cross-household shared lists** — two families splitting a bulk buy (e.g. a
  Costco run shared between two households). Requires a new cross-household
  `PurchaseRequest` variant or a shared-list PDA; the current `has_one = household`
  model intentionally blocks cross-household access, so this needs new design.
- **Housekeeper mode** — a non-family role for hired help, with scoped authority
  (e.g. "can confirm restock but cannot approve spend"). A new `Role` variant plus
  the relevant `can_*` predicates.
- **Family financial-literacy missions** — structured learning quests (e.g.
  "compare three prices before buying") that award bonus reward points. Pure
  off-chain orchestration plus `award_reward` calls.
- **Salted item hashes** — defeat preimage dictionary attacks (see
  [PRIVACY.md](PRIVACY.md) §7) by mixing a per-household secret into the blake3
  input. Backwards-compatible if introduced as a new field + a migration.

---

## 4. Out of scope ("won't fix" in the current design)

These are deliberately excluded — not just deferred — because they conflict with
the design's core commitments.

- **On-chain item catalogs.** Storing a catalog of known items (with names,
  brands, barcodes) would violate the privacy boundary — the whole point of the
  hash-reference model is that the chain never learns _what_ you buy. Item
  catalogs belong off-chain; the chain pins a hash, not a name.
- **Public household discoverability.** Households are invite-only by design:
  membership is established exclusively via the Owner's `add_member` call, and the
  member roster is intentionally not stored on chain (per-wallet `Member` PDAs +
  the privacy boundary). A public directory of households would leak the
  account-existence and member-graph signals that [PRIVACY.md](PRIVACY.md) §7
  already flags as inherent metadata leakage.

---

## How priorities are chosen

The ordering above reflects two principles:

1. **The loop must be low-friction.** Anything that removes a tap from the
   Last-One → Approve → Restock → Reimburse path is high-value (hence SMS, Blinks,
   session keys).
2. **The boundary is non-negotiable.** No roadmap item adds raw text, prices, or
   PII to the chain. Features that would require breaking the privacy invariant
   (on-chain catalogs, public discoverability) are out of scope rather than
   "later".

To propose a change to this roadmap, open an issue and reference the relevant
section here plus the source plan file
([`plan/01_concept.md`](../plan/01_concept.md) §5 for MVP scope, this file for the
horizons).

---

## Where to go next

- [../README.md](../README.md) — the 60-second overview and quickstart.
- [ARCHITECTURE.md](ARCHITECTURE.md) — how the shipped pieces fit together.
- [PRIVACY.md](PRIVACY.md) — the boundary that constrains every item above.
- [CHANGELOG.md](../CHANGELOG.md) — what shipped, by release.
