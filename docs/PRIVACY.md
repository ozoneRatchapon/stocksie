# Stocksie — Privacy

> **Audience:** a privacy-conscious end user asking "what does the chain learn
> about my family?", or a reviewer auditing the on-chain/off-chain data
> boundary. For the account fields this boundary governs see
> [ACCOUNTS.md](ACCOUNTS.md); for the events that cross it see
> [INSTRUCTIONS.md](INSTRUCTIONS.md) §3; for the security defenses see
> [SECURITY.md](SECURITY.md).

This is the canonical home of the privacy-boundary contract. The wording of the
boundary rule in §1 below is reused **verbatim** in [../README.md](../README.md),
[ARCHITECTURE.md](ARCHITECTURE.md), and [INSTRUCTIONS.md](INSTRUCTIONS.md) so the
guarantee is stated identically everywhere it appears — no drift.

---

## 1. The boundary rule (canonical statement)

The chain proves _that_ your family spent, approved, and reimbursed. It never
learns _what_ you bought, how much, or from where. The only shapes that cross
the on-chain boundary are pubkeys, `u64`/`u32`/`u8` integers, small enums
(`Role`, `Status`), booleans, and `[u8; 32]` blake3 hashes. Raw item names,
quantities, receipts, and prices never touch the ledger.

This is a **design invariant**, not a privacy policy that can be relaxed by a
configuration change. It is enforced structurally (every account field and event
payload is one of the permitted shapes) and it is machine-checked by the
[`no_string_fields_on_chain`](../programs/stocksie/tests/test_privacy_invariant.rs)
grep test, so the guarantee cannot silently regress as the codebase grows.

---

## 2. What crosses the boundary

| Shape                             | Examples on chain                                         |                 Allowed                 |
| --------------------------------- | --------------------------------------------------------- | :-------------------------------------: |
| `Pubkey`                          | member wallets, owner, approver, buyer                    |                    ✓                    |
| `u64`                             | lamports, points, slots, counters, request ids            |                    ✓                    |
| `u32`                             | `member_count`                                            |                    ✓                    |
| `u8`                              | `bump`                                                    |                    ✓                    |
| `[u8; 32]` (blake3 digest)        | `name_hash`, `item_hash`, `unit_cost_hash`, `reason_hash` |                    ✓                    |
| Small enums (`Role`, `Status`)    | role, status                                              |                    ✓                    |
| `bool`                            | `active`                                                  |                    ✓                    |
| `String` / `Vec<u8>` of free text | item name, receipt OCR text, reason text, household name  |        ✗ — hash off chain first         |
| Raw prices / pack sizes           | unit prices, grams, rolls, ml                             | ✗ — only `unit_cost_hash` of a snapshot |
| Receipts / images                 | OCR'd receipt text, photos                                |           ✗ — never on chain            |
| Consumption patterns              | "usually runs out Thursdays"                              |         ✗ — computed off chain          |

Every field on every `#[account]` struct and every field on every `#[event]`
struct in the source falls into an "allowed" row. The two grep tests
(`no_string_fields_on_chain` and `scanner_sees_all_on_chain_structs`) assert
this directly against the source so a contributor cannot accidentally introduce a
`String` field without a failing test.

---

## 3. A concrete walkthrough — the "Last-One Tap"

Say your child uses the last paper towel and taps the "ran out" button.

**Off-chain (the client).** The mobile UI composes the item detail —
`"paper towels × 6 rolls"` — and computes `item_hash = blake3("paper towels × 6 rolls")`.
It also asks the best-value engine for a recommendation snapshot and computes
`unit_cost_hash = blake3(snapshot)`. It keeps the raw item name, the snapshot,
and the preimages in its local/off-chain inventory DB.

**On-chain (the instruction).** The client submits `create_purchase_request` with
arguments that are _only_ permitted shapes:

```programs/stocksie/src/instructions/purchase.rs#L146-153
pub fn create_purchase_request_handler(
    ctx: Context<CreatePurchaseRequest>,
    amount_lamports: u64,
    item_hash: [u8; 32],
    unit_cost_hash: [u8; 32],
    buyer: Pubkey,
) -> Result<()> {
```

**What an observer sees.** A public chain observer can see _that_ some member of
your household opened a purchase request, _who_ is designated as the buyer, the
requested spend ceiling in lamports, and the two blake3 digests. They **cannot**
recover "paper towels", "6 rolls", the unit price, or the store — blake3 is a
one-way function, and the digest is meaningless without the off-chain preimage.

**The event that lands in the audit stream** carries the same permitted shapes:

```programs/stocksie/src/events.rs#L125-141
#[event]
pub struct PurchaseCreated {
    pub household: Pubkey,
    /// The PurchaseRequest PDA.
    pub request: Pubkey,
    /// Wallet designated as the buyer (receives the later reimbursement).
    pub buyer: Pubkey,
    /// Monotonic per-household request id (used in PDA seeds).
    pub request_id: u64,
    /// Requested spend in lamports.
    pub amount: u64,
    /// blake3 hash of item name + quantity. Privacy reference only.
    pub item_hash: [u8; 32],
    /// blake3 hash of the best-value recommendation snapshot.
    pub unit_cost_hash: [u8; 32],
    pub slot: u64,
}
```

No `String`, no raw text — by construction.

---

## 4. Off-chain responsibilities

The chain is deliberately ignorant of inventory detail. The client (and, in a
later phase, an optional Stocksie backend) is the sole keeper of:

- **Item names and quantities** — the plaintext behind every `item_hash`.
- **Hash preimages** — the mapping from a `[u8; 32]` digest back to the
  human-readable record it pins. Without this mapping, the on-chain digests are
  opaque.
