//! Stocksie shared types — role and status enums with permission helpers.
//!
//! Decoupled from account state (per project architecture rule: types.rs holds
//! decoupled structs/enums) so they can be reused across instructions, events,
//! and tests without circular module dependencies. All helpers use `match`
//! (no early-return chains) per project style.

use anchor_lang::prelude::*;

/// Household member role. Stored on the `Member` PDA and checked at every
/// access-controlled instruction.
///
/// Ordering is intentional: privilege decreases as the discriminant grows,
/// which keeps "at least Parent" style checks readable.
#[derive(
    Copy,
    Clone,
    Debug,
    PartialEq,
    Eq,
    AnchorSerialize,
    AnchorDeserialize,
    InitSpace,
)]
pub enum Role {
    /// Full control: create household, manage members, approve/reject spending,
    /// reimburse buyers, withdraw vault funds, award arbitrary points.
    Owner,
    /// Approval authority: approve/reject purchase requests, reimburse buyers,
    /// award points. Cannot manage membership or drain the vault.
    Parent,
    /// Contributor: submit purchase requests, confirm restocks, earn rewards.
    /// Cannot approve or reimburse.
    Child,
    /// Read-only observer: may view the shared shopping list but cannot
    /// transact against the household treasury. Useful for guests / extended
    /// family members.
    Guest,
}

impl Role {
    /// Can this role approve or reject a purchase request?
    /// Only `Owner` and `Parent` are approvers (Feature 3.3 — access control).
    pub fn can_approve(self) -> bool {
        match self {
            Role::Owner | Role::Parent => true,
            Role::Child | Role::Guest => false,
        }
    }

    /// Can this role submit a purchase request or confirm a restock?
    /// `Owner`, `Parent`, and `Child` may transact; `Guest` is view-only.
    pub fn can_transact(self) -> bool {
        match self {
            Role::Owner | Role::Parent | Role::Child => true,
            Role::Guest => false,
        }
    }

    /// Can this role manage membership (add/remove members, change roles)?
    /// Only the `Owner`. Gates `add_member`, `remove_member`, `set_role`.
    pub fn can_manage_members(self) -> bool {
        matches!(self, Role::Owner)
    }

    /// Can this role manually award reward points to a member?
    /// `Owner` and `Parent` are reward authorities (Feature 2.5).
    pub fn can_award_rewards(self) -> bool {
        match self {
            Role::Owner | Role::Parent => true,
            Role::Child | Role::Guest => false,
        }
    }

    /// Can this role withdraw funds directly from the household vault?
    /// Only the `Owner`. Parents must go through the approval + reimbursement
    /// flow to spend treasury funds (Feature 2.4 / 3.2).
    pub fn can_withdraw_funds(self) -> bool {
        matches!(self, Role::Owner)
    }
}

/// Lifecycle state of a `PurchaseRequest`. Transitions are strictly enforced
/// by the program (see `instructions/purchase.rs`).
///
/// ```text
/// Pending ──approve──▶ Approved ──confirm_restock──▶ Restocked ──reimburse──▶ Reimbursed
///    │                     │
///    └──────reject─────────┴──▶ Rejected   (terminal)
///                                         Reimbursed (terminal)
/// ```
#[derive(
    Copy,
    Clone,
    Debug,
    PartialEq,
    Eq,
    AnchorSerialize,
    AnchorDeserialize,
    InitSpace,
)]
pub enum Status {
    /// Just created by a member; awaiting an approver's review.
    Pending,
    /// An approver (Owner/Parent) authorized the spend. Buyer may now shop.
    Approved,
    /// Buyer confirmed the item is restocked. Ready for reimbursement.
    Restocked,
    /// Vault has paid the buyer back. Terminal state.
    Reimbursed,
    /// An approver declined the spend. Terminal state.
    Rejected,
}

impl Status {
    /// Is this a terminal state? No further transitions are allowed once true.
    /// Used to guard against double-reimbursement and resurrection of closed
    /// requests (security checklist item: state lifecycle invariants).
    pub fn is_terminal(self) -> bool {
        match self {
            Status::Reimbursed | Status::Rejected => true,
            Status::Pending | Status::Approved | Status::Restocked => false,
        }
    }

    /// Human-readable label for emit/logging. Kept off-chain-friendly; the
    /// on-chain event never carries inventory detail, only this label.
    pub fn label(self) -> &'static str {
        match self {
            Status::Pending => "pending",
            Status::Approved => "approved",
            Status::Restocked => "restocked",
            Status::Reimbursed => "reimbursed",
            Status::Rejected => "rejected",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_permissions_are_sensible() {
        assert!(Role::Owner.can_approve());
        assert!(Role::Parent.can_approve());
        assert!(!Role::Child.can_approve());
        assert!(!Role::Guest.can_approve());

        assert!(Role::Owner.can_transact());
        assert!(Role::Child.can_transact());
        assert!(!Role::Guest.can_transact());

        assert!(Role::Owner.can_manage_members());
        assert!(!Role::Parent.can_manage_members());

        assert!(Role::Parent.can_award_rewards());
        assert!(!Role::Child.can_award_rewards());

        assert!(Role::Owner.can_withdraw_funds());
        assert!(!Role::Parent.can_withdraw_funds());
    }

    #[test]
    fn status_terminal_and_labels() {
        assert!(!Status::Pending.is_terminal());
        assert!(!Status::Approved.is_terminal());
        assert!(!Status::Restocked.is_terminal());
        assert!(Status::Reimbursed.is_terminal());
        assert!(Status::Rejected.is_terminal());

        assert_eq!(Status::Approved.label(), "approved");
        assert_eq!(Status::Reimbursed.label(), "reimbursed");
    }
}
