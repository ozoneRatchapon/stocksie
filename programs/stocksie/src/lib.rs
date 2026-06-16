// Clippy's `diverging_sub_expression` lint is tripped by code the `#[program]`
// macro emits for *every* instruction argument: a dead `if false { let _: Ty =
// panic!(); validate(&_) }` block whose only purpose is compile-time arg-type
// validation (see `anchor-syn-1.0.2/src/codegen/program/handlers.rs`). Anchor
// itself scopes `#[allow(unreachable_code)]` over that block but does not add
// the clippy equivalent, so we suppress it here at the crate root — the only
// placement that reliably governs lints attributed to macro expansions. It is
// never-executed scaffolding (the template `initialize` had no args, so the
// lint only appeared once the 14 real instructions were wired in).
#![allow(clippy::diverging_sub_expression)]

pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod state;
pub mod types;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::{Household, Member, PurchaseRequest};
pub use types::*;

declare_id!("At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj");

#[program]
pub mod stocksie {
    use super::*;

    // ----- Household lifecycle (Feature 3.3) -----

    pub fn initialize_household(
        ctx: Context<InitializeHousehold>,
        name_hash: [u8; 32],
    ) -> Result<()> {
        household::initialize_household_handler(ctx, name_hash)
    }

    pub fn add_member(
        ctx: Context<AddMember>,
        new_member_wallet: Pubkey,
        role: Role,
    ) -> Result<()> {
        household::add_member_handler(ctx, new_member_wallet, role)
    }

    pub fn remove_member(ctx: Context<RemoveMember>, member_wallet: Pubkey) -> Result<()> {
        household::remove_member_handler(ctx, member_wallet)
    }

    pub fn set_role(
        ctx: Context<SetRole>,
        new_role: Role,
        member_wallet: Pubkey,
    ) -> Result<()> {
        household::set_role_handler(ctx, new_role, member_wallet)
    }

    // ----- Vault / funds (Feature 2.4 / 3.2) -----

    pub fn deposit_funds(ctx: Context<DepositFunds>, lamports: u64) -> Result<()> {
        funds::deposit_funds_handler(ctx, lamports)
    }

    pub fn withdraw_funds(ctx: Context<WithdrawFunds>, lamports: u64) -> Result<()> {
        funds::withdraw_funds_handler(ctx, lamports)
    }

    // ----- Purchase request lifecycle (Feature 2.1, 2.2, 3.3) -----

    pub fn create_purchase_request(
        ctx: Context<CreatePurchaseRequest>,
        amount_lamports: u64,
        item_hash: [u8; 32],
        unit_cost_hash: [u8; 32],
        buyer: Pubkey,
    ) -> Result<()> {
        purchase::create_purchase_request_handler(
            ctx,
            amount_lamports,
            item_hash,
            unit_cost_hash,
            buyer,
        )
    }

    pub fn approve_purchase_request(ctx: Context<ApprovePurchaseRequest>) -> Result<()> {
        purchase::approve_purchase_request_handler(ctx)
    }

    pub fn reject_purchase_request(
        ctx: Context<RejectPurchaseRequest>,
        reason_hash: [u8; 32],
    ) -> Result<()> {
        purchase::reject_purchase_request_handler(ctx, reason_hash)
    }

    pub fn confirm_restock(
        ctx: Context<ConfirmRestock>,
        unit_cost_hash: [u8; 32],
    ) -> Result<()> {
        purchase::confirm_restock_handler(ctx, unit_cost_hash)
    }

    pub fn close_purchase_request(ctx: Context<ClosePurchaseRequest>) -> Result<()> {
        purchase::close_purchase_request_handler(ctx)
    }

    // ----- Reimbursement (Feature 2.2, 2.4, 3.2, 3.4) -----

    pub fn reimburse_buyer(ctx: Context<ReimburseBuyer>, lamports: u64) -> Result<()> {
        reimburse::reimburse_buyer_handler(ctx, lamports)
    }

    // ----- Rewards (Feature 2.5) -----

    pub fn award_reward(
        ctx: Context<AwardReward>,
        member_wallet: Pubkey,
        points: u64,
        reason_hash: [u8; 32],
    ) -> Result<()> {
        rewards::award_reward_handler(ctx, member_wallet, points, reason_hash)
    }

    pub fn reward_summary(ctx: Context<RewardSummary>) -> Result<()> {
        rewards::reward_summary_handler(ctx)
    }
}
