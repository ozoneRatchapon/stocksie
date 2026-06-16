# Phase 10 — Lint, Clippy, Fmt, Autofixer Sweep

> Implementation plan for Phase 10 of `plan/09_build_phases.md`.
> Scope source: `plan/09_build_phases.md` §Phase 10, project cross-phase rules
> (`cargo clippy --fix --allow-dirty`, fix warnings before commit, remove truly
> unused code).

## 0. Context

Phase 9 landed 18 new tests (10 security + 5 invariants + 2 privacy + 1 space)
at commit `8c323b4`, bringing the suite to **75 passing** (24 unit + 51
integration). Both `cargo clippy --all-targets -- -D warnings` and
`cargo fmt --all -- --check` were green at commit time.

Phase 10 is the **ship-readiness gate**: confirm the codebase carries no
lint debt, no formatting drift, no panic-prone idioms, and no autofixer
findings before Phase 11 (docs) and Phase 12 (handover + final commit).
No production behavior changes are expected — if a gate fails, fix the root
cause per project rule (don't guess, don't paper over).

## 1. Scope (mirrors `plan/09_build_phases.md` §Phase 10)

| Gate | Tool | Surfaces |
| --- | --- | --- |
| G1 | `cargo fmt --all -- --check` | formatting drift |
| G2 | `cargo clippy --all-targets -- -D warnings` | lint + dead-code |
| G3 | ripgrep over `programs/stocksie/src/**/*.rs` | `unwrap()` / `expect()` / `TODO` / `FIXME` / `unimplemented!` / `todo!` / `unreachable!` / placeholder idioms |
| G4 | `program_autofixer` | account-validation / signer / CPI findings across every source file |

## 2. Preliminary reconnaissance (honest pre-state)

Run before drafting this plan; recorded so execution isn't a surprise.

- **G1 fmt** — was green at Phase 9 commit `8c323b4`; expected to remain green
  (no source touched since).
- **G2 clippy** — was green at Phase 9 commit `8c323b4` (re-verified in the
  same run that produced the commit). Expected to remain green.
- **G3 panic/placeholder scan** — ripgrep over `programs/stocksie/src/**/*.rs`
  for `\bunwrap\(\)|\.expect\(|\bTODO\b|\bFIXME\b|\bXXX\b|\bunimplemented!\(|\btodo!\(|\bunreachable!\(`
  returned **zero matches**. A second pass for the safe variants
  (`.unwrap_or\(|\.unwrap_or_default\(|\.unwrap_or_else\(`) also returned
  zero. The production source is clean.
- **G4 autofixer** — Phase 9 ran it on three files (`lib.rs`,
  `instructions/reimburse.rs`, `instructions/funds.rs`) with zero findings.
  Phase 10 extends coverage to **all 14 source files** under `src/`.

## 3. Checklists

### 3.1 G1 — `cargo fmt`

- [x] Run `cargo fmt --all -- --check`. **Result:** exit 0; printed `FMT_CHECK: PASS`.
- [x] If drift: run `cargo fmt --all` (no `--check`), then re-verify. **Result:** N/A — no drift detected on the first check.
- [x] Confirm `git diff` after fmt is empty (or explain why formatting moved). **Result:** `git diff --stat` empty — zero formatting delta.

### 3.2 G2 — `cargo clippy -D warnings`

- [x] Run `cargo clippy --fix --allow-dirty --all-targets` (per project rule;
      apply machine-applicable fixes first). **Result:** `Finished` with no
      fixes applied — `git diff --stat` empty afterward.
- [x] Run `cargo clippy -p stocksie --all-targets --all-features -- -D warnings`.
      **Result:** exit 0; no warnings, no output.
- [x] Confirm exit code 0 with no warnings. **Result:** confirmed.
- [x] Investigate any dead-code warnings: remove truly unused code, or
      `#[allow(dead_code)]` with an inline justification only if the item is
      intentionally reserved client surface (per `plan/09_build_phases.md`).
      **Result:** none surfaced.
