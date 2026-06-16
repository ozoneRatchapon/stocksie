stocksie/programs/stocksie/src/instructions/household.rs#L1-450
//! Household-management instructions.
//!
//! Covers the membership lifecycle (Feature 3.3 — access-controlled state
//! transitions):
//!   - [`initialize_household`]    : create a household + vault + owner membership
//!   - [`add_member`]              : onboard a wallet under a role (Owner-only)
//!   - [`remove_member`]           : close a membership, reclaim rent (Owner-only)
//!   - [`set_role`]                : change a member's role (Owner-only)
//!
//! Authority model: every mutating op loads the *caller's* `Member` PDA,
//! verifies it via seeds (bound to `caller.key()` + household) and `has_one`
//! (bound to the household), then checks `role.can_manage_members()` — which
//! only `Role::Owner` satisfies. The household owner is therefore the sole
//! membership authority in the MVP.
//!
//! Re-join semantics: `remove_member` uses Anchor's `close` constraint, so the
//! `Member` PDA is fully closed (rent reclaimed, discriminator wiped). Re-adding
//! the same wallet therefore works via a fresh `init` — no `init_if_needed`
//! required (security checklist: avoid `init_if_needed`). Historical reward
//! contributions are preserved on-chain via the permanent `RewardEarned` /
//! `MemberAdded` / `MemberRemoved` events.

use crate::constants::{HOUSEHOLD_SEED, MAX_MEMBERS, MEMBER_SEED};
use crate::error::StocksieError;
use crate::events::{HouseholdCreated, MemberAdded, MemberRemoved, RoleChanged};
use crate::state::{Household, Member};
use crate::types::Role;
use anchor_lang::prelude::*;

// ===========================================================================
// initialize_household
// ===========================================================================

/// Accounts for [`initialize_household`].
///
/// Creates three things in one instruction:
///   1. The `Household` PDA — also the SOL vault (Feature 3.2).
///   2. The owner's `Member` PDA, seeded `[MEMBER_SEED, household, owner]`.
///   3. Implicitly, the vault is the same account as (1); no separate vault
///      account is needed.
#[derive(Accounts)]
pub struct InitializeHousehold<'info> {
    /// The household + vault PDA. Seeds bind it to `owner`, so one wallet can
    /// head multiple households (e.g. a parent in two families).
    #[account(
        init,
        seeds = [HOUSEHOLD_SEED, owner.key().as_ref()],
        bump,
        payer = owner,
        space = 8 + Household::INIT_SPACE,
    )]
    pub household: Account<'info, Household>,

    /// The owner's own membership record. Created up-front so the very next
    /// instruction (e.g. `deposit_funds`, `add_member`) can authenticate the
    /// owner without a second setup transaction.
    #[account(
        init,
        seeds = [MEMBER_SEED, household.key().as_ref(), owner.key().as_ref()],
        bump,
        payer = owner,
        space = 8 + Member::INIT_SPACE,
    )]
    pub owner_member: Account<'info, Member>,

    /// Wallet creating (and owning) the household. Pays rent for both PDAs.
    #[account(mut)]
    pub owner: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Handler for `initialize_household(name_hash)`.
