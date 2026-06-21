import { describe, expect, it } from "vitest";
import { extractErrorMessage, lamportsToSol, solToLamports } from "./format";

// ---------------------------------------------------------------------------
// extractErrorMessage — the insufficient-lamports rewrite
// ---------------------------------------------------------------------------
//
// The system program's `Transfer: insufficient lamports X, need Y` log surfaces
// verbatim inside the Anchor `SendTransactionError` message. `extractErrorMessage`
// detects it (in any string-shaped or Error-shaped input) and rewrites it to a
// SOL-denominated, actionable message. These tests pin both the match and the
// fall-through behaviour for unrelated errors.

describe("extractErrorMessage — insufficient-lamports rewrite", () => {
  it("rewrites a raw simulation-log string into a SOL message", () => {
    const raw =
      "Transaction simulation failed: Error processing Instruction 2: custom program error: 0x1: 11 log messages: " +
      "Program ComputeBudget111111111111111111111111111111 invoke [1] " +
      "Program ComputeBudget111111111111111111111111111111 success " +
      "Program At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj invoke [1] " +
      "Program log: Instruction: DepositFunds " +
      "Program 11111111111111111111111111111111 invoke [2] " +
      "Transfer: insufficient lamports 14399666, need 1000000000 " +
      "Program 11111111111111111111111111111111 failed: custom program error: 0x1";

    const out = extractErrorMessage(raw);
    expect(out).toBe(
      `Your connected wallet has ~${lamportsToSol(
        14399666n
      )} SOL but this transaction needs ${lamportsToSol(
        1000000000n
      )} SOL. Fund your wallet and try again.`
    );
    // Sanity: the lamports are formatted as SOL, not raw integers. (Note:
    // `0.014399666` does contain `14399666` as a substring — that's just the
    // decimal shifted past `0.0` — so we assert the SOL-denominated phrasing
    // instead of a brittle substring-exclusion check.)
    expect(out).toContain("0.014");
    expect(out).toContain(" 1 SOL");
    expect(out).toContain("Fund your wallet");
  });

  it("rewrites the same pattern when it arrives as `Error.message`", () => {
    const err = new Error(
      "Simulation failed: Transfer: insufficient lamports 500000, need 2500000"
    );
    const out = extractErrorMessage(err);
    expect(out).toBe(
      `Your connected wallet has ~${lamportsToSol(
        500000n
      )} SOL but this transaction needs ${lamportsToSol(
        2500000n
      )} SOL. Fund your wallet and try again.`
    );
  });

  it("returns the input unchanged for a plain string with no match", () => {
    const raw = "User rejected the request";
    expect(extractErrorMessage(raw)).toBe("User rejected the request");
  });

  it("falls through to `Error.message` when the pattern is absent", () => {
    const err = new Error("AnchorError: ConstraintHasOne");
    expect(extractErrorMessage(err)).toBe("AnchorError: ConstraintHasOne");
  });
});

// ---------------------------------------------------------------------------
// extractErrorMessage — Anchor structured-error shapes (regression guard)
// ---------------------------------------------------------------------------
// These paths must keep working after the rewrite was slotted in.

describe("extractErrorMessage — Anchor shape handling", () => {
  it("prefers the Anchor framework `errorMessage` over the rewrite", () => {
    const err = new Error(
      "Transfer: insufficient lamports 1, need 2 (should be ignored)"
    );
    Object.assign(err, {
      error: {
        errorMessage: "Member is not active",
        errorCode: { code: "ConstraintRaw" },
      },
    });
    expect(extractErrorMessage(err)).toBe(
      "ConstraintRaw: Member is not active"
    );
  });

  it("prefers the Anchor program `{ code, msg }` over the rewrite", () => {
    const err = new Error(
      "Transfer: insufficient lamports 1, need 2 (should be ignored)"
    );
    Object.assign(err, { code: 6003, msg: "ZeroDeposit" });
    expect(extractErrorMessage(err)).toBe("ZeroDeposit");
  });

  it("returns 'Unknown error' for null/undefined", () => {
    expect(extractErrorMessage(null)).toBe("Unknown error");
    expect(extractErrorMessage(undefined)).toBe("Unknown error");
  });
});

// ---------------------------------------------------------------------------
// Lamport ↔ SOL helpers (used by the rewrite; guarded so a regression to
// `lamportsToSol` doesn't silently corrupt the error message).
// ---------------------------------------------------------------------------

describe("lamportsToSol / solToLamports — round-trip used by the rewrite", () => {
  it("formats the exact balance from the real failure case", () => {
    expect(lamportsToSol(14399666n)).toBe("0.014399666");
    expect(lamportsToSol(1000000000n)).toBe("1");
  });

  it("parses the deposit amount from the real failure case", () => {
    expect(solToLamports("1")).toBe(1000000000n);
  });
});
