//! `Household` — the central account of a Stocksie family.
//!
//! One PDA per household, derived as `[HOUSEHOLD_SEED, owner]`. The same PDA
//! *is* the shared treasury vault (Feature 3.2): it holds SOL lamports directly
//! and signs reimbursements out to buyers via `invoke_signed`. Keeping the
//! state and the vault at one address means there is exactly one rent-exempt
//! account to fund per family, and vault solvency is trivially auditable by
//! reading a single account's lamports.
//!
//! Privacy (Feature 3.5): only `name_hash` (blake3 of the display name) is
//! stored. No member roster is kept on-chain — membership is tracked by
//! per-wallet `Member` PDAs so the chain never learns who belongs to which
//! family except by reading individual member accounts.

use crate::constants::{HASH_LEN, HOUSEHOLD_SEED};
use crate::error::StocksieError;
use anchor_lang::prelude::*;

/// Seed-derived family account. Also the program-controlled SOL vault.
///
/// Seeds: `[HOUSEHOLD_SEED, owner.key()]`
/// Space : 8 (discriminator) + `Household::INIT_SPACE`
#[account]
#[derive(InitSpace)]
pub struct Household {
    /// Wallet that owns the household. The owner role is non-transferable in
    /// the MVP (a new owner means a new household PDA), which keeps the seed
    /// stable for the lifetime of the account.
    pub owner: Pubkey,

    /// blake3 hash of the household's display name. Privacy reference only —
    /// the raw name lives off-chain. Used for tamper-evidence, not recovery.
    pub name_hash: [u8; HASH_LEN],

    /// Canonical bump for this PDA, stored once at init so later CPI signing
    /// avoids the `find_program_address` loop (security checklist: bump
    /// canonicalization).
    pub bump: u8,

    /// Count of *active* members. Bounded by `MAX_MEMBERS`. Decremented on
    /// soft-remove. The owner always counts as 1.
    pub member_count: u32,

    /// Monotonic counter used to seed each `PurchaseRequest` PDA. Incremented
    /// on every `create_purchase_request`. Starts at 0; first request id is 1.
    pub request_counter: u64,

    /// Cumulative reward points ever distributed by this household. Increases
    /// only via `award_reward` / purchase-lifecycle rewards. Never decreases.
    pub total_rewards_distributed: u64,

    /// Running mirror of the vault's lamport balance. The *source of truth*
    /// for actual SOL is the account's `lamports()`; this field is a
    /// convenience mirror kept in sync so events and the client can show a
    /// balance without a second read. Checked-math verified on every mutation.
    pub vault_balance: u64,

    /// Slot at creation. Auditable ordering for the household lifecycle.
    pub created_slot: u64,
}