- **Receipts** — never uploaded; at most a `blake3` of an OCR'd receipt could be
  recorded for tamper-evidence (the MVP does not do this, but the boundary
  permits it).
- **Prices and pack sizes** — the off-chain best-value engine (Feature 2.3) owns
  these; only a hash of a recommendation snapshot crosses the boundary as
  `unit_cost_hash`.
- **Consumption patterns** — "the detergent usually runs out every 18 days" is
  learned off-chain and surfaced as UI hints; it never becomes an on-chain field.

This split is what lets the program be open-source and fully auditable without
leaking what a family buys. The ledger is a transparent **contribution history**;
the household specifics stay on the family's devices.

---

## 5. Tamper-evidence — what the hashes buy you

Because `item_hash` and `unit_cost_hash` are recorded on chain, a malicious
client **cannot silently swap the record after the fact**. The chain pins the
digest at `create_purchase_request` time; if a client later claims the request
was "actually" for a different item, it must produce a preimage whose blake3
matches the on-chain digest — which, for blake3, means producing the original
input.

Concretely:

- `create_purchase_request` records `item_hash` and `unit_cost_hash`.
- `confirm_restock` **overwrites** `unit_cost_hash` with the actual-purchase
  snapshot (the buyer may have picked a different pack), so the off-chain
  best-value engine can re-score the real purchase and award any cost-saving
  bonus. The original `item_hash` is immutable from creation onward.
- `reimburse_buyer` and the reward events reference the request by pubkey, so
  the audit trail (which request, which buyer, which approver, how many
  lamports, which reward stage) is reconstructable from the event stream alone.

The hashes are not encryption. They are **commitments** — enough to detect a
swap, not enough to recover the plaintext. That is the intended property: the
chain proves integrity without learning content.

---

## 6. The invariant test

The privacy boundary is enforced by a source-grep test rather than a runtime
check, because the property is structural ("no `String` field exists") rather
than behavioral.

```programs/stocksie/tests/test_privacy_invariant.rs#L233
fn no_string_fields_on_chain() {
```

The test scans every `#[account]` and `#[event]` struct in the source and fails
if any field is a `String` (or any other disallowed shape). Its companion test
makes sure the scanner itself is not silently missing a struct:

```programs/stocksie/tests/test_privacy_invariant.rs#L282
fn scanner_sees_all_on_chain_structs() {
```

Together they keep the guarantee machine-checked for the life of the codebase: a
contributor who adds a `pub notes: String` field to an account gets a failing
test, not a privacy regression.

---

## 7. Honest gaps — what the MVP does _not_ protect against

The boundary above is a strong content guarantee (the chain never learns _what_
you buy). It is **not** a full anonymity guarantee. A determined chain analyst
can still learn:

- **Timing metadata.** The `slot` field on every event reveals _when_ your
  household transacts. Repeated patterns (e.g. a big deposit + reimbursement
  every Saturday morning) can be inferred from the public event stream.
- **Account-existence oracle.** Anyone can probe whether a given `Pubkey` is the
  owner of an initialized `Household` PDA by deriving the address and checking
  the chain. The existence of a household is public, even if its membership and
  purchases are not.
- **Member-graph inference.** Because `MemberAdded`, `MemberRemoved`, and the
  approval/reimbursement events all carry pubkeys, an observer can build a graph
  of "which wallets transact with which household" and infer family/cohabitation
  relationships from co-activity. The roles (`Owner`/`Parent`/`Child`/`Guest`)
  are also public on each `Member` account.
- **Amount correlation.** Lamport amounts are public. An observer who knows the
  real-world price of a common item can sometimes guess the item from the
  reimbursement amount (e.g. a 3.49 USDC-shaped lamport amount is suggestive,
  though the MVP uses raw SOL, not stable amounts).
- **Preimage dictionary attacks.** If an item description is predictable
  ("paper towels × 6 rolls" is a common phrase), an attacker who guesses it can
  compute its blake3 and confirm a match against an on-chain `item_hash`. The
  MVP does not salt the hashes; a future hardening pass could mix in a
  per-household secret to defeat this.

These gaps are inherent to running on a public ledger and are **not** fixable by
the program alone — they would require client-side mitigations (timing
randomization, salted hashes, decoy transactions) that are out of scope for the
MVP. They are listed here so no one mistakes "private on chain" for "private from
a determined chain analyst."

---

## 8. The bottom line

| Question                                              | Answer                                                                                                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Can the chain learn _what_ I buy?                     | **No.** Only a blake3 hash of the item+quantity is recorded.                                                                |
| Can the chain learn _how much_ I paid per unit?       | **No.** Only a blake3 hash of the price snapshot is recorded.                                                               |
| Can the chain learn _who_ in my family did what?      | By pubkey, **yes** — membership, roles, approvals, and reimbursements are attributable by design (that is the audit trail). |
| Can the chain learn _when_ we transact?               | **Yes** — every event carries a `slot`.                                                                                     |
| Can a malicious client silently rewrite our history?  | **No** — the on-chain hashes pin every record; a swap requires producing the original preimage.                             |
| Is my family anonymous to a determined chain analyst? | **No** — see §7. The boundary protects _content_, not _metadata_.                                                           |

---

## Where to go next

- [ACCOUNTS.md](ACCOUNTS.md) — the field-by-field breakdown of what each account
  stores and why, including the privacy note on every hash field.
- [INSTRUCTIONS.md](INSTRUCTIONS.md) §3 — the full event catalog and the
  instruction → event matrix (every payload is a permitted shape).
- [SECURITY.md](SECURITY.md) §5 — the privacy invariant as a security-checklist
  item, with its verifying test.
- [ARCHITECTURE.md](ARCHITECTURE.md) §1 — the boundary rule in the context of the
  overall client/program split.