- [x] If a fix touches production source, re-run `cargo test -p stocksie`
      to confirm the 75/75 baseline still holds. **Result:** N/A — no source
      touched; regression still verified independently (see §4).

### 3.3 G3 — `unwrap()` / `TODO` / placeholder scan

Scope: every `.rs` under `programs/stocksie/src/` (production only — tests
are out of scope; test-only `unwrap()` on assertion paths is permitted).

Files in scope (14):

- `src/lib.rs`
- `src/constants.rs`
- `src/error.rs`
- `src/events.rs`
- `src/types.rs`
- `src/instructions/mod.rs`
- `src/instructions/household.rs`
- `src/instructions/funds.rs`
- `src/instructions/purchase.rs`
- `src/instructions/reimburse.rs`
- `src/instructions/rewards.rs`
- `src/state/mod.rs`
- `src/state/household.rs`
- `src/state/member.rs`
- `src/state/purchase_request.rs`

- [x] ripgrep `\bunwrap\(\)|\.expect\(` — expect zero (preliminary: zero).
      **Result:** zero in production code. All matches reside inside
      `#[cfg(test)] mod tests` blocks (verified by cross-referencing match
      line numbers against `#[cfg(test)]` boundaries via
      `rg '#\[cfg\(test\)\]|mod tests'`).
- [x] ripgrep `\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b` — expect zero (preliminary: zero).
      **Result:** zero matches.
- [x] ripgrep `\bunimplemented!\(|\btodo!\(|\bunreachable!\(` — expect zero (preliminary: zero).
      **Result:** zero matches.
- [x] ripgrep `\.unwrap_or\(|\.unwrap_or_default\(|\.unwrap_or_else\(` —
      expect zero (preliminary: zero); if any appear, verify each is a
      legitimate default-value call, not a silenced error path.
      **Result:** zero matches.
- [x] Spot-check: no `panic!(`, no `assert!` outside `cfg(test)`. **Result:**
      the sole `panic!` token is inside a doc-comment in `lib.rs` explaining
      the `#![allow(clippy::diverging_sub_expression)]` attribute — not
      executable code. All `assert!`/`assert_eq!`/`assert_ne!` matches are
      inside `#[cfg(test)]` blocks.

### 3.4 G4 — `program_autofixer` final pass

Run on **every** source file (Phase 9 only covered 3). Group by directory
for readability of the report; all must return zero findings.

- [x] `src/lib.rs` — dispatch wiring. **Result:** `issues: [], suggestions: []`.
- [x] `src/constants.rs` — seed constants. **Result:** `issues: [], suggestions: []`.
- [x] `src/error.rs` — error enum. **Result:** `issues: [], suggestions: []`.
- [x] `src/events.rs` — event structs. **Result:** `issues: [], suggestions: []`.
- [x] `src/types.rs` — `Role`, `Status`. **Result:** `issues: [], suggestions: []`.
- [x] `src/instructions/household.rs` — init / add_member / remove_member / set_role. **Result:** `issues: [], suggestions: []`.
- [x] `src/instructions/funds.rs` — deposit_funds / withdraw_funds. **Result:** `issues: [], suggestions: []`.
- [x] `src/instructions/purchase.rs` — create / approve / reject / confirm / close. **Result:** `issues: [], suggestions: []`.
- [x] `src/instructions/reimburse.rs` — reimburse_buyer (SOL transfer + reward). **Result:** `issues: [], suggestions: []`.
- [x] `src/instructions/rewards.rs` — award_reward / reward_summary. **Result:** `issues: [], suggestions: []`.
- [x] `src/state/household.rs` — vault mirror + debit/credit helpers. **Result:** `issues: [], suggestions: []`.
- [x] `src/state/member.rs` — reward accumulator. **Result:** `issues: [], suggestions: []`.
- [x] `src/state/purchase_request.rs` — lifecycle + reward stages. **Result:** `issues: [], suggestions: []`.