///
/// `name_hash` is a blake3 digest of the household's off-chain display name
/// (Feature 3.5 — privacy-preserving). It is stored on-chain only for
/// tamper-evidence; the raw name never touches the ledger.
pub fn initialize_household_handler(
    ctx: Context<InitializeHousehold>,
    name_hash: [u8; 32],
) -> Result<()> {
    let clock = Clock::get()?;
    let owner = ctx.accounts.owner.key();

    // --- household (also the vault) ---
    let household = &mut ctx.accounts.household;
    household.owner = owner;
    household.name_hash = name_hash;
    household.bump = ctx.bumps.household;
    household.member_count = 1; // the owner is the first member
    household.request_counter = 0;
    household.total_rewards_distributed = 0;
    household.vault_balance = 0;
    household.created_slot = clock.slot;

    // --- owner membership ---
    let owner_member = &mut ctx.accounts.owner_member;
    owner_member.household = household.key();
    owner_member.wallet = owner;
    owner_member.role = Role::Owner;
    owner_member.reward_points = 0;
    owner_member.active = true;
    owner_member.bump = ctx.bumps.owner_member;
    owner_member.joined_slot = clock.slot;

    emit!(HouseholdCreated {
        household: household.key(),
        owner,
        name_hash,
        slot: clock.slot,
    });
    emit!(MemberAdded {
        household: household.key(),
        member: owner,
        role: Role::Owner,
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// add_member
// ===========================================================================

/// Accounts for [`add_member`].
///
/// The caller must be the household owner; this is enforced by loading the
/// caller's `Member` PDA and requiring `role.can_manage_members()` (Owner only).
#[derive(Accounts)]
#[instruction(new_member_wallet: Pubkey, role: Role)]
pub struct AddMember<'info> {
    /// Household mut because `member_count` is incremented.
    #[account(mut)]
    pub household: Account<'info, Household>,

    /// Caller's membership. Seeds bind it to `household` + `caller`; `has_one`
    /// re-verifies the back-reference. Only an active Owner may pass the
    /// `can_manage_members` gate.
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.role.can_manage_members() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

    /// The new member's PDA. Seeded by the *wallet* being added (passed as an
    /// instruction arg, not necessarily a signer). `init` ensures the wallet is
    /// not already a member (a duplicate add collides on the PDA and fails).
    #[account(
        init,
        seeds = [MEMBER_SEED, household.key().as_ref(), new_member_wallet.as_ref()],
        bump,
        payer = caller,
        space = 8 + Member::INIT_SPACE,
    )]
    pub new_member: Account<'info, Member>,

    /// Caller (Owner). Pays rent for the new `Member` PDA.
    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Handler for `add_member(new_member_wallet, role)`.
///
/// Business rules enforced here (not expressible as constraints):
///   - `role` must not be `Owner` (a household has exactly one owner).
///   - household must be under `MAX_MEMBERS`.
///   - `member_count` increments with checked arithmetic.
pub fn add_member_handler(
    ctx: Context<AddMember>,
    new_member_wallet: Pubkey,
    role: Role,
) -> Result<()> {
    // Only one Owner per household. The owner is set exclusively by
    // `initialize_household`; promotions to Owner are forbidden.
    match role {
        Role::Owner => return Err(StocksieError::CannotModifyOwner.into()),
        Role::Parent | Role::Child | Role::Guest => {}
    }

    let household = &mut ctx.accounts.household;
    if household.member_count >= MAX_MEMBERS {
        return Err(StocksieError::MemberLimitReached.into());
    }

    let clock = Clock::get()?;

    let new_member = &mut ctx.accounts.new_member;
    new_member.household = household.key();
    new_member.wallet = new_member_wallet;
    new_member.role = role;
    new_member.reward_points = 0;
    new_member.active = true;
    new_member.bump = ctx.bumps.new_member;
    new_member.joined_slot = clock.slot;

    household.member_count = household
        .member_count
        .checked_add(1)
        .ok_or(StocksieError::Overflow)?;

    emit!(MemberAdded {
        household: household.key(),
        member: new_member_wallet,
        role,
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// remove_member
// ===========================================================================

/// Accounts for [`remove_member`].
///
/// The target `Member` PDA is closed via the `close = caller` constraint: rent
/// is refunded to the owner-caller and the account data is wiped, which frees
/// the PDA for a future re-add (no `init_if_needed`).
#[derive(Accounts)]
#[instruction(member_wallet: Pubkey)]
pub struct RemoveMember<'info> {
    /// Household mut because `member_count` is decremented.
    #[account(mut)]
    pub household: Account<'info, Household>,

    /// Caller's membership (Owner-only gate, same as `add_member`).
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.role.can_manage_members() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

    /// The membership being removed. Two hard constraints:
    ///   - `wallet == member_wallet`  : the arg must match the on-chain wallet
    ///     (defense against confusing the seed-derived account).
    ///   - `role != Owner`            : the household owner is irremovable.
    #[account(
        mut,
        seeds = [MEMBER_SEED, household.key().as_ref(), member_wallet.as_ref()],
        bump,
        has_one = household,
        constraint = target_member.wallet == member_wallet @ StocksieError::MemberNotFound,
        constraint = target_member.role != Role::Owner @ StocksieError::CannotModifyOwner,
        close = caller,
    )]
    pub target_member: Account<'info, Member>,

    /// Caller (Owner). Receives the closed account's rent.
    #[account(mut)]
    pub caller: Signer<'info>,
}

/// Handler for `remove_member(member_wallet)`.
///
/// `member_count` decrement uses checked subtraction; the Owner-removal and
/// self-removal cases are blocked upstream by the accounts constraints.
pub fn remove_member_handler(
    ctx: Context<RemoveMember>,
    member_wallet: Pubkey,
) -> Result<()> {
    let household = &mut ctx.accounts.household;
    household.member_count = household
        .member_count
        .checked_sub(1)
        .ok_or(StocksieError::Overflow)?;

    let clock = Clock::get()?;
    emit!(MemberRemoved {
        household: household.key(),
        member: member_wallet,
        slot: clock.slot,
    });
    // Anchor closes `target_member` (→ caller) automatically on return.
    Ok(())
}

// ===========================================================================
// set_role
// ===========================================================================

/// Accounts for [`set_role`].
#[derive(Accounts)]
#[instruction(new_role: Role, member_wallet: Pubkey)]
pub struct SetRole<'info> {
    /// Read-only household reference. `member_count` is unaffected by a role
    /// change, so no `mut`.
    pub household: Account<'info, Household>,

    /// Caller's membership (Owner-only gate).
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), caller.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.role.can_manage_members() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

    /// Target membership. Same protections as in `remove_member`: must match the
    /// arg wallet, must not be the Owner (cannot demote the owner).
    #[account(
        mut,
        seeds = [MEMBER_SEED, household.key().as_ref(), member_wallet.as_ref()],
        bump,
        has_one = household,
        constraint = target_member.wallet == member_wallet @ StocksieError::MemberNotFound,
        constraint = target_member.role != Role::Owner @ StocksieError::CannotModifyOwner,
    )]
    pub target_member: Account<'info, Member>,

    /// Caller (Owner). Provides the seed key; no lamports move.
    pub caller: Signer<'info>,
}

/// Handler for `set_role(new_role, member_wallet)`.
///
/// Promotion to `Owner` is rejected — the only owner is the household creator.
/// All other role transitions (e.g. Child → Parent, Parent → Guest) are allowed.
pub fn set_role_handler(
    ctx: Context<SetRole>,
    new_role: Role,
    member_wallet: Pubkey,
) -> Result<()> {
    match new_role {
        Role::Owner => return Err(StocksieError::CannotModifyOwner.into()),
        Role::Parent | Role::Child | Role::Guest => {}
    }

    let target = &mut ctx.accounts.target_member;
    let old_role = target.role;
    target.role = new_role;

    let clock = Clock::get()?;
    emit!(RoleChanged {
        household: ctx.accounts.household.key(),
        member: member_wallet,
        old_role,
        new_role,
        slot: clock.slot,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sanity check that the privilege gates used by these instructions match
    /// the documented "Owner-only" policy.
    #[test]
    fn member_management_is_owner_only() {
        assert!(Role::Owner.can_manage_members());
        assert!(!Role::Parent.can_manage_members());
        assert!(!Role::Child.can_manage_members());
        assert!(!Role::Guest.can_manage_members());
    }
}
