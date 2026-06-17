// Tailwind-aware class-name joiner — a 12-line `clsx` substitute.
//
// The Stocksie UI needs to merge conditional class lists (base styles + state
// variants) in a few primitives (Button, Badge, Field). Pulling in `clsx` or
// `tailwind-merge` for that is overkill: every argument here is either a
// string, a falsy value to skip, or an object whose keys are emitted when
// their values are truthy. No dedupe / tailwind-conflict resolution is needed
// because each primitive owns a disjoint Tailwind namespace (one source of
// truth per property).

type ClassValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | ClassDict;
type ClassDict = Record<string, boolean | null | undefined>;

/**
 * Join class names, skipping falsy entries.
 *
 * ```ts
 * cn('px-2', isActive && 'bg-emerald-500', { 'opacity-50': disabled })
 * // → 'px-2 bg-emerald-500 opacity-50'  (when both flags are truthy)
 * ```
 */
export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  for (const v of values) {
    // Skip every falsy value: `false`, `null`, `undefined`, `0`, `0n`, `''`.
    // The type union accepts `number`/`bigint`/`boolean` precisely so callers
    // can write `cond && 'cls'` where `cond`'s type widens to include `0`
    // (e.g. a `ReactNode`-typed `suffix` prop) without a type error.
    if (!v) continue;
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) out.push(trimmed);
      continue;
    }
    for (const [key, on] of Object.entries(v)) {
      if (on) {
        const trimmed = key.trim();
        if (trimmed.length > 0) out.push(trimmed);
      }
    }
  }
  return out.join(" ");
}