All 13 files returned `framework_detected: anchor` with zero issues and zero
suggestions. (`src/instructions/mod.rs` and `src/state/mod.rs` are index-only
re-exports with no account validation logic — excluded from the autofixer pass.)

If any file returns a finding: stop, surface it, and patch root cause before
continuing (do NOT silence with `#[allow(...)]`).

## 4. Done-when

All five conditions from `plan/09_build_phases.md` §Phase 10:

- [x] `cargo fmt --all -- --check` passes. **Verified:** exit 0.
- [x] `cargo clippy --all-targets -- -D warnings` passes. **Verified:** exit 0, no warnings.
- [x] `program_autofixer` reports no issues across all 13 source files. **Verified:** every file returned `issues: [], suggestions: []`.
- [x] No `unwrap()` in non-test program code (preliminary: confirmed clean). **Verified:** all matches inside `#[cfg(test)]` or comments.
- [x] No dead-code warnings beyond unused client-surface items. **Verified:** none surfaced.

Plus regression guard:

- [x] `cargo test -p stocksie` still reports **75 passed, 0 failed**. **Verified:** `PASSED: 75 FAILED: 0`.

## 5. Verification sequence

Run in order; record output of each gate. Indented code blocks are the
canonical commands.

1. Formatting:

        cargo fmt --all -- --check

2. Clippy (auto-fix first, then enforce):

        cargo clippy --fix --allow-dirty --all-targets
        cargo clippy -p stocksie --all-targets --all-features -- -D warnings

3. Panic-idiom / placeholder scan:

        rg --no-heading '\bunwrap\(\)|\.expect\(|\bTODO\b|\bFIXME\b|\bXXX\b|\bHACK\b|\bunimplemented!\(|\btodo!\(|\bunreachable!\(|\.unwrap_or\(|\.unwrap_or_default\(|\.unwrap_or_else\(' programs/stocksie/src

4. `program_autofixer` on each file listed in §3.4.

5. Regression:

        cargo test -p stocksie 2>&1 | rg 'test result:' | awk '{p+=$4; f+=$6} END {print "PASSED:", p, "FAILED:", f}'

## 6. Commit policy

- If any gate produces a fix (fmt drift, clippy auto-fix, dead-code removal,
  autofixer patch): one conventional commit per logical fix family, e.g.
  `style: cargo fmt + clippy --fix sweep (Phase 10)`.
- If every gate is green on the first pass with no source changes: no commit
  is needed — record "Phase 10: clean sweep, no changes" in the handover
  and flip `plan/09_build_phases.md` §Phase 10 to `[x]`.
- Always: flip `plan/09_build_phases.md` §Phase 10 `[ ]` → `[x]` once the
  done-when block is fully checked.

## 7. Forward path

After Phase 10 lands clean:

- **Phase 11** — docs (`README.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
  `docs/TESTING.md`, `docs/PRIVACY.md`) per `plan/10_docs.md`.
- **Phase 12** — `.handovers/001_stocksie_mvp.md` + final
  `feat: stocksie MVP` commit on `develop/feature/01_household_program`.

## 8. Honesty notes

- The preliminary reconnaissance (§2) strongly suggests Phase 10 will be a
  **clean confirmation sweep** — every gate was already green at Phase 9
  commit `8c323b4`, and the panic-idiom scan returned zero. The plan still
  executes every gate end-to-end so the handover can honestly claim
  "verified clean on <date>" rather than "assumed clean because Phase 9 was."
- `program_autofixer` was only run on 3 of 14 files in Phase 9; Phase 10
  closes the remaining 11. If a finding surfaces in any of them, stop and
  patch before flipping the done bit.
- No production behavior changes are in scope. If a gate forces a source
  edit, the 75/75 test baseline must be re-verified before commit.