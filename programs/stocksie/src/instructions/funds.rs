//! Vault funds instructions — the shared treasury in/out flows.
//!
//! Covers Feature 2.4 / 3.2 (the shared household SOL vault — the `Household`
//! PDA itself):
//!   - [`deposit_funds`]  : top up the vault (any active member, Guest included)
//!   - [`withdraw_funds`] : emergency drain (Owner-only)
//!
//! Routine spending must *not* flow through `withdraw_funds` — it goes through
//! the purchase-approval + reimbursement pipeline (see `instructions/purchase.rs`
//! and `instructions/reimburse.rs`). The withdraw path exists only for winding
//! down a household or recovering mis-sent funds, which is why it is gated to
//! the household Owner and the destination is *always* that same recorded Owner
//! wallet (never an arbitrary third party). This prevents an Owner from routing
//! treasury value around the reimbursement audit trail in a single instruction.
//!
//! Authority model:
//!   - `deposit_funds`  : the depositor's `Member` PDA is loaded (seeds +
//!     `has_one`) purely so the deposit is attributable to an identity in the
//!     `FundsDeposited` event. Any active role is permitted — Guests included —
//!     because external family support (a grandparent sending diaper money) is
//!     modelled as "join as Guest, then fund".
//!   - `withdraw_funds` : the caller's `Member` PDA must pass
//!     `role.can_withdraw_funds()` (Owner only), the signer must match the
//!     household's recorded `owner` pubkey (defense-in-depth), and the drain
//!     destination is that same Owner signer.

use crate::constants::MEMBER_SEED;
use crate::error::StocksieError;
use crate::events::{FundsDeposited, FundsWithdrawn};
use crate::state::{Household, Member};
use anchor_lang::prelude::*;

// ===========================================================================
// deposit_funds
// ===========================================================================

/// Accounts for [`deposit_funds`].
///
/// The vault is the `Household` PDA itself, so it is the only account credited.
/// The depositor's `Member` PDA is required (not because Guests are barred, but
/// because every deposit must be attributable to an auditable identity in the
/// `FundsDeposited` event). `Guest` is explicitly allowed: any active role may
/// top up the vault.
#[derive(Accounts)]
pub struct DepositFunds<'info> {
    /// The household + vault PDA. Mutated because `vault_balance` is bumped and
    /// its lamport count increases via the system-program transfer.
    #[account(mut)]
    pub household: Account<'info, Household>,

    /// Depositor's membership. Seeds bind it to `household` + `depositor`;
    /// `has_one` re-verifies the back-reference. No role check here — Guests may
    /// deposit. The only hard requirement is that the membership is `active`.
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), depositor.key().as_ref()],
        bump,
        has_one = household,
        constraint = depositor_member.active @ StocksieError::MemberInactive,
    )]
    pub depositor_member: Account<'info, Member>,

    /// Wallet funding the vault. Source of the system-program transfer.
    #[account(mut)]
    pub depositor: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// Handler for `deposit_funds(lamports)`.
///
/// Business rules enforced here (not expressible as constraints):
///   - `lamports` must be `> 0` (`ZeroDeposit`).
///   - All SOL movement + `vault_balance` accounting is delegated to
///     [`Household::credit_vault`], which performs the system-program `transfer`
///     CPI and a checked `vault_balance += lamports`.
///
/// Emits [`FundsDeposited`] with the post-credit `vault_balance` snapshot so the
/// audit trail can be reconciled against on-chain lamport diffs.
pub fn deposit_funds_handler(ctx: Context<DepositFunds>, lamports: u64) -> Result<()> {
    if lamports == 0 {
        return Err(StocksieError::ZeroDeposit.into());
    }

    // Extract the vault AccountInfo first so the `&mut self` borrow taken by
    // `credit_vault` does not alias an inline `to_account_info()` call. The
    // AccountInfo holds an `Rc<RefCell<…>>` into the account's lamports — no
    // compile-time borrow is held across the call.
    let vault_info = ctx.accounts.household.to_account_info();
    ctx.accounts.household.credit_vault(
        ctx.accounts.depositor.to_account_info(),
        vault_info,
        ctx.accounts.system_program.to_account_info(),
        lamports,
    )?;

    let clock = Clock::get()?;
    emit!(FundsDeposited {
        household: ctx.accounts.household.key(),
        depositor: ctx.accounts.depositor.key(),
        lamports,
        vault_balance: ctx.accounts.household.vault_balance,
        slot: clock.slot,
    });
    Ok(())
}

