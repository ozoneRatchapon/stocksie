// Stocksie shared types — client-side mirrors of the on-chain `Role` and
// `Status` enums (`programs/stocksie/src/types.rs`) plus converters for the
// Anchor enum serialization format (`{ variant: {} }`).

export type Role = 'owner' | 'parent' | 'child' | 'guest';
export type Status = 'pending' | 'approved' | 'restocked' | 'reimbursed' | 'rejected';

export const ROLE_OPTIONS: readonly Role[] = ['owner', 'parent', 'child', 'guest'] as const;
export const STATUS_OPTIONS: readonly Status[] = [
  'pending',
  'approved',
  'restocked',
  'reimbursed',
  'rejected',
] as const;

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  parent: 'Parent',
  child: 'Child',
  guest: 'Guest',
};

export const STATUS_LABELS: Record<Status, string> = {
  pending: 'Pending',
  approved: 'Approved',
  restocked: 'Restocked',
  reimbursed: 'Reimbursed',
  rejected: 'Rejected',
};

export const TERMINAL_STATUSES: ReadonlySet<Status> = new Set<Status>(['reimbursed', 'rejected']);

// Anchor serializes a unit-variant enum as an object keyed by the variant name
// whose value is an empty object: `{ owner: {} }`, `{ pending: {} }`, etc.
export type AnchorRole = Partial<Record<Role, Record<string, never>>>;
export type AnchorStatus = Partial<Record<Status, Record<string, never>>>;

function variantKey(value: unknown, allowed: readonly string[]): string | null {
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1 && allowed.includes(keys[0]!)) {
      return keys[0]!;
    }
  }
  return null;
}

export function roleToAnchor(role: Role): AnchorRole {
  return { [role]: {} } as AnchorRole;
}

export function roleFromAnchor(value: unknown): Role | null {
  const key = variantKey(value, ROLE_OPTIONS);
  return key === null ? null : (key as Role);
}

export function statusFromAnchor(value: unknown): Status | null {
  const key = variantKey(value, STATUS_OPTIONS);
  return key === null ? null : (key as Status);
}
