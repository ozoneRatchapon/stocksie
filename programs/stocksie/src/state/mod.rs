//! Stocksie on-chain state.
//!
//! Index-only module (per project architecture rule: `mod.rs` files declare
//! modules and re-export their public items, nothing else). The actual account
//! structs and their domain logic live in sibling files.
//!
//! Account model:
//!   - [`Household`]: family PDA + shared treasury vault (SOL lamports).
//!   - [`Member`]: per-wallet membership record with role + reward points.
//!   - [`PurchaseRequest`]: shared shopping-list entry with a strict lifecycle.

pub mod household;
pub mod member;
pub mod purchase_request;

pub use household::Household;
pub use member::Member;
pub use purchase_request::PurchaseRequest;
