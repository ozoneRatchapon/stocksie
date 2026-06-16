//! Stocksie program instructions.
//!
//! Index-only module (per project architecture rule: `mod.rs` files declare
//! modules and re-export their public items, nothing else). The actual
//! instruction account structs and handlers live in sibling files, grouped by
//! domain:
//!   - [`initialize`]: the scaffold template handler (replaced incrementally as
//!     the real instruction set is wired into `lib.rs`).
//!   - [`household`]: the membership lifecycle — `initialize_household`,
//!     `add_member`, `remove_member`, `set_role` (Feature 3.3).
//!   - [`funds`]: the shared treasury in/out flows — `deposit_funds` (any
//!     active member, Guest included) and `withdraw_funds` (Owner-only
//!     emergency drain) against the household SOL vault (Feature 2.4 / 3.2).
//!
//! Each handler is the *only* place business rules that cannot be expressed as
//! Anchor constraints are enforced (e.g. zero-amount rejection, defense-in-depth
//! owner re-checks). Access control is expressed declaratively in the
//! `#[derive(Accounts)]` blocks via seeds + `has_one` + `Role::can_*` gates.

pub mod funds;
pub mod household;
pub mod initialize;

pub use funds::*;
pub use household::*;
pub use initialize::*;
