//! Stocksie custom program errors.
//!
//! Each error maps to a specific failure in the household coordination,
//! approval, reimbursement, or reward flows. Messages are intentionally
//! explicit so the client (and family members in the UI) get a clear reason
//! for every rejected transaction.

use anchor_lang::prelude::*;

#[error_code]
pub enum StocksieError {
    // ---------------------------------------------------------------------
    // Membership & role authorization
    // ---------------------------------------------------------------------

    /// Caller is not an active member of the household.
    #[msg("Caller is not an active member of this household")]
    NotAMember,

    /// Caller's role does not permit this action.
    #[msg("Caller's role is not authorized to perform this action")]
    UnauthorizedRole,

    /// Only the household owner may perform this action.
    #[msg("Only the household owner may perform this action")]
    NotOwner,

    /// Tried to add a wallet that is already a member.
    #[msg("This wallet is already a member of the household")]
    MemberAlreadyExists,

    /// Tried to operate on a wallet that is not a member.
    #[msg("This wallet is not a member of the household")]
    MemberNotFound,

    /// Tried to operate on a member who has been deactivated.
    #[msg("This membership is inactive")]
    MemberInactive,

    /// Household member cap (`MAX_MEMBERS`) reached.
    #[msg("Household member limit reached")]
    MemberLimitReached,

    /// Cannot remove or demote the owner of the household.
    #[msg("Cannot remove or change the role of the household owner")]
    CannotModifyOwner,

    // ---------------------------------------------------------------------
    // Household invariant violations
    // ---------------------------------------------------------------------

    /// Account passed as household does not match the expected PDA.
    #[msg("Household account does not match the expected PDA")]
    HouseholdAccountMismatch,

    /// Cross-account reference does not point to the same household.
    #[msg("Account does not belong to this household")]
    HouseholdMismatch,

    // ---------------------------------------------------------------------
    // Vault / funds (Feature 2.4 & 3.2)
    // ---------------------------------------------------------------------

    /// Vault has insufficient lamports to satisfy the operation.
    #[msg("Household vault has insufficient funds")]
    InsufficientVaultFunds,

    /// Requested amount is below the minimum actionable size.
    #[msg("Amount is below the minimum request size")]
    AmountBelowMinimum,

    /// Requested amount exceeds the per-request reimbursement cap.
    #[msg("Amount exceeds the maximum reimbursement per request")]
    AmountExceedsMaximum,

    /// Deposit amount must be greater than zero.
    #[msg("Deposit amount must be greater than zero")]
    ZeroDeposit,

    /// Withdrawal amount must be greater than zero.
    #[msg("Withdrawal amount must be greater than zero")]
    ZeroWithdrawal,

    // ---------------------------------------------------------------------
    // Purchase request lifecycle (Feature 2.2 & 3.3)
    // ---------------------------------------------------------------------

    /// Purchase request is in a state that does not allow this transition.
    #[msg("Purchase request is not in the required state for this action")]
    InvalidStatusTransition,

    /// Purchase request is already in a terminal state.
    #[msg("Purchase request has already been finalized")]
    AlreadyTerminal,

    /// Only the original buyer may confirm restock for their request.
    #[msg("Only the designated buyer may confirm this restock")]
    NotBuyer,

    /// Reimbursement amount would overflow the recorded request amount.
    #[msg("Reimbursement amount exceeds the approved request amount")]
    ReimbursementExceedsApproved,

    /// Attempted to reimburse a request that has already been reimbursed.
    #[msg("Purchase request has already been reimbursed")]
    AlreadyReimbursed,

    /// Approver cannot approve their own request (separation of duties).
    #[msg("Approver cannot approve their own purchase request")]
    SelfApprovalForbidden,

    // ---------------------------------------------------------------------
    // Rewards (Feature 2.5)
    // ---------------------------------------------------------------------

    /// Reward amount must be greater than zero.
    #[msg("Reward amount must be greater than zero")]
    ZeroReward,

    /// Reward point total overflowed the u64 accumulator.
    #[msg("Reward point total overflowed")]
    RewardOverflow,

    // ---------------------------------------------------------------------
    // Numeric / arithmetic safety net
    // ---------------------------------------------------------------------

    /// Checked arithmetic overflow.
    #[msg("Arithmetic overflow")]
    Overflow,
}
