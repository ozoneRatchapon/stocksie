# Stocksie — Documentation Plan

> What docs the repo ships, who each is for, and what it must contain. This is the source the `docs/` folder and root `README.md` are produced from in Phase 11.

This document closes the plan folder. After this file, the plan is complete and implementation resumes at `09_build_phases.md` → Phase 4b (`programs/stocksie/src/instructions/funds.rs`).

---

## 1. Doc principles

1. **Plan files are the source of truth; `docs/` are the polished output.** Each doc below maps 1:1 to one or more plan files. The plan can be terse and internal; the docs must be readable by someone who never reads the plan.
2. **No duplication without a reason.** Where a doc would just restate a plan file, it links to the plan instead and adds only the audience-facing framing.
3. **Buildable from the repo alone.** A new contributor who clones the repo, reads `README.md`, then `docs/`, can build, test, and extend Stocksie without asking anyone a question.
4. **Audience-first.** Each doc names its audience (new contributor, security reviewer, integrator, end-user-curious reader) in its header so readers know whether it's for them.
5. **Examples run.** Every shell snippet in the docs is the exact command the user can copy-paste; they're verified in Phase 11.

---

## 2. Doc catalog

| Path | Audience | Source plan | Status |
| --- | --- | --- | :---: |
| `README.md` | first-time visitor | `01_concept.md`, `02_architecture.md`, `09_build_phases.md` | `[ ]` |
| `docs/ARCHITECTURE.md` | contributor / integrator | `02_architecture.md`, `03_account_model.md` | `[ ]` |
| `docs/ACCOUNTS.md` | integrator / auditor | `03_account_model.md`, `05_state_machine.md` | `[ ]` |
| `docs/INSTRUCTIONS.md` | integrator / client dev | `04_instructions.md`, `06_events.md` | `[ ]` |
| `docs/SECURITY.md` | security reviewer | `07_security.md` | `[ ]` |
| `docs/TESTING.md` | contributor | `08_testing.md` | `[ ]` |
| `docs/PRIVACY.md` | privacy-conscious user / auditor | `03_account_model.md` §6, `06_events.md` §2 | `[ ]` |
| `docs/ROADMAP.md` | curious end user / sponsor | `01_concept.md` §5, this file §5 | `[ ]` |
| `CHANGELOG.md` | maintainer | git log | `[ ]` |

The `plan/` folder itself is intentionally kept in the repo (not gitignored) so the design rationale travels with the code, but it's labeled as internal — `docs/` is the public surface.

---

## 3. Per-doc spec

### 3.1 `README.md`

**Audience**: someone who just landed on the repo and has 60 seconds to decide if it's worth their time.

**Must contain**:

- One-paragraph elevator pitch (from `01_concept.md` opening).
- The 5 core features as a scannable list (Feature 2.1–2.5) with one line each.
- A "why Solana?" block — 3 bullets (program-controlled vault, on-chain approvals, verifiable events) linking to `docs/PRIVACY.md` and `docs/ARCHITECTURE.md`.
- Architecture diagram (copy the ASCII from `02_architecture.md` §1).
- **Quickstart** (the single most important section):
  ```sh
  # one-time: link shared target dir (see docs/ARCHITECTURE.md §6)
  ln -s ~/.cargo/target ./target

  # build + run the full LiteSVM suite
  anchor build
  cargo test -p stocksie
  ```
- Project layout tree (from `02_architecture.md` §3, top level only).
- Status badge / line pointing at `09_build_phases.md` for current progress.
- "Where to read next" — three links: `docs/ARCHITECTURE.md` (how it works), `docs/INSTRUCTIONS.md` (the on-chain surface), `plan/` (the design rationale).

**Tone**: enthusiastic but honest about MVP scope. No buzzwords the README doesn't define.

---

### 3.2 `docs/ARCHITECTURE.md`

**Audience**: a contributor who wants to understand the system before changing it, or an integrator deciding how to build on top.