impl Household {
    /// Seeds helper used both at `init` (constraint) and at CPI signing time.
    /// Returns the seed slices plus a slot for the bump.
    pub fn seeds<'a>(owner: &'a Pubkey, bump: &'a [u8]) -> [&'a [u8]; 3] {
        [HOUSEHOLD_SEED, owner.as_ref(), bump]
    }

    /// Signer seeds for CPI calls made *by* the household vault (e.g. the SOL
    /// transfer to a buyer during reimbursement). Caller already holds the
    /// stored canonical `bump`.
    pub fn signer_seeds<'a>(&'a self, owner: &'a Pubkey) -> [&'a [u8]; 3] {
        // `std::slice::from_ref` borrows `self.bump` (part of `&'a self`) for
        // lifetime `'a`, producing a one-element `&'a [u8]`. The naive
        // `&[self.bump]` would create a temporary array and return a dangling
        // reference to it (E0515).
        [
            HOUSEHOLD_SEED,
            owner.as_ref(),
            std::slice::from_ref(&self.bump),
        ]
    }

    /// Credit lamports into the vault from an external `from` account and
    /// bump the mirror. Used by `deposit_funds`.
    ///
    /// Uses the system program's transfer CPI rather than raw lamport moves so
    /// the source account is properly debited under the runtime's ownership
    /// rules (`from` must be a system-owned signer).
    pub fn credit_vault<'info>(
        &mut self,
        from: AccountInfo<'info>,
        vault: AccountInfo<'info>,
        system_program: AccountInfo<'info>,
        lamports: u64,
    ) -> Result<()> {
        anchor_lang::system_program::transfer(
            CpiContext::new(
                system_program.key(),
                anchor_lang::system_program::Transfer { from, to: vault },
            ),
            lamports,
        )?;
        self.vault_balance = self
            .vault_balance
            .checked_add(lamports)
            .ok_or(StocksieError::Overflow)?;
        Ok(())
    }

    /// Debit lamports from the vault to a `to` account, signed by the household
    /// PDA. Used by `reimburse_buyer` and `withdraw_funds`.
    ///
    /// Because the vault is a PDA owned by our program, we move lamports
    /// directly (the canonical pattern for program-owned SOL vaults) rather
    /// than issuing a system `transfer` (which would require the vault to be a
    /// system-owned signer, which a PDA cannot be).
    pub fn debit_vault(
        &mut self,
        vault: &AccountInfo<'_>,
        to: &AccountInfo<'_>,
        lamports: u64,
    ) -> Result<()> {
        if lamports > self.vault_balance {
            return Err(StocksieError::InsufficientVaultFunds.into());
        }
        if lamports == 0 {
            return Err(StocksieError::ZeroWithdrawal.into());
        }

        // Defensive: never allow the vault and destination to alias.
        // (Security checklist: duplicate mutable accounts can corrupt state.)
        if vault.key() == to.key() {
            return Err(StocksieError::HouseholdAccountMismatch.into());
        }

        // Program-owned PDA vault → arbitrary destination. Direct lamport move
        // is the canonical pattern for a program-owned SOL vault: a PDA cannot
        // be a system-program signer, so `system_program::transfer` is not an
        // option here. Debit the source first, credit the destination second;
        // both `RefMut<&mut u64>` borrows resolve cleanly because the accounts
        // are guaranteed distinct by the alias check above.
        **vault.try_borrow_mut_lamports()? = vault
            .lamports()
            .checked_sub(lamports)
            .ok_or(StocksieError::Overflow)?;
        **to.try_borrow_mut_lamports()? = to
            .lamports()
            .checked_add(lamports)
            .ok_or(StocksieError::Overflow)?;

        self.vault_balance = self
            .vault_balance
            .checked_sub(lamports)
            .ok_or(StocksieError::Overflow)?;
        Ok(())
    }

    /// Increment the request counter and return the *new* id to use for the
    /// pending `PurchaseRequest`. Counter is 0 at init, so the first issued id
    /// is 1 (0 is reserved as "no request yet" sentinel in clients).
    pub fn next_request_id(&mut self) -> Result<u64> {
        self.request_counter = self
            .request_counter
            .checked_add(1)
            .ok_or(StocksieError::Overflow)?;
        Ok(self.request_counter)
    }

    /// Bump `total_rewards_distributed` by `points`. Used by every reward path
    /// so the household's lifetime payout figure is consistent across events.
    pub fn record_rewards(&mut self, points: u64) -> Result<()> {
        self.total_rewards_distributed = self
            .total_rewards_distributed
            .checked_add(points)
            .ok_or(StocksieError::RewardOverflow)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_household() -> Household {
        Household {
            owner: Pubkey::new_unique(),
            name_hash: [0u8; HASH_LEN],
            bump: 254,
            member_count: 1,
            request_counter: 0,
            total_rewards_distributed: 0,
            vault_balance: 0,
            created_slot: 0,
        }
    }

    #[test]
    fn next_request_id_is_monotonic_starting_at_one() {
        let mut h = fake_household();
        assert_eq!(h.next_request_id().unwrap(), 1);
        assert_eq!(h.next_request_id().unwrap(), 2);
        assert_eq!(h.next_request_id().unwrap(), 3);
        assert_eq!(h.request_counter, 3);
    }

    #[test]
    fn record_rewards_accumulates() {
        let mut h = fake_household();
        h.record_rewards(10).unwrap();
        h.record_rewards(25).unwrap();
        assert_eq!(h.total_rewards_distributed, 35);
    }
}
