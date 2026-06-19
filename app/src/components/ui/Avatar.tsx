"use client";

// Avatar — a deterministic colored tile showing 1–2 initials derived from a
// seed (typically a base58 wallet pubkey). Replaces the old `shortPubkey()`
// glyph-salad as the primary member identifier across the dashboard (plan 007
// §B / §4.2).
//
// SSR-safe: the color + initials come from pure helpers (`lib/avatar.ts`) that
// don't touch `Math.random`, `Date`, or `window`, so server and client render
// byte-identical markup — no hydration mismatch. The full seed (full pubkey)
// is exposed via the `title` attribute so power users still get the raw
// address on hover, matching the pre-existing tooltip pattern in StateView.

import { avatarColor, avatarInitials } from "@/lib/avatar";
import { cn } from "@/lib/cn";

export type AvatarSize = "sm" | "md" | "lg";

const SIZE_CLASSES: Record<AvatarSize, string> = {
  // Fixed square dimensions + centered initials. `shrink-0` so the avatar
  // keeps its size inside flex rows even when siblings overflow.
  sm: "h-6 w-6 text-[10px]",
  md: "h-8 w-8 text-xs",
  lg: "h-10 w-10 text-sm",
};

export interface AvatarProps {
  /** Seed for the deterministic color + initials (usually a base58 pubkey). */
  seed: string;
  /** Tile size. Defaults to `md`. */
  size?: AvatarSize;
  /** Tooltip text (defaults to the seed itself, i.e. the full pubkey). */
  title?: string;
  /** Extra classes for the wrapper (e.g. layout positioning). */
  className?: string;
}

export function Avatar({ seed, size = "md", title, className }: AvatarProps) {
  const color = avatarColor(seed);
  const initials = avatarInitials(seed);
  return (
    <span
      title={title ?? seed}
      aria-label={title ?? seed}
      role="img"
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-lg font-semibold tracking-tight",
        color.bg,
        color.text,
        SIZE_CLASSES[size],
        className,
      )}
    >
      {initials}
    </span>
  );
}
