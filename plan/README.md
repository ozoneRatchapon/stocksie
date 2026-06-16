# Stocksie — Implementation Plan

This folder is the **single source of truth** for what we're building, why, and in what order. Implementation references these files; do not implement features that aren't planned here, and update the relevant plan file when design changes during the build.

## Hackathon context

- **Timeline**: 1-week MVP.
- **Stack**: Anchor 1.0.2 (modular layout) + LiteSVM (in-process Rust tests) + native SOL vault.
- **Constraint**: Privacy-first — on-chain state stores only `blake3` hashes of item/receipt/reason detail. The ledger proves *that* a spend happened, never *what* was bought.

## Plan index

| # | File | Purpose |
| --- | --- | --- |
| 01 | [`01_concept.md`](./01_concept.md) | Product concept, the 5 core features, user roles. |
| 02 | [`02_architecture.md`](./02_architecture.md) | Tech stack, project layout, toolchain, environment notes. |
| 03 | [`03_account_model.md`](./03_account_model.md) | On-chain accounts, PDA seeds, space budget. |
| 04 | [`04_instructions.md`](./04_instructions.md) | Full instruction set with args, accounts, and access control. |
| 05 | [`05_state_machine.md`](./05_state_machine.md) | Purchase request lifecycle and allowed transitions. |
| 06 | [`06_events.md`](./06_events.md) | Event catalog — what each event proves and what it omits. |
| 07 | [`07_security.md`](./07_security.md) | Security checklist applied to Stocksie. |
| 08 | [`08_testing.md`](./08_testing.md) | LiteSVM test plan: positive, permission, and negative cases. |
| 09 | [`09_build_phases.md`](./09_build_phases.md) | Phased build order with status tracking. |
| 10 | [`10_docs.md`](./10_docs.md) | User-facing and developer docs to produce. |

## How to use this folder

1. **Before implementing**: read `04_instructions.md` and `05_state_machine.md` for the surface you're touching.
2. **During implementation**: check off items in `09_build_phases.md` as they land.
3. **When design changes**: update the relevant `0N_*.md` first, then the code. Plan files lead, code follows.
4. **Security review**: cross-reference `07_security.md` before declaring any instruction done.

## Current status

- Branch: `develop/feature/01_household_program`
- Toolchain: verified working (`anchor build` produces `.so` + IDL; LiteSVM template test passes).
- Foundation code in progress (constants, types, errors, events, state). See `09_build_phases.md`.