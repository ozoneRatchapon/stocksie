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

declare_id!("At2vd5Mqd9xcHRFAZin1VHb6upEsF1GCXoFG19UHsQoj");

#[program]
pub mod stocksie {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }
}
