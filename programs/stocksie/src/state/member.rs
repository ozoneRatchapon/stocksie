//! `Member` — a wallet's membership in a household.
//!
//! One PDA per (household, wallet) pair, derived as
//! `[MEMBER_SEED, household, wallet]`. The membership record is the on-chain
//! root of every access-control check: each instruction loads the caller's
//! `Member` account, reads its `role`, and asks `Role::can_*()` whether the
//! action is permitted (Feature 3.3 — access-controlled state transitions).
//!
//! Soft delete: `remove_member` flips `active = false` rather than closing the
//! account, so a member's historical reward contributions and purchase history
//! remain auditable on-chain. Re-adding the same wallet re-activates the
//! existing PDA (idempotent rejoin).
//!
//! Privacy (Feature 3.5): no PII is stored. `wallet` is a pubkey; everything
//! else (display name, avatar, age, etc.) lives off-chain.

use crate::constants::MEMBER_SEED;
use crate::error::StocksieError;
use crate::types::Role;
use anchor_lang::prelude::*;

/// Seed-derived membership record.
///
/// Seeds: `[MEMBER_SEED, household.key(), wallet.key()]`
/// Space : 8 (discriminator) + `Member::INIT_SPACE`
#[account]
#[derive(InitSpace)]
pub struct Member {
    /// Household this membership belongs to. Back-reference used by every
    /// cross-account constraint so a `Member` from family A can never be used
    /// to authorize an action in family B (security: data-matching checks).
    pub household: Pubkey,

    /// The wallet that holds this membership. Must sign any transaction that
    /// transacts on behalf of the member.
    pub wallet: Pubkey,

    /// Privilege level. Drives every `Role::can_*()` gate. Owner is only ever
    /// assigned to the household creator at `initialize_household`.
    pub role: Role,

    /// Cumulative reward points earned by this member (Feature 2.5). Only ever
    /// incremented via `add_reward`; never decremented in the MVP.
    pub reward_points: u64,

    /// Soft-delete flag. `false` after `remove_member`. Inactive members fail
    /// every transact/approve gate even if their `role` would otherwise allow
    /// it — the role is preserved so re-activation restores prior privileges.
    pub active: bool,

    /// Canonical bump for this PDA, stored at init.
    pub bump: u8,

    /// Slot the membership was created. Auditable ordering.
    pub joined_slot: u64,
}

impl Member {
    /// Seeds helper used both at `init` (constraint) and for re-derivation in
    /// instructions that need to verify membership off the accounts struct.
    pub fn seeds<'a>(household: &'a Pubkey, wallet: &'a Pubkey, bump: &'a [u8]) -> [&'a [u8]; 4] {
        [MEMBER_SEED, household.as_ref(), wallet.as_ref(), bump]
    }

    /// Credit `points` reward points to this member with checked arithmetic.
    ///
    /// Called from every reward path: low-stock report, restock completion,
    /// cost-saving bonus, full-run completion, and the manual `award_reward`
    /// instruction. Centralizing the add keeps the overflow guard in one place
    /// (security checklist: checked math on every accumulator).
    pub fn add_reward(&mut self, points: u64) -> Result<()> {
        if points == 0 {
            return Err(StocksieError::ZeroReward.into());
        }
        self.reward_points = self
            .reward_points
            .checked_add(points)
            .ok_or(StocksieError::RewardOverflow)?;
        Ok(())
    }

    /// Soft-deactivate this membership. Preserves `role` and `reward_points`
    /// so the audit trail and any future re-activation are consistent.
    pub fn deactivate(&mut self) {
        self.active = false;
    }

    /// Re-activate a previously deactivated membership (idempotent if active).
    pub fn reactivate(&mut self) {
        self.active = true;
    }

    /// Convenience: is this member currently allowed to transact? Combines the
    /// soft-delete flag with the role-based gate so instruction handlers have a
    /// single call site for the "can this wallet act" decision.
    pub fn can_transact(&self) -> bool {
        match self.active {
            false => false,
            true => self.role.can_transact(),
        }
    }

    /// Convenience: is this member currently an approver? Combines the
    /// soft-delete flag with the role-based gate.
    pub fn can_approve(&self) -> bool {
        match self.active {
            false => false,
            true => self.role.can_approve(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_member(role: Role, active: bool) -> Member {
        Member {
            household: Pubkey::new_unique(),
            wallet: Pubkey::new_unique(),
            role,
            reward_points: 0,
            active,
            bump: 253,
            joined_slot: 0,
        }
    }

    #[test]
    fn add_reward_accumulates_and_rejects_zero() {
        let mut m = fake_member(Role::Child, true);
        m.add_reward(10).unwrap();
        m.add_reward(25).unwrap();
        assert_eq!(m.reward_points, 35);

        let err = m.add_reward(0).unwrap_err();
        assert_eq!(err, StocksieError::ZeroReward.into());
    }

    #[test]
    fn inactive_members_cannot_transact_or_approve_regardless_of_role() {
        let inactive_parent = fake_member(Role::Parent, false);
        assert!(!inactive_parent.can_transact());
        assert!(!inactive_parent.can_approve());

        let active_child = fake_member(Role::Child, true);
        assert!(active_child.can_transact());
        assert!(!active_child.can_approve());
    }

    #[test]
    fn deactivate_then_reactivate_round_trip() {
        let mut m = fake_member(Role::Parent, true);
        assert!(m.can_approve());
        m.deactivate();
        assert!(!m.can_approve());
        assert_eq!(m.role, Role::Parent); // role preserved
        m.reactivate();
        assert!(m.can_approve());
    }
}