// ===========================================================================
// withdraw_funds
// ===========================================================================

/// Accounts for [`withdraw_funds`].
///
/// Emergency drain, Owner-only. The destination is *fixed* to the household's
/// recorded Owner signer — there is no arbitrary `to` field, so an Owner cannot
/// route treasury value to a third party in a single instruction (that must go
/// through `reimburse_buyer` against an approved purchase request).
///
/// The `caller_member` PDA is seeded by the `owner` signer, so its very
/// existence proves the signer's wallet is a member of this household; the
/// `role.can_withdraw_funds()` constraint then restricts it to the Owner role.
/// The handler additionally re-checks `household.owner == owner.key()` as
/// defense-in-depth.
#[derive(Accounts)]
pub struct WithdrawFunds<'info> {
    /// The household + vault PDA. Mutated because lamports leave the vault and
    /// `vault_balance` is decremented.
    #[account(mut)]
    pub household: Account<'info, Household>,

    /// Caller's membership — the Owner gate. Seeds bind it to `household` +
    /// `owner` (the signer), `has_one` re-verifies the back-reference, `active`
    /// blocks deactivated members, and `can_withdraw_funds()` restricts the
    /// role to `Owner`.
    #[account(
        seeds = [MEMBER_SEED, household.key().as_ref(), owner.key().as_ref()],
        bump,
        has_one = household,
        constraint = caller_member.active @ StocksieError::MemberInactive,
        constraint = caller_member.role.can_withdraw_funds() @ StocksieError::UnauthorizedRole,
    )]
    pub caller_member: Account<'info, Member>,

    /// Owner wallet — both the authorizing signer and the drain destination.
    /// `mut` because it receives the withdrawn lamports.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Reserved for symmetry with `DepositFunds` and for future refinements
    /// (e.g. switching to a signed system-program transfer). `debit_vault` uses
    /// a direct lamport move because a program-owned PDA cannot be a
    /// system-program signer.
    pub system_program: Program<'info, System>,
}

/// Handler for `withdraw_funds(lamports)`.
///
/// Business rules enforced here (not expressible as constraints):
///   - `lamports` must be `> 0` (`ZeroWithdrawal`). [`Household::debit_vault`]
///     re-checks this, but failing early keeps the error unambiguous before any
///     account mutation.
///   - `household.owner == owner.key()` (`NotOwner`). Defense-in-depth: the
///     `caller_member` seed + role gate already guarantee this on the legitimate
///     path; this guard blocks any future code path that could route treasury
///     funds to a non-owner.
///
/// Emits [`FundsWithdrawn`] with the post-debit `vault_balance` snapshot.
pub fn withdraw_funds_handler(ctx: Context<WithdrawFunds>, lamports: u64) -> Result<()> {
    if lamports == 0 {
        return Err(StocksieError::ZeroWithdrawal.into());
    }

    // Defense-in-depth: the drain destination must be the household's recorded
    // owner. The `caller_member` seed (bound to `owner`) plus the Owner role
    // gate make this invariant on the happy path; this explicit check is the
    // belt to those suspenders.
    if ctx.accounts.household.owner != ctx.accounts.owner.key() {
        return Err(StocksieError::NotOwner.into());
    }

    // `debit_vault` performs a direct lamport move (PDA-owned vault → `to`)
    // and a checked `vault_balance -= lamports`. It re-checks zero and
    // sufficiency internally, so by this point the call cannot fail spuriously.
    let vault_info = ctx.accounts.household.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();
    ctx.accounts
        .household
        .debit_vault(&vault_info, &owner_info, lamports)?;

    let clock = Clock::get()?;
    emit!(FundsWithdrawn {
        household: ctx.accounts.household.key(),
        owner: ctx.accounts.owner.key(),
        lamports,
        vault_balance: ctx.accounts.household.vault_balance,
        slot: clock.slot,
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::types::Role;

    /// The withdraw gate is the only funds privilege that is expressible as a
    /// pure role predicate, so it is unit-tested here. The deposit policy
    /// ("any active role, Guest included") lives in the `#[derive(Accounts)]`
    /// constraint block and is exercised by the LiteSVM suite in Phase 7/8 — it
    /// cannot be meaningfully asserted at the unit level.
    #[test]
    fn withdraw_gate_is_owner_only() {
        assert!(Role::Owner.can_withdraw_funds());
        assert!(!Role::Parent.can_withdraw_funds());
        assert!(!Role::Child.can_withdraw_funds());
        assert!(!Role::Guest.can_withdraw_funds());
    }
}