**Source**: `plan/02_architecture.md` (polished, with the internal/machine-specific notes moved to a clearly-labeled "Appendix: environment quirks").

**Must contain**:

- The high-level diagram (client / boundary / program).
- The boundary rule stated upfront: only pubkeys, u64s, small enums, and `[u8; 32]` hashes cross it. Link to `docs/PRIVACY.md`.
- Tech stack table (Anchor 1.0.2, LiteSVM, native SOL vault, blake3).
- Version compatibility matrix (locked versions).
- Project layout (full tree, with one-line per-file descriptions).
- The "five-layer instruction shape" pattern (accounts → handler → state mutation → emit → unit tests).
- PDA derivation table (seeds + bump source per account).
- **Appendix: environment quirks** — the shared `CARGO_TARGET_DIR` symlink, the platform-tools arch recovery, the program-ID consistency rule. Labeled "machine-specific; not part of the design".

---

### 3.3 `docs/ACCOUNTS.md`

**Audience**: an integrator building a client (who needs the exact account layout) or an auditor reviewing the on-chain footprint.

**Source**: `plan/03_account_model.md` and `plan/05_state_machine.md`.

**Must contain**:

- The account catalog table (3 rows: Household, Member, PurchaseRequest).
- For each account: the Rust struct, a per-field table ("why on chain / why not"), the space budget, the rent-exempt cost.
- The vault model: Household PDA *is* the vault; `vault_balance` is a mirror; source of truth is `account.lamports()`.
- The `request_id` seed pattern and why it's monotonic.
- The state diagram (from `05_state_machine.md` §1) and the transition table.
- Per-state invariants (what the program guarantees holds at each node).
- The forbidden-transitions table (every rejected move and its error code).

---

### 3.4 `docs/INSTRUCTIONS.md`

**Audience**: a client developer wiring up transactions, or a security reviewer mapping the attack surface.

**Source**: `plan/04_instructions.md` and `plan/06_events.md`.

**Must contain**:

- The authority-model quick-reference table (every instruction, its caller-role gate, the constraint used).
- One section per instruction group (household, funds, purchase, reimburse, rewards), each with:
  - Signature.
  - Accounts table (field, type, mutability, seeds, constraints).
  - Args with validation rules.
  - Effect (business logic summary, including which state-machine method is called).
  - Emits (event list).
  - Errors (the `StocksieError` variants the instruction can return).
- The instruction → event matrix (audit-trail contract).
- The cross-cutting rules (checked arithmetic, no `init_if_needed`, canonical bumps, `has_one`, no free text, etc.) — the 10 rules from `04_instructions.md` §7.
- A minimal client example: deriving PDAs and building an `initialize_household` instruction using the generated TS/Rust client.

---

### 3.5 `docs/SECURITY.md`

**Audience**: a security reviewer or auditor. Written so a reviewer can treat it as a checklist and verify each claim against the code.

**Source**: `plan/07_security.md`.

**Must contain**:

- The core principle (attacker controls all inputs).
- The vulnerability matrix: each Solana attack category (owner checks, signer checks, arbitrary CPI, reinitialization, PDA sharing, type cosplay, duplicate-mutable, revival, data-matching, bump canonicalization, lamport griefing, writable enforcement) → Stocksie's defense → the test that verifies it.
- The program-specific invariants (vault solvency, no double reimbursement, reimbursement ceiling, no self-approval, buyer-only restock, irremovable owner, inactive = no authority).
- The arithmetic-safety policy (checked math everywhere; `overflow-checks = true`).
- The privacy invariant (no `String` on chain) and the grep test that enforces it.
- The CPI-signing safety section (canonical bump, stored owner).
- The account-closure safety section (`close = caller` semantics).
- The agent-assisted-development safety section (no key material, safe clusters, simulate first).
- The pre-deployment review checklist (every box checked, linking to the verifying test).

**Tone**: precise and verifiable. Every claim has a test name or a code reference.

---

### 3.6 `docs/TESTING.md`

