// Stocksie shared types — client-side mirrors of the on-chain `Role` and
// `Status` enums (`programs/stocksie/src/types.rs`) plus converters for the
// Anchor enum serialization format (`{ variant: {} }`).

export type Role = "owner" | "parent" | "child" | "guest";
export type Status =
  | "pending"
  | "approved"
  | "restocked"
  | "reimbursed"
  | "rejected";

export const ROLE_OPTIONS: readonly Role[] = [
  "owner",
  "parent",
  "child",
  "guest",
] as const;
export const STATUS_OPTIONS: readonly Status[] = [
  "pending",
  "approved",
  "restocked",
  "reimbursed",
  "rejected",
] as const;

export const ROLE_LABELS: Record<Role, string> = {
  owner: "Owner",
  parent: "Parent",
  child: "Child",
  guest: "Guest",
};

export const STATUS_LABELS: Record<Status, string> = {
  pending: "Pending",
  approved: "Approved",
  restocked: "Restocked",
  reimbursed: "Reimbursed",
  rejected: "Rejected",
};

export const TERMINAL_STATUSES: ReadonlySet<Status> = new Set<Status>([
  "reimbursed",
  "rejected",
]);

// Anchor serializes a unit-variant enum as an object keyed by the variant name
// whose value is an empty object: `{ owner: {} }`, `{ pending: {} }`, etc.
//
// The generated Anchor TS client types a `Role` / `Status` instruction ARG as
// a discriminated union in which exactly ONE variant key maps to
// `Record<string, never>` and every other variant key is OPTIONAL and
// `undefined`. Expressing that as `Partial<Record<…>>` is too loose — it admits
// `{ owner: {}, parent: {} }`, which the union forbids — so the precise union
// is built here via a mapped helper. This is what makes
// `program.methods.addMember(wallet, roleToAnchor(role))` type-check against
// the generated `DecodeEnum<…>` arg type without a cast.
type AnchorEnumVariant<K extends string, All extends string> = {
  [P in Exclude<All, K>]?: undefined;
} & { [P in K]: Record<string, never> };

export type AnchorRole =
  | AnchorEnumVariant<"owner", Role>
  | AnchorEnumVariant<"parent", Role>
  | AnchorEnumVariant<"child", Role>
  | AnchorEnumVariant<"guest", Role>;

export type AnchorStatus =
  | AnchorEnumVariant<"pending", Status>
  | AnchorEnumVariant<"approved", Status>
  | AnchorEnumVariant<"restocked", Status>
  | AnchorEnumVariant<"reimbursed", Status>
  | AnchorEnumVariant<"rejected", Status>;

// Pre-built, frozen instances so `roleToAnchor` / `statusToAnchor` are pure
// lookups (no allocation, no computed-key cast). Each literal satisfies the
// matching union arm directly.
const ROLE_ANCHOR: Record<Role, AnchorRole> = {
  owner: { owner: {} },
  parent: { parent: {} },
  child: { child: {} },
  guest: { guest: {} },
};

const STATUS_ANCHOR: Record<Status, AnchorStatus> = {
  pending: { pending: {} },
  approved: { approved: {} },
  restocked: { restocked: {} },
  reimbursed: { reimbursed: {} },
  rejected: { rejected: {} },
};

function variantKey(value: unknown, allowed: readonly string[]): string | null {
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1 && allowed.includes(keys[0]!)) {
      return keys[0]!;
    }
  }
  return null;
}

export function roleToAnchor(role: Role): AnchorRole {
  return ROLE_ANCHOR[role];
}

/** Convert a client `Status` to its Anchor enum encoding (symmetric with
 *  {@link roleToAnchor}). Not currently an instruction arg, but provided for
 *  symmetry and future use (e.g. filtering the account namespace). */
export function statusToAnchor(status: Status): AnchorStatus {
  return STATUS_ANCHOR[status];
}

export function roleFromAnchor(value: unknown): Role | null {
  const key = variantKey(value, ROLE_OPTIONS);
  return key === null ? null : (key as Role);
}

export function statusFromAnchor(value: unknown): Status | null {
  const key = variantKey(value, STATUS_OPTIONS);
  return key === null ? null : (key as Status);
}
