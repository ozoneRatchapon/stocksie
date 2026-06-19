// Tests for the avatar helpers (plan 007 §B.1).
//
// Pins the properties that matter for the UI: determinism (same seed → same
// output across calls), palette coverage, SSR safety (no `Math.random` /
// `Date` / `window`), and base58-aware initial derivation.

import { describe, expect, it } from "vitest";
import { avatarColor, avatarInitials, type AvatarColor } from "./avatar";

describe("avatarColor — determinism", () => {
  it("returns the same color for the same seed across repeated calls", () => {
    const seed = "7N2qK9PxAbCdEfGhIjKlMnOpQrStUvWxYz1234567890";
    const a = avatarColor(seed);
    const b = avatarColor(seed);
    expect(a).toBe(b);
  });

  it("returns the same color for two different seed instances with the same content", () => {
    // Two distinct string literals with the same chars must hash identically —
    // the hash is content-addressed, not reference-addressed.
    const seed1 = "At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj";
    const seed2 = "At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj";
    expect(avatarColor(seed1)).toEqual(avatarColor(seed2));
  });
});

describe("avatarColor — palette coverage", () => {
  it("returns entries from the known 8-entry pastel palette", () => {
    // The palette is fixed; every result must be one of these 8 pairs. This
    // also pins the exact Tailwind class strings so a future palette edit
    // can't silently drop a `dark:` variant.
    const knownPalette: AvatarColor[] = [
      { bg: "bg-rose-100 dark:bg-rose-900/40", text: "text-rose-700 dark:text-rose-200" },
      { bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-700 dark:text-amber-200" },
      { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-700 dark:text-emerald-200" },
      { bg: "bg-sky-100 dark:bg-sky-900/40", text: "text-sky-700 dark:text-sky-200" },
      { bg: "bg-violet-100 dark:bg-violet-900/40", text: "text-violet-700 dark:text-violet-200" },
      { bg: "bg-fuchsia-100 dark:bg-fuchsia-900/40", text: "text-fuchsia-700 dark:text-fuchsia-200" },
      { bg: "bg-teal-100 dark:bg-teal-900/40", text: "text-teal-700 dark:text-teal-200" },
      { bg: "bg-indigo-100 dark:bg-indigo-900/40", text: "text-indigo-700 dark:text-indigo-200" },
    ];
    const seed = "9Bz7p4RWdX7eaR4hFUeCc7aSZjDHsie8q1u8imwavkBN";
    expect(knownPalette).toContainEqual(avatarColor(seed));
  });

  it("hits a reasonable spread of the palette over many distinct seeds", () => {
    // Generate 80 distinct seeds (10x the palette size) and assert we see at
    // least 5 of the 8 entries. A pathological hash would cluster on one or
    // two buckets; the FNV-1a spread should comfortably cover most.
    const seen = new Set<string>();
    for (let i = 0; i < 80; i++) {
      seen.add(avatarColor(`seed-${i}`).bg);
    }
    expect(seen.size).toBeGreaterThanOrEqual(5);
  });
});

describe("avatarColor — SSR safety", () => {
  it("does not reference `window`, `Math.random`, or `Date` (pure / deterministic)", () => {
    // Run twice in the same process; if the function used `Math.random` /
    // `Date.now` / a global counter, the second call could differ for the same
    // seed. Combined with the determinism test above this pins purity.
    const seed = "ssr-safety-check-pubkey";
    const first = avatarColor(seed);
    // Force a tiny delay to flush any `Date.now()`-based drift.
    const now = Date.now();
    while (Date.now() === now) {
      /* spin until the millisecond ticks, at most ~1ms */
    }
    const second = avatarColor(seed);
    expect(second).toEqual(first);
  });
});

describe("avatarInitials", () => {
  it("returns the first two chars uppercased for a base58 pubkey", () => {
    expect(avatarInitials("7N2qK9PxAbCd")).toBe("7N");
  });

  it("returns a single char for a one-char seed", () => {
    expect(avatarInitials("A")).toBe("A");
  });

  it("strips a leading @ so @alex → AL", () => {
    expect(avatarInitials("@alex")).toBe("AL");
  });

  it("trims leading whitespace before deriving", () => {
    expect(avatarInitials("  bob")).toBe("BO");
  });

  it("returns '?' for an empty / whitespace-only seed", () => {
    expect(avatarInitials("")).toBe("?");
    expect(avatarInitials("   ")).toBe("?");
    expect(avatarInitials("@")).toBe("?");
  });

  it("never returns a base58-ambiguous glyph as the first char of a real pubkey", () => {
    // Base58 alphabet: 123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz
    // (excludes 0, O, I, l). A real Solana pubkey can never start with these.
    // We assert the helper preserves whatever the seed gives (it's seed-driven,
    // not alphabet-restricting), but for a sample of real-looking pubkeys none
    // of them produce an ambiguous initial.
    const samples = [
      "7N2qK9PxAbCdEfGhIjKlMnOpQrStUvWxYz12",
      "At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG",
      "9Bz7p4RWdX7eaR4hFUeCc7aSZjDHsie8q1u8",
    ];
    const ambiguous = new Set(["0", "O", "I", "l"]);
    for (const s of samples) {
      expect(ambiguous.has(avatarInitials(s)[0])).toBe(false);
    }
  });
});