**Audience**: a contributor about to add a feature or fix a bug, who needs to know how to run tests and where to add new ones.

**Source**: `plan/08_testing.md`.

**Must contain**:

- The testing pyramid diagram and why LiteSVM is the MVP layer.
- How to run the suite:
  ```sh
  # pure unit tests (no build needed)
  cargo test -p stocksie --lib

  # LiteSVM integration tests (requires anchor build first)
  anchor build
  cargo test -p stocksie --tests

  # one specific test file
  cargo test -p stocksie --test test_lifecycle
  ```
- The harness pattern (`setup_svm`, `derive_*`, `send`) with a short example.
- The test matrix — every test name, what it asserts, which plan invariant it maps to. (Copy the matrix from `08_testing.md` §3.)
- The negative-test pattern (positive control → mutate one variable → assert specific error code).
- The event-assertion pattern (decode `Program data:` logs, assert count + shape).
- The CI pipeline sketch.
- Coverage targets (every instruction has + and − tests; every error variant asserted; every forbidden transition covered; etc.).
- "Where to add a new test" — a contributor flowchart: is it pure logic? → inline `#[cfg(test)]`. Does it need accounts/CPI/events? → `tests/test_*.rs`. Does it touch a new invariant? → add a row to this doc's matrix first.

---

### 3.7 `docs/PRIVACY.md`

**Audience**: a privacy-conscious end user or a reviewer asking "what does the chain learn about my family?".

**Source**: `plan/03_account_model.md` §6 and `plan/06_events.md` §2.

**Must contain**:

- The boundary rule in plain language: "The chain proves *that* your family spent, approved, and reimbursed. It never learns *what* you bought, how much, or from where."
- The "what crosses the boundary" table (allowed shapes: pubkeys, u64s, small enums, `[u8; 32]` hashes; forbidden: raw item names, quantities, receipts, prices).
- A concrete walkthrough: "When your child reports the last paper towel ran out, the chain records a `PurchaseCreated` event with `item_hash = blake3("paper towels × 6 rolls")`. An observer sees that *some* item was requested, by whom, for how much — but not that it was paper towels."
- The off-chain responsibilities: the client (or the future Stocksie backend) keeps the item names, the hash preimages, the receipts, the consumption patterns. The chain only ever sees the digests.
- The tamper-evidence story: because `item_hash` is on chain, a malicious client cannot silently swap the item record after the fact — the hash pins it.
- The privacy invariant test (`no_string_fields_on_chain`) and how it protects the guarantee as the codebase evolves.
- What the MVP does *not* protect against (roadmap): metadata leakage via timing, account-existence oracle (an observer can tell a household PDA exists), member-graph inference (who transacts with whom). Honest about the gap between "private on chain" and "private from a determined chain analyst".

**Tone**: honest and specific. No vague "it's encrypted" hand-waving; name exactly what is and isn't protected.

---

### 3.8 `docs/ROADMAP.md`

**Audience**: a sponsor, a judge, or a curious user wondering "what's next?".

**Source**: `01_concept.md` §5 and this file §5.

**Must contain**:

- The MVP scope (what the 1-week build delivers) as a checked list.
- The "next 4 weeks" horizon:
  - Solana Mobile Stack (SMS) optimization — Last-One Tap as a mobile-native action.
  - Solana Blinks/Actions — approve a purchase or award points from a chat app.
  - AI receipt scanning — OCR a receipt, match it to a request, propose the reimbursement amount.
  - Predictive refill — learn consumption patterns off-chain, surface "you'll run out Thursday" hints.
- The "later" horizon:
  - USDC / SPL token vault (option, gated behind a feature flag) for households that prefer stablecoin accounting.
  - Multi-sig vault (Squads integration) for households that want N-of-M approval on large spends.
  - Account abstraction / session keys so a Child can transact without re-approving every tx.
  - Cross-household shared lists (e.g. two families splitting a bulk buy).
  - Housekeeper mode (a non-family role for hired help with scoped authority).
  - Family financial-literacy missions (structured learning quests that award bonus points).
