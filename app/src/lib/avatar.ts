// Deterministic avatar helpers for Stocksie — derive a stable color + initials
// from any seed string (typically a base58 wallet pubkey). Pure, no React, no
// DOM, no `Math.random`, no `Date` — so the output is byte-identical on the
// server and the client (SSR-safe, no hydration mismatch).
//
// The color is picked from a fixed 8-entry pastel palette via a stable 8-bit
// hash of the seed. Two different pubkeys will collide on color ~1/8 of the
// time (birthday bound), which is fine — the initials disambiguate further,
// and the full pubkey is always one hover away via the avatar's `title`.

/** A background + text color pair, keyed by Tailwind class strings so the
 * classes are statically present in the source (Tailwind's JIT scanner needs
 * to see the full class name; dynamic concatenation would be purged). */
export interface AvatarColor {
  /** Tailwind `bg-*` class for the avatar background. */
  bg: string;
  /** Tailwind `text-*` class for the initials on top of the background. */
  text: string;
}

// Eight pastel-on-deep pairs. Light-mode pairs use a soft tinted bg with a
// darker text of the same hue; dark-mode pairs (the `dark:` variants on each
// class) use a deeper bg with a lighter text. All 16 class strings are
// literal so Tailwind's scanner keeps them.
const PALETTE: AvatarColor[] = [
  { bg: "bg-rose-100 dark:bg-rose-900/40", text: "text-rose-700 dark:text-rose-200" },
  { bg: "bg-amber-100 dark:bg-amber-900/40", text: "text-amber-700 dark:text-amber-200" },
  { bg: "bg-emerald-100 dark:bg-emerald-900/40", text: "text-emerald-700 dark:text-emerald-200" },
  { bg: "bg-sky-100 dark:bg-sky-900/40", text: "text-sky-700 dark:text-sky-200" },
  { bg: "bg-violet-100 dark:bg-violet-900/40", text: "text-violet-700 dark:text-violet-200" },
  { bg: "bg-fuchsia-100 dark:bg-fuchsia-900/40", text: "text-fuchsia-700 dark:text-fuchsia-200" },
  { bg: "bg-teal-100 dark:bg-teal-900/40", text: "text-teal-700 dark:text-teal-200" },
  { bg: "bg-indigo-100 dark:bg-indigo-900/40", text: "text-indigo-700 dark:text-indigo-200" },
];

/**
 * Stable 8-bit hash of a string. FNV-1a-inspired: fold each char code into an
 * accumulator with a prime multiplier, keeping the result in `uint8` range.
 * Deliberately non-cryptographic — the goal is just a stable, well-spread
 * bucket assignment for palette selection.
 */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    // Multiply by the FNV prime and keep it in 32-bit range with a bitwise OR
    // (forces the value back to int32 as JS math would otherwise drift to a
    // float). The final `>>> 0` is deferred to `avatarColor`.
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pick a deterministic palette entry for the given seed. Same seed → same
 * color, across calls, across server and client, forever.
 */
export function avatarColor(seed: string): AvatarColor {
  return PALETTE[hashSeed(seed) % PALETTE.length];
}

/**
 * Derive 1–2 readable initials from a seed (typically a base58 pubkey).
 *
 * Base58 (Solana's address alphabet) excludes `0`, `O`, `I`, `l` to avoid
 * look-alike ambiguity, so any leading char is already readable. We take the
 * first two characters uppercased — short enough to fit in a 24px circle,
 * long enough to disambiguate same-color avatars in a household.
 *
 * For non-base58 seeds (e.g. a friendly name), we still take the first two
 * chars, skipping a leading `@`/space so `@alex` → `AL`.
 */
export function avatarInitials(seed: string): string {
  const trimmed = seed.trim().replace(/^[@\s]+/, "");
  if (trimmed.length === 0) return "?";
  const chars = trimmed.slice(0, 2).toUpperCase();
  return chars;
}