- What's explicitly *out of scope* (not just "later" but "won't fix" in the current design):
  - On-chain item catalogs (privacy cost too high; the hash-reference model wins).
  - Public household discoverability (households are invite-only by design).

---

### 3.9 `CHANGELOG.md`

**Audience**: maintainers across releases.

**Format**: [Keep a Changelog](https://keepachangelog.com/) style, semantic-version sections.

Initial entry (MVP):

```markdown
## [Unreleased] — MVP
### Added
- Household PDA (also the shared SOL vault) with `initialize_household`.
- Member lifecycle: `add_member`, `remove_member`, `set_role`.
- Vault flows: `deposit_funds`, `withdraw_funds`.
- Purchase lifecycle: `create_purchase_request`, `approve_purchase_request`,
  `reject_purchase_request`, `confirm_restock`, `close_purchase_request`.
- Reimbursement: `reimburse_buyer` (vault → buyer SOL, one-shot).
- Rewards: `award_reward`, `reward_summary`.
- 11 events forming the audit trail.
- LiteSVM test suite: lifecycle, permissions, reimburse edge cases, security,
  invariants, privacy-invariant source grep, space budget.
```

---

## 4. Doc style guide

- **Voice**: second person ("you") for instructions; third person for descriptions. Active voice.
- **Tense**: present tense for what the code does ("the program rejects…"), future for the roadmap.
- **Code blocks**: every shell command in a fenced block with a `sh` language tag; every Rust snippet in a fenced block with the file path in the language position (per the project's markdown style):
  ````
  ```programs/stocksie/src/lib.rs#L10-12
  declare_id!("At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj");
  ```
  ````
- **Cross-references**: link to plan files for rationale, to sibling docs for adjacent topics. Never link to a heading inside the same file when a plain "see §3 above" works.
- **Diagrams**: ASCII art only for the MVP (no Mermaid/image deps). Keep diagrams under 60 columns so they render in mobile GitHub.
- **No forward references to unbuilt features** except in `ROADMAP.md`. A doc that says "the USDC vault does X" before the USDC vault exists is a bug.

---

## 5. Production checklist (Phase 11 definition of done)

Each doc must satisfy:

- [ ] Runs through a markdown linter (`prettier --check docs/**/*.md README.md`) with no errors.
- [ ] Every shell command copy-pasted into a fresh shell either succeeds or fails with the exact documented error.
- [ ] Every code reference (file path + line range) points to code that exists at the time the doc is committed. (Use relative paths, not commit SHAs, so they stay live.)
- [ ] Every claim about program behavior ("the program rejects X with error Y") is backed by a named test in `docs/TESTING.md`'s matrix.
- [ ] No `TODO` / `FIXME` / `TBD` left in shipped docs. (Open questions go in `plan/` or an issue, not `docs/`.)
- [ ] The privacy boundary is stated identically in `README.md`, `docs/ARCHITECTURE.md`, `docs/PRIVACY.md`, and `docs/INSTRUCTIONS.md` — no drift.

---

## Next up

- **The plan folder is now complete** (`01`–`10`). Commit `plan/` with message `docs: plan folder — concept, architecture, accounts, instructions, state machine, events, security, testing, build phases, docs plan`.
- **Resume implementation** at `09_build_phases.md` → **Phase 4b**: `programs/stocksie/src/instructions/funds.rs` (`deposit_funds` + `withdraw_funds`).
- After Phase 4b, follow the per-phase "Next up" callouts: 4c (`purchase.rs`) → 4d (`reimburse.rs`) → 4e (`rewards.rs`) → 4f (`instructions/mod.rs`) → 5 (`lib.rs`) → 6 (clean build) → 7 (LiteSVM harness) → 8 (lifecycle tests) → 9 (security tests) → 10 (lint/autofixer) → 11 (these docs) → 12 (handover).